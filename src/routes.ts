import { Actor } from 'apify';
import { createPlaywrightRouter } from 'crawlee';
import fs from 'fs';
import { extractListingUrls, extractListingDetails } from './extractors.js';
import { LABELS } from './constants.js';
import { chargeOrAbort } from './utils/charging.js';


export const router = createPlaywrightRouter();

export interface StartPageOptions {
    maxListings: number;
}

// Global counter for scraped listings (shared across all requests)
// Global counter for scraped listings found/queued (shared across all requests)
let totalScrapedCount = 0;
// Global counter for successfully pushed listings
let totalPushedCount = 0;
// Global set for deduplication
const scrapedListingIds = new Set<string>();

router.addHandler(LABELS.SEARCH, async ({ page, request, crawler, pushData, session }) => {
    const {
        maxListings,
        simpleMode,
        addOnImages,
        addOnReviews,
        addOnDetails,
        addOnHostDetails,
        currency,
        globalMinPrice,
        globalMaxPrice
    } = request.userData;

    // Determine if we need to visit detail pages
    // ANY add-on requires visiting the detail page to extract data
    const needsDeepScrape = !simpleMode || addOnImages || addOnReviews || addOnDetails || addOnHostDetails;

    // Handle Infinity serialization: Infinity becomes null when passed through request queue
    // Treat null, undefined, or non-positive numbers as unlimited
    const effectiveMaxListings = (maxListings && maxListings > 0) ? maxListings : Infinity;

    // Early exit if we've already reached maxListings
    if (totalScrapedCount >= effectiveMaxListings) {

        return;
    }

    const query = request.url.match(/\/s\/([^\/]+)/)?.[1] || 'Unknown';
    const decodedQuery = decodeURIComponent(query);
    console.log(`[SEARCH] Searching "${decodedQuery}" | Progress: ${totalScrapedCount}/${effectiveMaxListings === Infinity ? '∞' : effectiveMaxListings}`);


    // Fast wait for listings to appear
    try {
        await page.waitForSelector('a[href^="/rooms/"]', { timeout: 30000 });
    } catch (e) {


        const content = await page.content();
        if (content.includes('Access Denied') || content.includes('Security Check') || content.includes('Press and hold')) {
            console.warn('[SEARCH] Access blocked — rotating session.');
            session?.retire();
            throw new Error('[SEARCH] Blocked by Airbnb (Access Denied). Retrying with new session...');
        }

        // No explicit block detected - will try extraction anyway

    }

    // Scroll to bottom to ensure pagination loads
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    });

    // Brief wait for lazy load content (Reduced to speed up)
    await page.waitForTimeout(300);

    const { listings, totalCount, duplicateCount } = await extractListingUrls(page, request.userData.currency);

    console.log(`[SEARCH] Found ${listings.length} listings on page (Duplicates dropped: ${duplicateCount})`);

    // CHARGE for duplicates as per user request (Monetization improvement)
    if (duplicateCount > 0) {
        // Charge 'listing-scraped' event for each duplicate found
        // Using strict chargeOrAbort to fails if credits run out
        await chargeOrAbort('listing-scraped', duplicateCount);
    }

    // --- SEARCH SHARDING (Dynamic Splitting) ---
    // If totalCount is high (>= 1000), Airbnb will truncate results.
    // We split the current price range [minPrice, maxPrice] into two halves.
    const currentMinPrice = request.userData.minPrice ?? 0;
    const currentMaxPrice = request.userData.maxPrice ?? 1000000;
    // Limit splitting depth to avoid infinite loops if totalCount is buggy
    const splitDepth = request.userData.splitDepth || 0;

    // Only do dynamic splitting if not already pre-sharded with small ranges
    const priceRange = currentMaxPrice - currentMinPrice;
    const shouldDynamicSplit = totalCount >= 1000 && splitDepth < 10 && priceRange > 10;

    if (shouldDynamicSplit) {

        const midPrice = Math.floor((currentMinPrice + currentMaxPrice) / 2);

        const shard1 = { ...request.userData, minPrice: currentMinPrice, maxPrice: midPrice, splitDepth: splitDepth + 1 };
        const shard2 = { ...request.userData, minPrice: midPrice + 1, maxPrice: currentMaxPrice, splitDepth: splitDepth + 1 };

        const url1 = new URL(request.url);
        url1.searchParams.set('price_min', shard1.minPrice.toString());
        url1.searchParams.set('price_max', shard1.maxPrice.toString());
        if (request.userData.currency) url1.searchParams.set('currency', request.userData.currency);
        url1.searchParams.set('price_filter_input_type', '2');
        url1.searchParams.set('price_filter_num_nights', '1');
        url1.searchParams.set('search_type', 'filter_change');
        url1.searchParams.delete('cursor'); // Clear cursor for new shard

        const url2 = new URL(request.url);
        url2.searchParams.set('price_min', shard2.minPrice.toString());
        url2.searchParams.set('price_max', shard2.maxPrice.toString());
        if (request.userData.currency) url2.searchParams.set('currency', request.userData.currency);
        url2.searchParams.set('price_filter_input_type', '2');
        url2.searchParams.set('price_filter_num_nights', '1');
        url2.searchParams.set('search_type', 'filter_change');
        url2.searchParams.delete('cursor');

        await crawler.addRequests([
            { url: url1.toString(), label: LABELS.SEARCH, userData: shard1, uniqueKey: `shard_${shard1.minPrice}_${shard1.maxPrice}_d${splitDepth + 1}` },
            { url: url2.toString(), label: LABELS.SEARCH, userData: shard2, uniqueKey: `shard_${shard2.minPrice}_${shard2.maxPrice}_d${splitDepth + 1}` }
        ]);


        // We stop processing this general page and let the shards handle it for better overlap avoidance
        return;
    } else if (totalCount >= 1000 && priceRange <= 10) {
    }

    if (listings.length === 0) {


        // Debug: Save screenshot and HTML to see why
        await Actor.setValue('error_output_empty.html', await page.content(), { contentType: 'text/html' });
        await page.screenshot({ path: 'error_snapshot_empty.png' });
        await Actor.setValue('error_snapshot_empty', fs.readFileSync('error_snapshot_empty.png'), { contentType: 'image/png' });


        return;
    }

    // Precise slice based on shared counter
    const remainingBeforeLoop = effectiveMaxListings - totalScrapedCount;
    if (remainingBeforeLoop <= 0) {

        return;
    }

    const listingsToProcess = listings.slice(0, remainingBeforeLoop);


    let skippedCount = 0;

    for (const listing of listingsToProcess) {
        // Double check limits inside loop
        if (totalScrapedCount >= effectiveMaxListings) break;

        const { url, ...basicData } = listing;

        // --- GLOBAL DEDUPLICATION ---
        // Extract ID from URL for deduplication
        const listingId = url.match(/\/rooms\/(\d+)/)?.[1] || url;
        if (scrapedListingIds.has(listingId)) {
            // Already scraped in a previous shard or page — skip silently but COUNT it for charging
            skippedCount++;
            continue;
        }

        // --- TWO-TIER PRICE FILTERING (Shard → Global) ---
        // Tier 1: If the listing price is within the shard range, accept it immediately.
        // Tier 2: If outside shard range BUT inside the global user-requested range, KEEP it.
        //         This is an optimization: we got it "for free" and it won't reappear in its own shard
        //         (or if it does, dedup will catch it).
        // Tier 3: If outside the global range entirely, skip it.
        const shardMinP = request.userData.minPrice;
        const shardMaxP = request.userData.maxPrice;
        const gMinP = globalMinPrice;
        const gMaxP = globalMaxPrice;


        if (basicData.price && basicData.price.amount && (gMinP !== undefined || gMaxP !== undefined)) {
            const amount = parseFloat(basicData.price.amount);
            if (!isNaN(amount)) {
                const insideShard = (shardMinP === undefined || amount >= shardMinP) && (shardMaxP === undefined || amount <= shardMaxP);
                const insideGlobal = (gMinP === undefined || amount >= gMinP) && (gMaxP === undefined || amount <= gMaxP);

                if (!insideGlobal) {
                    // Outside global user range — skip entirely but COUNT it for charging
                    skippedCount++;
                    continue;
                } else if (!insideShard && insideGlobal) {
                    // Outside shard but inside global — KEEP (optimization!)

                }
                // else: inside shard — accepted normally, no extra log needed
            }
        }

        // Mark as scraped locally to prevent reprocessing
        scrapedListingIds.add(listingId);

        if (needsDeepScrape) {
            await crawler.addRequests([{
                url,
                label: LABELS.DETAIL,
                userData: { ...request.userData, ...basicData },
            }], { forefront: true });
        } else {
            try {
                // Reorder fields for Simple Mode
                const simpleData = {
                    // 1. Fast Mode / Basic Fields
                    listingId: basicData.id,
                    url,
                    listingTitle: basicData.name,
                    thumbnail: basicData.thumbnail,
                    rating: basicData.rating,
                    reviewsCount: basicData.reviewsCount,
                    price: basicData.price,
                    roomType: basicData.roomType,
                    beds: basicData.beds,
                    bedrooms: basicData.bedrooms,
                    bathrooms: basicData.bathrooms,
                    personCapacity: basicData.personCapacity,
                    location: basicData.location,
                    scrapedAt: new Date().toISOString(),

                    // 2. Add-on Details (mostly empty in simple mode, but valid placeholders)
                    amenitiesCsv: basicData.amenities ? basicData.amenities.map((a: any) => a.title).join(', ') : '',

                    // 4. Images
                    imagesCsv: basicData.images ? basicData.images.join(', ') : (basicData.thumbnail ? basicData.thumbnail : ''),

                    mode: 'simple',
                    ...basicData // Spread rest as fallback
                };

                // Ensure ID is set
                if (!simpleData.listingId) {
                    simpleData.listingId = listingId;
                }

                // Remove 'name'/'title' as we mapped it to 'listingTitle'
                delete (simpleData as any).name;
                delete (simpleData as any).title;

                await pushData(simpleData);
                totalPushedCount++;


                // === PAY-PER-EVENT MONETIZATION ===
                // Charge for each successfully scraped listing
                await chargeOrAbort('listing-scraped', 1);
            } catch (err) {
                console.error(`[SEARCH] Failed to push listing ${url}`);
            }
        }
        totalScrapedCount++;
        if (totalScrapedCount === 1 || totalScrapedCount % 10 === 0) {
            console.log(`[PROGRESS] Scraped ${totalScrapedCount}/${effectiveMaxListings === Infinity ? '∞' : effectiveMaxListings} listings`);
        }
    }

    // Charge for skipped listings (Global duplicates + Price filtered)
    if (skippedCount > 0) {
        await chargeOrAbort('listing-scraped', skippedCount);
    }

    // Handle pagination
    if (totalScrapedCount < effectiveMaxListings) {

        // ... (pagination code remains unchanged)
        // IMPORTANT: Scroll to bottom and wait for pagination to render


        await page.evaluate(async () => {
            // Scroll to absolute bottom
            window.scrollTo(0, document.body.scrollHeight);
            // Brief wait for DOM to update
            await new Promise(r => setTimeout(r, 500));
            // Scroll again to ensure lazy-loaded content appears
            window.scrollTo(0, document.body.scrollHeight);
        });

        // Wait for pagination nav to appear (up to 5 seconds)
        try {
            await page.waitForSelector('nav[aria-label="Search results pagination"]', { timeout: 5000 });
        } catch (e) {
        }

        // Additional brief wait for Next button to become clickable
        await page.waitForTimeout(300);

        // Direct extraction of Next button using verified selector
        const nextPageInfo = await page.evaluate(() => {
            // Primary: Look for the exact selector verified via browser debug
            const nextButton = document.querySelector('a[aria-label="Next"]') as HTMLAnchorElement | null;

            if (nextButton) {
                const href = nextButton.getAttribute('href');
                const isDisabled = nextButton.hasAttribute('disabled') ||
                    nextButton.getAttribute('aria-disabled') === 'true';

                return {
                    found: true,
                    href: href ? (href.startsWith('http') ? href : `https://www.airbnb.com${href}`) : null,
                    isDisabled,
                    selector: 'a[aria-label="Next"]'
                };
            }

            // Fallback: Check if there's a button version (shouldn't happen but just in case)
            const nextButtonBtn = document.querySelector('button[aria-label="Next"]') as HTMLButtonElement | null;
            if (nextButtonBtn) {
                return {
                    found: true,
                    href: null, // Buttons don't have href - will need to click
                    isDisabled: nextButtonBtn.disabled || nextButtonBtn.getAttribute('aria-disabled') === 'true',
                    selector: 'button[aria-label="Next"]',
                    needsClick: true
                };
            }

            // Debug: Check what's in the pagination nav
            const paginationNav = document.querySelector('nav[aria-label="Search results pagination"]');
            if (paginationNav) {
                const navHtml = paginationNav.innerHTML.substring(0, 500);
                return {
                    found: false,
                    debugHtml: navHtml,
                    reason: 'Nav found but no Next button'
                };
            }

            return {
                found: false,
                reason: 'No pagination nav found'
            };
        });



        if (nextPageInfo.found && nextPageInfo.href && !nextPageInfo.isDisabled) {
            // Best case: We have a direct URL
            // Force nightly price filter on next page URL with stable parameters
            const nextUrl = new URL(nextPageInfo.href);

            // CRITICAL: Always add currency to ensure consistent pricing
            if (currency) {
                nextUrl.searchParams.set('currency', currency);
            }
            nextUrl.searchParams.set('price_filter_input_type', '2');
            nextUrl.searchParams.set('price_filter_num_nights', '1');
            nextUrl.searchParams.set('search_type', 'filter_change');

            const finalNextUrl = nextUrl.toString();


            await crawler.addRequests([{
                url: finalNextUrl,
                label: LABELS.SEARCH,
                userData: { ...request.userData, currency },
            }]);
            console.log(`[SEARCH] → Next page`);

        } else if (nextPageInfo.found && (nextPageInfo as any).needsClick && !nextPageInfo.isDisabled) {
            // Fallback: Button needs to be clicked (rare but handle it)


            try {
                await page.click('button[aria-label="Next"]');
                await page.waitForLoadState('networkidle', { timeout: 10000 });

                // After navigation, get the new URL and add currency
                const newUrlObj = new URL(page.url());
                if (currency) {
                    newUrlObj.searchParams.set('currency', currency);
                }
                const newUrl = newUrlObj.toString();

                await crawler.addRequests([{
                    url: newUrl,
                    label: LABELS.SEARCH,
                    userData: { ...request.userData, currency },
                }]);
                console.log(`[SEARCH] → Next page`);
            } catch (clickError) {
            }

        } else if (nextPageInfo.isDisabled) {


        } else {
            // No Next button found - try manual cursor construction as last resort


            try {
                const currentUrl = new URL(request.url);
                const currentCursorParam = currentUrl.searchParams.get('cursor');
                let currentItemsOffset = 0;

                if (currentCursorParam) {
                    try {
                        const decoded = JSON.parse(Buffer.from(currentCursorParam, 'base64').toString('utf-8'));
                        currentItemsOffset = decoded.items_offset || 0;
                    } catch (e) {

                    }
                }

                const itemsPerPage = listings.length > 0 ? listings.length : 20;
                const nextItemsOffset = currentItemsOffset + itemsPerPage;

                const newCursorObj = {
                    section_offset: 0,
                    items_offset: nextItemsOffset,
                    version: 1
                };
                const newCursor = Buffer.from(JSON.stringify(newCursorObj)).toString('base64');

                currentUrl.searchParams.set('cursor', newCursor);
                currentUrl.searchParams.set('pagination_search', 'true');
                if (currency) currentUrl.searchParams.set('currency', currency);
                currentUrl.searchParams.set('price_filter_input_type', '2');
                currentUrl.searchParams.set('price_filter_num_nights', '1');
                currentUrl.searchParams.set('search_type', 'filter_change');

                const nextUrl = currentUrl.toString();


                await crawler.addRequests([{
                    url: nextUrl,
                    label: LABELS.SEARCH,
                    userData: { ...request.userData, currency },
                }]);
                console.log(`[SEARCH] → Next page`);

            } catch (fallbackError) {


                // Save debug info
                const debugHtml = await page.content();
                await Actor.setValue('debug_pagination.html', debugHtml, { contentType: 'text/html' });
                await page.screenshot({ path: 'debug_pagination.png', fullPage: true });
                await Actor.setValue('debug_pagination', fs.readFileSync('debug_pagination.png'), { contentType: 'image/png' });

            }
        }
    }
});

router.addHandler(LABELS.DETAIL, async ({ page, request, pushData }) => {
    const { addOnImages, addOnReviews, addOnDetails, addOnHostDetails, price, ...searchData } = request.userData;
    const listingId = request.url.match(/\/rooms\/([^\?\/]+)/)?.[1] || 'Unknown';
    // Build clean URL without search params
    const cleanUrl = `https://www.airbnb.com/rooms/${listingId}`;
    console.log(`[DETAIL] Processing listing ${listingId}`);

    try {
        // Single call to extractor with parameters
        const fullData = await extractListingDetails(page, price, addOnHostDetails);

        if (!fullData || !fullData.id) {
            console.error(`[DETAIL] Failed to extract listing ${listingId}`);
            return;
        }





        // Format amenities and images for consistent output
        // Create CSV-friendly string versions of arrays
        const amenitiesCsv = fullData.amenities
            ? fullData.amenities
                .filter((a: any) => a.available)
                .map((a: any) => a.title)
                .join(', ')
            : '';

        const imagesCsv = fullData.images
            ? fullData.images.join(', ')
            : '';

        // Strict field ordering for CSV export
        const finalData: any = {
            // 1. Fast Mode / Basic Fields (always included)
            listingId: fullData.id || searchData.id,
            url: cleanUrl,
            listingTitle: fullData.name || searchData.name,
            thumbnail: fullData.thumbnail || searchData.thumbnail,
            rating: fullData.rating || searchData.rating,
            reviewsCount: fullData.reviewsCount || searchData.reviewsCount,
            price: fullData.price || price,
            roomType: fullData.roomType || searchData.roomType,
            beds: fullData.beds || searchData.beds,
            bedrooms: fullData.bedrooms || searchData.bedrooms,
            bathrooms: fullData.bathrooms || searchData.bathrooms,
            personCapacity: fullData.personCapacity || searchData.personCapacity,
            location: fullData.location || searchData.location,
            scrapedAt: new Date().toISOString(),

            // Internal/System fields (metadata)
            currency: fullData.currency || searchData.currency || 'USD',
            mode: 'deep',
            coordinates: fullData.coordinates || null,
            locale: fullData.locale || null,
        };

        // 2. Conditionally add add-on fields based on which add-ons are enabled
        if (addOnDetails) {
            finalData.listingDescription = fullData.description || searchData.description || null;
            finalData.subDescription = fullData.subDescription || searchData.subDescription || null;
            finalData.houseRules = fullData.houseRules || searchData.houseRules || null;
            finalData.amenitiesCsv = amenitiesCsv;
        }

        if (addOnHostDetails) {
            finalData.host = fullData.host || searchData.host || null;
        }

        if (addOnImages) {
            finalData.imagesCsv = imagesCsv;
        }

        if (addOnReviews) {
            finalData.reviews = fullData.reviews || [];
        }

        // Cleanup: Remove old/duplicate/system fields
        delete finalData.description; // mapped to listingDescription
        delete finalData.name;        // mapped to listingTitle
        delete finalData.title;       // mapped to listingTitle

        // Remove system fields passed in userData
        const unwantedFields = [
            'maxListings', 'simpleMode', 'addOnImages', 'addOnReviews',
            'addOnDetails', 'addOnHostDetails', 'label', 'scrapedIds',
            'checkin', 'checkout', 'checkIn', 'checkOut',
            'minPrice', 'maxPrice', 'globalMinPrice', 'globalMaxPrice',
            'adults', 'children', 'infants', 'pets',
            'priceShardingStep', 'enableHorizontalScaling',
            'isShardedRequest', 'shardRange', 'splitDepth',
        ];
        unwantedFields.forEach(field => delete finalData[field]);

        // REMOVE Original Arrays to prevent CSV column explosion (images/0, images/1...)
        delete finalData.amenities;
        delete finalData.images;

        await pushData(finalData);
        totalPushedCount++;
        console.log(`[DETAIL] Pushed listing ${fullData.id} | Total: ${totalPushedCount}`);

        // === PAY-PER-EVENT MONETIZATION (Deep Mode) ===
        // Base listing charge
        await chargeOrAbort('listing-scraped', 1);

        // Granular add-on charges
        if (addOnDetails) {
            await chargeOrAbort('addon-details', 1);
        }
        if (addOnHostDetails) {
            await chargeOrAbort('addon-host-details', 1);
        }
        if (addOnImages) {
            await chargeOrAbort('addon-images', 1);
        }

        // Note: We do NOT increment totalScrapedCount here because it was already incremented 
        // when the listing was first found in the SEARCH handler (where we reserve the slot).
        // If we incremented here, we would double-count.

    } catch (error) {
        console.error(`[DETAIL] Error processing listing ${listingId}`);
    }
});

// Export function to reset counter (useful for tests)
export function resetScrapedCount() {
    totalScrapedCount = 0;
    totalPushedCount = 0;
    scrapedListingIds.clear();
}

export function getScrapedCount() {
    return totalScrapedCount;
}

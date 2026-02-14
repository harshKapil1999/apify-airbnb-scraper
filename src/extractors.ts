import { Page } from 'playwright';
import { log } from './utils.js';

// Known Airbnb amenity keywords for filtering
// VALID_AMENITIES removed as it was unused

/**
 * Extract listing URLs from a search results page.
 * Uses targeted JSON path extraction and DOM fallback.
 */
export async function extractListingUrls(page: Page, pageCurrency?: string): Promise<{ listings: any[], totalCount: number, duplicateCount: number }> {
    // We no longer propagate search params into listing URLs.
    // Clean listing URL = https://www.airbnb.com/rooms/{id} (no query string)

    // Combined extraction: JSON + DOM in a single page.evaluate call
    const result = await page.evaluate((inputCurrency) => {

        const output: {
            listings: any[];
            totalCount: number;
            currency: string | null;
            duplicateCount: number;
        } = {
            listings: [],
            totalCount: 0,
            currency: inputCurrency || null,
            duplicateCount: 0
        };

        const seenIds = new Set<string>();
        let foundCurrency: string | null = null;

        // Helper: Extract currency from known paths
        const extractCurrency = function (obj: any): string | null {
            if (!obj || typeof obj !== 'object') return null;
            if (obj.currency && typeof obj.currency === 'string' && obj.currency.length === 3) {
                return obj.currency;
            }
            if (obj.filterName === 'currency' && obj.filterValues?.[0]) {
                return obj.filterValues[0];
            }
            return null;
        };

        // --- 1. JSON Extraction from niobeClientData ---
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const script of scripts) {
            try {
                const text = script.textContent || '';
                if (!text.includes('niobeClientData')) continue;

                const json = JSON.parse(text);
                const niobeData = json.niobeClientData;
                if (!niobeData) continue;

                // Extract total count
                const findTotalCount = function (obj: any, depth = 0): void {
                    if (!obj || typeof obj !== 'object' || depth > 15 || output.totalCount > 0) return;
                    if ((obj.listingsCount || obj.listingCount || obj.totalListingCount) && typeof (obj.listingsCount || obj.listingCount || obj.totalListingCount) === 'number') {
                        output.totalCount = obj.listingsCount || obj.listingCount || obj.totalListingCount;
                        return;
                    }
                    if (obj.on_the_map_search_stay_type && obj.presentation_metadata?.listings_count) {
                        output.totalCount = obj.presentation_metadata.listings_count;
                        return;
                    }
                    for (const key in obj) {
                        if (typeof obj[key] === 'object') findTotalCount(obj[key], depth + 1);
                    }
                };
                findTotalCount(niobeData);

                // Targeted search for listings in known locations
                const findListings = function (obj: any, depth = 0): void {
                    if (!obj || typeof obj !== 'object' || depth > 15) return;

                    // Check for currency
                    if (!foundCurrency) {
                        const cur = extractCurrency(obj);
                        if (cur) foundCurrency = cur;
                    }

                    // Check if this is a listing object
                    const isListing =
                        (obj.__typename === 'StaySearchResult') ||
                        (obj.__typename?.includes('Listing')) ||
                        (obj.__typename?.includes('SearchResult'));

                    if (isListing) {
                        // ID extraction
                        const idCandidate = obj.listingId || obj.id || obj.listing?.id || obj.demandStayListing?.id;
                        if (idCandidate) {
                            let id = String(idCandidate);
                            if (id.length > 20 && !id.match(/^\d+$/)) {
                                if (obj.listingId) {
                                    id = String(obj.listingId);
                                } else {
                                    try {
                                        const decoded = atob(id);
                                        const match = decoded.match(/Listing:(\d+)/i);
                                        if (match) id = match[1];
                                    } catch (e) { /* ignore */ }
                                }
                            }

                            if (!seenIds.has(id)) {
                                seenIds.add(id);

                                const listingObj = obj.listing || obj;

                                // Basic details extraction
                                let name = listingObj.name || listingObj.title || obj.title;
                                if (!name && obj.subtitle) name = obj.subtitle;

                                let rating = listingObj.avgRating || listingObj.rating || listingObj.starRating || obj.avgRatingLocalized;
                                let reviewsCount = listingObj.reviewsCount || listingObj.reviewCount || obj.reviewsCount;

                                const roomType = listingObj.roomType || listingObj.roomTitle || listingObj.roomAndPropertyType || obj.roomType || obj.listingObjType;
                                const thumbnail = listingObj.pictureUrl || listingObj.contextualPictures?.[0]?.picture || (listingObj.mediaItems?.[0]?.baseUrl) || obj.thumbnailUrl;

                                // --- Enhanced: Extract beds, bedrooms, bathrooms, personCapacity, location ---
                                let beds: any = listingObj.beds || obj.beds || null;
                                let bedrooms: any = listingObj.bedrooms || obj.bedrooms || null;
                                let bathrooms: any = listingObj.bathrooms || obj.bathrooms || null;
                                let personCapacity: any = listingObj.personCapacity || obj.personCapacity || listingObj.guestCapacity || obj.guestCapacity || null;
                                let location: string | null = listingObj.city || listingObj.location || obj.city || obj.location || listingObj.publicAddress || null;

                                // Try to extract from kickerContent / subtitle (e.g., "Entire condo in Rome · 2 bedrooms · 3 beds · 1 bath")
                                const kickerText = obj.kickerContent?.messages?.[0]?.body || obj.kickerContent?.body
                                    || listingObj.kickerContent?.messages?.[0]?.body || listingObj.kickerContent?.body
                                    || obj.listingObjType || '';
                                if (typeof kickerText === 'string' && kickerText.length > 0) {
                                    // Extract location from kicker (text before · or room type)
                                    if (!location) {
                                        const locMatch = kickerText.match(/(?:in|at)\s+([^·]+)/i);
                                        if (locMatch) location = locMatch[1].trim();
                                    }
                                    // Parse structured info: "2 bedrooms · 3 beds · 1 bath"
                                    if (!bedrooms) {
                                        const brMatch = kickerText.match(/(\d+)\s+bedroom/i);
                                        if (brMatch) bedrooms = parseInt(brMatch[1]);
                                    }
                                    if (!beds) {
                                        const bedMatch = kickerText.match(/(\d+)\s+bed(?!room)/i);
                                        if (bedMatch) beds = parseInt(bedMatch[1]);
                                    }
                                    if (!bathrooms) {
                                        const bathMatch = kickerText.match(/(\d+\.?\d*)\s+bath/i);
                                        if (bathMatch) bathrooms = parseFloat(bathMatch[1]);
                                    }
                                    if (!personCapacity) {
                                        const guestMatch = kickerText.match(/(\d+)\s+guest/i);
                                        if (guestMatch) personCapacity = parseInt(guestMatch[1]);
                                    }
                                }

                                // Also try structuredContent if available
                                const structuredContent = obj.structuredContent || listingObj.structuredContent;
                                if (structuredContent) {
                                    const scText = typeof structuredContent === 'string' ? structuredContent : JSON.stringify(structuredContent);
                                    if (!beds) {
                                        const m = scText.match(/(\d+)\s+bed(?!room)/i);
                                        if (m) beds = parseInt(m[1]);
                                    }
                                    if (!bedrooms) {
                                        const m = scText.match(/(\d+)\s+bedroom/i);
                                        if (m) bedrooms = parseInt(m[1]);
                                    }
                                    if (!bathrooms) {
                                        const m = scText.match(/(\d+\.?\d*)\s+bath/i);
                                        if (m) bathrooms = parseFloat(m[1]);
                                    }
                                }

                                let extractedPrice: any = null;
                                const structuredPrice = obj.structuredDisplayPrice || obj.listingPrice || obj.price;

                                if (structuredPrice) {
                                    const primary = structuredPrice.primaryLine;
                                    const secondary = structuredPrice.secondaryLine;

                                    // Try to find a line with "night" or "per night" first
                                    let priceLine = null;
                                    if (secondary && (secondary.price || secondary.accessibilityLabel || '').toLowerCase().includes('night')) {
                                        priceLine = secondary;
                                    } else if (primary && (primary.price || primary.accessibilityLabel || '').toLowerCase().includes('night')) {
                                        priceLine = primary;
                                    } else {
                                        // Fallback to primary
                                        priceLine = primary;
                                    }

                                    if (priceLine) {
                                        let pText = priceLine.price || priceLine.accessibilityLabel || priceLine.amountWithSymbol || '';
                                        const qualifier = priceLine.qualifier || '';

                                        if (typeof pText === 'string') {
                                            // Normalize pText (handle non-breaking spaces and extra whitespace)
                                            pText = pText.replace(/\u00a0/g, ' ').replace(/Show price breakdown|Show total price/gi, ' ').replace(/\s+/g, ' ').trim();

                                            // Extract base amount
                                            const match = pText.match(/([$€£₹¥]?)\s*([\d,]+(?:\.\d+)?)/);
                                            let amount = match ? parseFloat(match[2].replace(/,/g, '')) : 0;

                                            // Handle "total for X nights" - Normalize to nightly
                                            // 1. Try qualifier field first (most reliable)
                                            // 2. Try regex fallback on pText
                                            const normalizedQualifier = String(qualifier).toLowerCase();
                                            let numNights = 1;

                                            const qualifierMatch = normalizedQualifier.match(/(\d+)\s+nights?/);
                                            const pTextNightsMatch = pText.match(/for\s+(\d+)\s+nights?/i) || pText.match(/(\d+)\s+nights?/i);

                                            if (qualifierMatch) {
                                                numNights = parseInt(qualifierMatch[1]);
                                            } else if (pTextNightsMatch) {
                                                numNights = parseInt(pTextNightsMatch[1]);
                                            }

                                            if (numNights > 1 && amount > 0) {
                                                // Only divide if the prize text clearly indicates it's a total for multiple nights
                                                const isTotal = pText.toLowerCase().includes('total') ||
                                                    pText.toLowerCase().includes('nights') ||
                                                    normalizedQualifier.includes('nights');
                                                if (isTotal) {
                                                    amount = amount / numNights;
                                                }
                                            }

                                            extractedPrice = {
                                                label: pText,
                                                amount: amount > 0 ? Math.round(amount).toString() : '',
                                                currency: foundCurrency || (match && match[1] ? match[1] : null)
                                            };
                                        }
                                    }
                                }

                                const finalUrl = `https://www.airbnb.com/rooms/${id}`;
                                output.listings.push({
                                    url: finalUrl,
                                    price: extractedPrice,
                                    id,
                                    name,
                                    rating,
                                    reviewsCount,
                                    roomType,
                                    thumbnail,
                                    beds,
                                    bedrooms,
                                    bathrooms,
                                    personCapacity,
                                    location
                                });
                            } else {
                                // Duplicate ID found in JSON
                                output.duplicateCount++;
                            }
                        }
                    }

                    // Recurse
                    if (Array.isArray(obj)) {
                        for (const item of obj) findListings(item, depth + 1);
                    } else {
                        for (const key in obj) {
                            if (typeof obj[key] === 'object') findListings(obj[key], depth + 1);
                        }
                    }
                };

                findListings(niobeData);
            } catch (e) { /* ignore */ }
        }

        // --- 2. DOM Extraction Fallback ---
        const anchors = document.querySelectorAll('a[href*="/rooms/"]');
        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (!href || !href.includes('/rooms/')) continue;

            const idMatch = href.match(/\/rooms\/(\d+)/);
            if (!idMatch) continue;

            const id = idMatch[1];
            if (seenIds.has(id)) {
                output.duplicateCount++;
                continue;
            }
            seenIds.add(id);

            const finalUrl = `https://www.airbnb.com/rooms/${id}`;
            let name = null;

            // Try to find title in the anchor or its container using user-provided selector
            // Users report "listing-card-subtitle" often contains the specific listing name
            const subtitle = anchor.querySelector('[data-testid="listing-card-subtitle"]');
            const cardTitle = anchor.querySelector('[data-testid="listing-card-title"]');

            if (subtitle && subtitle.textContent) {
                name = subtitle.textContent.trim();
            } else if (cardTitle && cardTitle.textContent) {
                name = cardTitle.textContent.trim();
            }

            // Also check parent/container if not found in anchor
            if (!name) {
                // Try moving up to card container
                const container = anchor.closest('[data-testid="card-container"]');
                if (container) {
                    const sub = container.querySelector('[data-testid="listing-card-subtitle"]');
                    const tit = container.querySelector('[data-testid="listing-card-title"]');
                    if (sub && sub.textContent) name = sub.textContent.trim();
                    else if (tit && tit.textContent) name = tit.textContent.trim();
                }
            }

            output.listings.push({
                url: finalUrl,
                price: null,
                id,
                name
            });
        }

        output.currency = foundCurrency;
        return output;
    }, pageCurrency);

    return {
        listings: result.listings,
        totalCount: result.totalCount || result.listings.length,
        duplicateCount: result.duplicateCount || 0
    };
}

/**
 * Extract full details from a listing detail page.
 * Uses targeted JSON path extraction with DOM fallback.
 */
export async function extractListingDetails(
    page: Page,
    cachedPrice: any = null,
    addOnHostDetails: boolean = false
) {
    // Clean the URL - strip all query parameters, only keep base listing URL
    const rawUrl = page.url();
    const idFromUrl = rawUrl.match(/\/rooms\/([A-Za-z0-9=_-]+)/)?.[1];
    const cleanedUrl = idFromUrl ? `https://www.airbnb.com/rooms/${idFromUrl}` : rawUrl;
    let data: any = {
        id: null,
        url: cleanedUrl,
        title: null,
        images: [],  // Initialize as empty array
        scrapedAt: new Date().toISOString(),
        reviews: [],
    };

    // Extract ID from URL (support numeric and base64 IDs)
    const urlMatch = cleanedUrl.match(/\/rooms\/([A-Za-z0-9=_-]+)/);
    if (urlMatch) {
        data.id = urlMatch[1];
    }

    try {
        // --- Enhanced Navigation & Interactions ---
        // 1. Wait for the page content to actually render
        // Wait for h1 to appear (indicates the main content is loaded)
        // SMART WAIT: Wait until H1 text is meaningful (length > 5) and NOT generic "Airbnb"
        await page.waitForFunction(() => {
            const h1 = document.querySelector('h1');
            const text = h1?.textContent?.trim();
            return text && text.length > 5 && !text.startsWith('Airbnb');
        }, { timeout: 10000 }).catch(() => { });

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });

        // 2. Click "Show more" for description if available
        try {
            const showMoreBtn = await page.$('button >> text=/Show more|Read more/');
            if (showMoreBtn) {
                await showMoreBtn.click({ timeout: 2000 }).catch(() => { });
                await page.waitForTimeout(500);
            }
        } catch (e) { /* ignore click errors */ }

        // 3. Progressive scroll to trigger ALL lazy-loaded content (especially host section at the VERY bottom)
        await page.evaluate(async () => {
            const scrollTo = (y: number) => window.scrollTo(0, y);
            const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

            // Initial scroll to trigger basic content
            const height = document.body.scrollHeight;

            // Scroll in stages to trigger lazy loading
            scrollTo(height * 0.25);
            await wait(300);

            scrollTo(height * 0.5);
            await wait(300);

            scrollTo(height * 0.75);
            await wait(300);

            // CRITICAL: Scroll ALL THE WAY to the bottom (host section is at the very end)
            scrollTo(document.body.scrollHeight);
            await wait(400);

            // Double-check we're really at the bottom (page may have grown after lazy loading)
            const finalHeight = document.body.scrollHeight;
            scrollTo(finalHeight);
        });

        // Wait for host section to render after scrolling
        await page.waitForTimeout(1000);

        // Scroll back to top so the description & title sections are rendered
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);

        // --- Single combined extraction call for maximum performance ---
        const extractedData = await page.evaluate(function (enableHostDetails: boolean) {
            const result: any = {
                title: null,
                description: null,
                images: [],
                coordinates: null,
                host: null,
                amenities: [],
                price: null,
                currency: null,
                locale: null,
                beds: null,
                bedrooms: null,
                bathrooms: null,
                personCapacity: null,
                rating: null,
                location: null,
                roomType: null,
                subDescription: null,
                houseRules: null,
            };

            const addedAmenities = new Set<string>();

            // --- Helper: Extract from specific JSON paths ---
            const extractFromNiobeData = function (niobeData: any) {
                if (!niobeData) return;

                const search = function (obj: any, depth = 0): void {
                    if (!obj || typeof obj !== 'object' || depth > 12) return;

                    // Currency
                    if ((obj.currency || obj.curr) && typeof (obj.currency || obj.curr) === 'string') {
                        result.currency = obj.currency || obj.curr;
                    }

                    // Locale / Language
                    if ((obj.locale || obj.language || obj.descriptionLanguage) && typeof (obj.locale || obj.language || obj.descriptionLanguage) === 'string') {
                        result.locale = obj.locale || obj.language || obj.descriptionLanguage;
                    }

                    // Images from mediaItems or previewImages
                    if ((obj.mediaItems || obj.previewImages) && Array.isArray(obj.mediaItems || obj.previewImages)) {
                        (obj.mediaItems || obj.previewImages).forEach(function (item: any) {
                            if (item.baseUrl || item.url) result.images.push(item.baseUrl || item.url);
                        });
                    }


                    // Host ID and Name (Only if requested)
                    if (enableHostDetails) {
                        // 1. Check for cardData (PassportCardData)
                        if (obj.cardData && obj.__typename === 'MeetYourHostSection') {
                            if (!result.host) result.host = {};
                            const card = obj.cardData;
                            if (card.userId) {
                                let id = String(card.userId);
                                if (id.includes('User:') || !/^\d+$/.test(id)) {
                                    try {
                                        const decoded = atob(id);
                                        if (decoded.includes(':')) id = decoded.split(':').pop() || id;
                                    } catch (e) { }
                                }
                                result.host.id = id;
                                result.host.profileUrl = `https://www.airbnb.com/users/show/${id}`;
                            }
                            if (card.name) result.host.name = card.name;
                            if (card.isSuperhost !== undefined) result.host.isSuperhost = card.isSuperhost;
                            if (card.profilePictureUrl) result.host.thumbnail = card.profilePictureUrl;

                            // Extract years hosting from stats
                            if (card.stats && Array.isArray(card.stats)) {
                                const yearsStat = card.stats.find((s: any) => s.type === 'YEARS_HOSTING');
                                if (yearsStat) result.host.yearsHosting = yearsStat.value;
                            }
                        }

                        // 2. Check for eventData/pdpContext (Numeric Host ID)
                        if (obj.pdpContext && obj.pdpContext.hostId) {
                            if (!result.host) result.host = {};
                            result.host.id = String(obj.pdpContext.hostId);
                            if (obj.pdpContext.isSuperHost !== undefined) {
                                result.host.isSuperhost = obj.pdpContext.isSuperHost === 'true' || obj.pdpContext.isSuperHost === true;
                            }
                        }

                        if (obj.hostUserId || obj.host_user_id || obj.host?.id) {
                            if (!result.host) result.host = {};
                            const rid = String(obj.hostUserId || obj.host_user_id || obj.host?.id);
                            if (!result.host.id || result.host.id.length > 20) result.host.id = rid;

                            const hostName = obj.host?.firstName || obj.host?.name || obj.host?.displayName;
                            if (hostName && !result.host.name) {
                                result.host.name = hostName;
                            }
                        }
                        if (obj.__typename === 'User' && obj.id && !result.host?.id) {
                            if (!result.host) result.host = {};
                            result.host.id = String(obj.id);
                            const userName = obj.firstName || obj.name || obj.displayName;
                            if (userName && !result.host.name) result.host.name = userName;
                        }
                    }

                    // Capacity and room details
                    if (obj.personCapacity != null && !result.personCapacity) {
                        result.personCapacity = obj.personCapacity;
                    }
                    if (obj.bedrooms != null && !result.bedrooms) {
                        result.bedrooms = obj.bedrooms;
                    }
                    if (obj.beds != null && !result.beds) {
                        result.beds = obj.beds;
                    }
                    if (obj.bathrooms != null && !result.bathrooms) {
                        result.bathrooms = obj.bathrooms;
                    }

                    // Location
                    if (obj.__typename === 'LocationSection' && obj.subtitle) {
                        result.location = obj.subtitle;
                    }
                    if (obj.lat && obj.lng && !result.coordinates) {
                        result.coordinates = { latitude: obj.lat, longitude: obj.lng };
                    }
                    if (obj.coordinate?.latitude && obj.coordinate?.longitude && !result.coordinates) {
                        result.coordinates = { latitude: obj.coordinate.latitude, longitude: obj.coordinate.longitude };
                    }

                    // Price extraction
                    if ((obj.structuredStayDisplayPrice || obj.structuredDisplayPrice) && !result.price) {
                        const sp = obj.structuredStayDisplayPrice || obj.structuredDisplayPrice;
                        const line = sp?.primaryLine;
                        if (line) {
                            const priceLine = line.accessibilityLabel || line.price || line.amountWithSymbol || '';
                            if (priceLine) {
                                const match = String(priceLine).match(/[\d,]+/);
                                let cleanLabel = String(priceLine).replace(/Show price breakdown|Show total price/gi, ' ').replace(/\s+/g, ' ').trim();
                                result.price = {
                                    label: cleanLabel,
                                    amount: match ? match[0].replace(/,/g, '') : '',
                                    currency: result.currency
                                };
                            }
                        }
                    }

                    // --- Title extraction from JSON ---
                    // Look for listing name/title in JSON data
                    if (!result.title) {
                        if (obj.__typename === 'StayListing' || obj.__typename === 'Listing') {
                            const name = obj.name || obj.title;
                            if (name && typeof name === 'string' && name.length > 5 && !name.includes('·')) {
                                result.title = name;
                            }
                        }
                        // sharingConfig may have listingName (clean) or title (concatenated with ·)
                        if (obj.sharingConfig) {
                            const cleanName = obj.sharingConfig.listingName || obj.sharingConfig.name;
                            if (cleanName && typeof cleanName === 'string' && cleanName.length > 3) {
                                result.title = cleanName;
                            } else if (obj.sharingConfig.title && !obj.sharingConfig.title.includes('·')) {
                                result.title = obj.sharingConfig.title;
                            }
                        }
                    }

                    // --- Description extraction from JSON ---
                    if (!result.description) {
                        // Check for htmlDescription or description fields
                        if (obj.__typename === 'PdpDescriptionSection' || obj.__typename === 'DescriptionSection') {
                            const descText = obj.htmlDescription || obj.description;
                            if (descText && typeof descText === 'string' && descText.length > 20) {
                                // Strip HTML tags if present
                                result.description = descText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                            }
                        }
                        if (obj.description && typeof obj.description === 'string' && obj.description.length > 50 && !result.description) {
                            result.description = obj.description;
                        }
                        if (obj.listingDescription && typeof obj.listingDescription === 'string' && obj.listingDescription.length > 50 && !result.description) {
                            result.description = obj.listingDescription;
                        }
                    }

                    // --- SubDescription from JSON ---
                    if (!result.subDescription) {
                        // Look for overview subtitle or room type + capacity info
                        if (obj.__typename === 'OverviewDefaultSection' || obj.__typename === 'OverviewSection') {
                            const subtitle = obj.detailsSummary || obj.subtitle;
                            if (subtitle && typeof subtitle === 'string') {
                                result.subDescription = subtitle;
                            }
                        }
                    }

                    // --- House Rules from JSON ---
                    if (!result.houseRules) {
                        if (obj.__typename === 'PoliciesSection' || obj.__typename === 'HouseRulesSection') {
                            const rules: string[] = [];
                            if (obj.houseRules && Array.isArray(obj.houseRules)) {
                                obj.houseRules.forEach(function (rule: any) {
                                    const text = rule.title || rule.text || (typeof rule === 'string' ? rule : '');
                                    if (text) rules.push(text);
                                });
                            }
                            if (obj.listItems && Array.isArray(obj.listItems)) {
                                obj.listItems.forEach(function (item: any) {
                                    const text = item.title || item.text || (typeof item === 'string' ? item : '');
                                    if (text) rules.push(text);
                                });
                            }
                            if (rules.length > 0) {
                                result.houseRules = rules.join(' | ');
                            }
                        }
                    }

                    // Amenities
                    if ((obj.amenities || obj.listingAmenities) && Array.isArray(obj.amenities || obj.listingAmenities)) {
                        (obj.amenities || obj.listingAmenities).forEach(function (a: any) {
                            const name = a.name || a.title || (typeof a === 'string' ? a : null);
                            if (name && !addedAmenities.has(name)) {
                                addedAmenities.add(name);
                                result.amenities.push({ title: name, available: a.isPresent !== false });
                            }
                        });
                    }
                    if (obj.amenityGroups && Array.isArray(obj.amenityGroups)) {
                        obj.amenityGroups.forEach(function (group: any) {
                            if (group.amenities && Array.isArray(group.amenities)) {
                                group.amenities.forEach(function (a: any) {
                                    const name = a.name || a.title;
                                    if (name && !addedAmenities.has(name)) {
                                        addedAmenities.add(name);
                                        result.amenities.push({ title: name, available: a.isPresent !== false });
                                    }
                                });
                            }
                        });
                    }

                    // Recurse
                    if (Array.isArray(obj)) {
                        for (const item of obj) search(item, depth + 1);
                    } else {
                        for (const key in obj) {
                            if (typeof obj[key] === 'object') search(obj[key], depth + 1);
                        }
                    }
                };

                search(niobeData);
            };

            // --- Parse JSON scripts ---
            const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
            for (const script of scripts) {
                try {
                    const text = script.textContent || '';
                    if (text.includes('niobeClientData') || text.includes('pageProps')) {
                        const json = JSON.parse(text);
                        if (json.niobeClientData) extractFromNiobeData(json.niobeClientData);
                        if (json.props?.pageProps) extractFromNiobeData(json.props.pageProps);
                    }
                } catch (e) { /* ignore */ }
            }

            // --- __NEXT_DATA__ extraction ---
            try {
                const nextDataScript = document.querySelector('#__NEXT_DATA__');
                if (nextDataScript) {
                    const nextData = JSON.parse(nextDataScript.textContent || '{}');
                    const pageProps = nextData?.props?.pageProps;

                    // Extract listing data
                    const listing = pageProps?.bootstrapData?.layout?.stayPdpLayoutData?.listing;
                    if (listing) {
                        if (listing.personCapacity && !result.personCapacity) result.personCapacity = listing.personCapacity;
                        if (listing.bedrooms && !result.bedrooms) result.bedrooms = listing.bedrooms;
                        if (listing.beds && !result.beds) result.beds = listing.beds;
                        if (listing.bathrooms && !result.bathrooms) result.bathrooms = listing.bathrooms;
                        if (listing.lat && listing.lng && !result.coordinates) {
                            result.coordinates = { latitude: listing.lat, longitude: listing.lng };
                        }
                        if (listing.coordinate && !result.coordinates) {
                            result.coordinates = { latitude: listing.coordinate.latitude, longitude: listing.coordinate.longitude };
                        }
                    }

                    // Extract host data from multiple potential locations
                    if (enableHostDetails) {
                        // Try bootstrapData.metadata.sharingConfig.personId
                        const sharingConfig = pageProps?.bootstrapData?.metadata?.sharingConfig;
                        if (sharingConfig?.personId) {
                            if (!result.host) result.host = {};
                            result.host.id = String(sharingConfig.personId);
                        }

                        // Try layout host user
                        const hostUser = pageProps?.bootstrapData?.layout?.hostUser;
                        if (hostUser) {
                            if (!result.host) result.host = {};
                            if (hostUser.id && !result.host.id) result.host.id = String(hostUser.id);
                            // Try multiple name fields
                            const hostName = hostUser.firstName || hostUser.name || hostUser.displayName;
                            if (hostName && !result.host.name) result.host.name = hostName;
                            if (hostUser.isSuperhost !== undefined) result.host.isSuperhost = hostUser.isSuperhost;
                            // Try years hosting
                            if (hostUser.yearsHosting && !result.host.yearsHosting) {
                                result.host.yearsHosting = hostUser.yearsHosting;
                            }
                            if (hostUser.createdAt && !result.host.yearsHosting) {
                                const joinedYear = new Date(hostUser.createdAt).getFullYear();
                                const currentYear = new Date().getFullYear();
                                result.host.yearsHosting = currentYear - joinedYear;
                            }
                        }

                        // Try listing.user or listing.host
                        if (listing?.user) {
                            if (!result.host) result.host = {};
                            if (listing.user.id && !result.host.id) result.host.id = String(listing.user.id);
                            const userName = listing.user.firstName || listing.user.name || listing.user.displayName;
                            if (userName && !result.host.name) result.host.name = userName;
                            if (listing.user.isSuperhost !== undefined) result.host.isSuperhost = listing.user.isSuperhost;
                        }
                        if (listing?.host) {
                            if (!result.host) result.host = {};
                            if (listing.host.id && !result.host.id) result.host.id = String(listing.host.id);
                            const hostName = listing.host.firstName || listing.host.name || listing.host.displayName;
                            if (hostName && !result.host.name) result.host.name = hostName;
                            if (listing.host.isSuperhost !== undefined) result.host.isSuperhost = listing.host.isSuperhost;
                        }

                        // Try primaryHost in layout
                        const primaryHost = pageProps?.bootstrapData?.layout?.stayPdpLayoutData?.primaryHost;
                        if (primaryHost) {
                            if (!result.host) result.host = {};
                            const hostName = primaryHost.name || primaryHost.firstName || primaryHost.displayName;
                            if (hostName && !result.host.name) result.host.name = hostName;
                            if (primaryHost.yearsOnAirbnb && !result.host.yearsHosting) {
                                result.host.yearsHosting = primaryHost.yearsOnAirbnb;
                            }
                            if (primaryHost.memberSince && !result.host.yearsHosting) {
                                const year = parseInt(primaryHost.memberSince);
                                if (!isNaN(year)) {
                                    result.host.yearsHosting = new Date().getFullYear() - year;
                                }
                            }
                        }
                    }
                }
            } catch (e) { /* ignore */ }

            // --- DOM Fallbacks ---
            // Title: Use h1, but verify it's not a generic category (e.g. "Room in London")
            if (!result.title) {
                const h1 = document.querySelector('h1');
                const h1Text = h1?.textContent?.trim() || '';

                // Check if h1 is a generic category like "Room in London" or "Home in Paris"
                const isGenericTitle = /^(Room|Entire|Private|Shared|Home)\s+(in|near)\s+/i.test(h1Text) && h1Text.length < 40;

                if (h1Text && !isGenericTitle) {
                    // H1 contains the specific listing name
                    result.title = h1Text;
                } else {
                    // Fallback: Parse document.title (format: "Listing Name - Type - Location - Airbnb")
                    const docTitle = document.title || '';
                    if (docTitle.includes(' - ')) {
                        const parts = docTitle.split(' - ');
                        // First part is usually the listing name, last part is "Airbnb"
                        if (parts.length >= 2 && parts[0].trim().length > 3) {
                            result.title = parts[0].trim();
                        }
                    }

                    // If still no good title, try meta og:title
                    if (!result.title) {
                        const ogTitle = document.querySelector('meta[property="og:title"]');
                        if (ogTitle) {
                            const content = ogTitle.getAttribute('content') || '';
                            // og:title format: "Listing Name · ★4.83 · 2 bedrooms..."
                            if (content.includes('·')) {
                                const titlePart = content.split('·')[0].trim();
                                if (titlePart.length > 3) {
                                    result.title = titlePart;
                                }
                            } else if (content.length > 3) {
                                result.title = content;
                            }
                        }
                    }

                    // Last resort: use the h1 even if generic
                    if (!result.title && h1Text) {
                        result.title = h1Text;
                    }
                }
            }

            // Description - Look for main property description
            if (!result.description) {
                try {
                    // Method 1: Use stable data-section-id selector
                    const descSection = document.querySelector('div[data-section-id="DESCRIPTION_DEFAULT"]');
                    if (descSection && descSection.textContent && descSection.textContent.length > 50) {
                        // Get text, clean up "Show more" / "About this place" boilerplate
                        let descText = descSection.textContent
                            .replace(/About this (place|space)/gi, '')
                            .replace(/Show more|Hide|Read more/gi, '')
                            .trim();
                        if (descText.length > 20) {
                            result.description = descText;
                        }
                    }

                    // Method 2: Look for "About this place" heading and traverse
                    if (!result.description) {
                        const aboutHeaders = Array.from(document.querySelectorAll('h2, h3'));
                        const aboutSection = aboutHeaders.find(el =>
                            el.textContent?.includes('About this') ||
                            el.textContent?.includes('About the')
                        );

                        if (aboutSection) {
                            let descContainer = aboutSection.nextElementSibling;
                            let attempts = 0;
                            while (descContainer && attempts < 5) {
                                if (descContainer.tagName === 'DIV' && !descContainer.querySelector('button') && descContainer.textContent && descContainer.textContent.length > 50) {
                                    result.description = descContainer.textContent.replace(/Show more|Hide/gi, '').trim();
                                    break;
                                }
                                descContainer = descContainer.nextElementSibling;
                                attempts++;
                            }
                        }
                    }

                    // Method 3: div with description in data-section-id or class
                    if (!result.description) {
                        const descDivs = Array.from(document.querySelectorAll('div[data-section-id*="description"], div[class*="description"]'));
                        for (const div of descDivs) {
                            const text = div.textContent?.trim();
                            if (text && text.length > 100) {
                                result.description = text.replace(/Show more.*$/gi, '').trim();
                                break;
                            }
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // SubDescription - Room/Property type and basic info
            if (!result.subDescription) {
                try {
                    // Method 1: Use stable data-section-id="OVERVIEW_DEFAULT_V2" selector
                    const overviewSection = document.querySelector('div[data-section-id="OVERVIEW_DEFAULT_V2"]');
                    if (overviewSection && overviewSection.textContent) {
                        const text = overviewSection.textContent.trim();
                        if (text.length > 5 && text.length < 300) {
                            result.subDescription = text;
                        }
                    }

                    // Method 2: Look for subtitle under h1
                    if (!result.subDescription) {
                        const h1 = document.querySelector('h1');
                        if (h1) {
                            const nextDiv = h1.nextElementSibling;
                            if (nextDiv?.textContent) {
                                const text = nextDiv.textContent.trim();
                                if (text.length < 100 && text.length > 5) {
                                    result.subDescription = text;
                                }
                            }
                        }
                    }

                    // Method 3: Look for room type in structured format
                    if (!result.subDescription) {
                        const roomTypeSpans = Array.from(document.querySelectorAll('span, div'));
                        for (const span of roomTypeSpans) {
                            const text = span.textContent?.trim() || '';
                            if (/^(Room|Entire|Private|Shared).{5,60}$/i.test(text)) {
                                result.subDescription = text;
                                break;
                            }
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // --- DOM Fallback for beds/bedrooms/bathrooms/personCapacity/roomType/location ---
            // Look for the subtitle under h1, e.g. "2 guests · 1 bedroom · 1 bed · 1 bath"
            // or "Room in London · ★4.93 · 1 bedroom · 1 bed · 1 shared bath"
            try {
                const h1 = document.querySelector('h1');
                if (h1) {
                    // The overview info is usually the div AFTER the h1 or in a nearby section
                    let overviewText = '';

                    // Method 1: Look for the overview section with guest/bedroom/bed/bath info
                    const allDivs = Array.from(document.querySelectorAll('div, span, li, ol'));
                    for (const el of allDivs) {
                        const t = el.textContent?.trim() || '';
                        // Match patterns like "2 guests · 1 bedroom · 1 bed · 1 bath"
                        if (t.match(/\d+\s+(guest|bed|bath)/i) && t.length < 200) {
                            overviewText = t;
                            break;
                        }
                    }

                    // Also try the next sibling of h1
                    if (!overviewText) {
                        const nextEl = h1.nextElementSibling;
                        if (nextEl?.textContent && nextEl.textContent.length < 200) {
                            overviewText = nextEl.textContent.trim();
                        }
                    }

                    if (overviewText) {
                        // Extract room type from beginning (e.g., "Room in London")
                        if (!result.roomType) {
                            const rtMatch = overviewText.match(/^(Entire\s+\w+|Room|Private\s+room|Shared\s+room)\s+(?:in\s+)?/i);
                            if (rtMatch) result.roomType = rtMatch[0].trim();
                        }

                        // Extract location ("in {Location}")
                        if (!result.location) {
                            const locMatch = overviewText.match(/(?:in|at)\s+([^·★\d]+)/i);
                            if (locMatch) result.location = locMatch[1].trim();
                        }

                        // Extract guests
                        if (!result.personCapacity) {
                            const gMatch = overviewText.match(/(\d+)\s+guest/i);
                            if (gMatch) result.personCapacity = parseInt(gMatch[1]);
                        }

                        // Extract bedrooms
                        if (!result.bedrooms) {
                            const brMatch = overviewText.match(/(\d+)\s+bedroom/i);
                            if (brMatch) result.bedrooms = parseInt(brMatch[1]);
                            // Also handle "Studio" meaning 0 bedrooms
                            if (!brMatch && overviewText.toLowerCase().includes('studio')) {
                                result.bedrooms = 0;
                            }
                        }

                        // Extract beds
                        if (!result.beds) {
                            const bedMatch = overviewText.match(/(\d+)\s+bed(?!room)/i);
                            if (bedMatch) result.beds = parseInt(bedMatch[1]);
                        }

                        // Extract bathrooms
                        if (!result.bathrooms) {
                            const bathMatch = overviewText.match(/(\d+\.?\d*)\s+(?:shared\s+)?bath/i);
                            if (bathMatch) result.bathrooms = parseFloat(bathMatch[1]);
                            // Handle "Half-bath" as 0.5
                            if (!bathMatch && overviewText.toLowerCase().includes('half-bath')) {
                                result.bathrooms = 0.5;
                            }
                        }

                        // Extract rating from overview like ★4.93
                        if (!result.rating) {
                            const ratingMatch = overviewText.match(/★\s*(\d+\.?\d*)/i);
                            if (ratingMatch) result.rating = parseFloat(ratingMatch[1]);
                        }
                    }
                }
            } catch (e) { /* ignore */ }


            // House Rules - Use stable data-section-id selector
            if (!result.houseRules) {
                try {
                    // Method 1: data-section-id="POLICIES_DEFAULT" (most reliable)
                    const policiesSection = document.querySelector('div[data-section-id="POLICIES_DEFAULT"]');
                    if (policiesSection) {
                        // Look for "House rules" sub-section within policies
                        const ruleHeaders = Array.from(policiesSection.querySelectorAll('h3, h2, div'));
                        const houseRulesHeader = ruleHeaders.find(el => el.textContent?.trim() === 'House rules');

                        if (houseRulesHeader) {
                            // Get the parent card/container of the House rules heading
                            const rulesCard = houseRulesHeader.closest('div[class]');
                            if (rulesCard && rulesCard.textContent) {
                                result.houseRules = rulesCard.textContent
                                    .replace(/Show more|Hide/gi, '')
                                    .trim();
                            }
                        }

                        // Fallback: just get all text from the policies section
                        if (!result.houseRules && policiesSection.textContent && policiesSection.textContent.length > 20) {
                            result.houseRules = policiesSection.textContent
                                .replace(/Show more|Hide/gi, '')
                                .trim();
                        }
                    }

                    // Method 2: Search for "House rules" or "Things to know" heading
                    if (!result.houseRules) {
                        const ruleHeaders = Array.from(document.querySelectorAll('h2, h3'));
                        const rulesSection = ruleHeaders.find(el =>
                            el.textContent?.includes('House rules') ||
                            el.textContent?.includes('Things to know')
                        );

                        if (rulesSection) {
                            const rulesContainer = rulesSection.closest('div[class*="rules"], section') || rulesSection.parentElement;
                            const ruleText = rulesContainer?.textContent?.trim();
                            if (ruleText && ruleText.length > 20) {
                                result.houseRules = ruleText;
                            }
                        }
                    }
                } catch (e) { /* ignore */ }
            }


            // --- DOM-based Host Extraction (Refined) ---
            if (enableHostDetails) {
                if (!result.host) result.host = {};

                try {
                    // 1. Extract Host ID from Profile Link
                    const profileLink = document.querySelector('a[aria-label="Go to Host full profile"], a[href*="/users/show/"], a[href*="/users/profile/"]') as HTMLAnchorElement;
                    let container: Element | null = null;

                    if (profileLink) {
                        const href = profileLink.href;
                        const idMatch = href.match(/\/users\/(?:show|profile)\/(\d+)/);
                        if (idMatch && !result.host.id) result.host.id = idMatch[1]; // Only set if not already set by JSON

                        // Find the "Meet your host" card container
                        container = profileLink.parentElement;
                        for (let i = 0; i < 6; i++) {
                            if (!container) break;
                            const text = container.textContent || "";
                            if (text.includes("Years hosting") || text.includes("Host details") || text.includes("Co-Hosts")) {
                                break;
                            }
                            if (container.tagName === 'SECTION') break;
                            container = container.parentElement;
                        }
                    } else {
                        // Fallback: Find "Meet your host" header
                        const headers = Array.from(document.querySelectorAll('h2, h3, h4, div[role="heading"]'));
                        const hostHeader = headers.find(h => h.textContent?.includes("Meet your host"));
                        if (hostHeader) {
                            container = hostHeader.parentElement?.parentElement || hostHeader.parentElement;
                        }
                    }

                    if (container) {
                        const text = container.textContent || "";

                        // 2. Extract Host Name - Refined
                        // Prioritize "Hosted by X" as it's most explicit
                        const hostedByMatch = text.match(/Hosted by\s+([^\r\n]+)/i);
                        if (hostedByMatch) {
                            // Clean up "Hosted by Mark" -> "Mark" (sometimes it has extra text)
                            const rawName = hostedByMatch[1].trim();
                            // Take first part if it looks like a name, stop at newline or "Joined"
                            result.host.name = rawName.split(/[\n\r]|Joined|•/)[0].trim();
                        }

                        if (!result.host.name) {
                            // Fallback to "Mark\nHost" pattern
                            // Relaxed regex to match "Mark" then "Host" or "Superhost" somewhere after
                            const roleMatch = text.match(/^([A-Z][a-z]+)[\s\S]{0,20}?(?:Superhost|Host)\b/m);
                            if (roleMatch) {
                                result.host.name = roleMatch[1];
                            }
                        }

                        if (!result.host.name) {
                            // Fallback to Image Alt
                            const img = container.querySelector('img');
                            if (img && img.alt) {
                                const altName = img.alt.split(' ')[0];
                                if (altName !== "User" && altName !== "Profile") result.host.name = altName;
                            }
                        }

                        // 3. Extract Years of Hosting - Refined
                        // "8 Years hosting" or "10+ Years hosting" or "Hosting for 6 years"
                        const yearsMatch = text.match(/(\d+\+?)\s+Years?\s+hosting/i) || text.match(/Hosting for\s+(\d+)\s+years?/i);
                        if (yearsMatch) {
                            // Parse "10+" as 10 for integer safety
                            result.host.yearsHosting = parseInt(yearsMatch[1].replace('+', ''));
                        } else {
                            // Fallback: "Joined in September 2014" or just "Joined 2014"
                            const joinedMatch = text.match(/Joined(?: in)?\s+(?:[A-Z][a-z]+\s+)?(\d{4})/i);
                            if (joinedMatch) {
                                const joinedYear = parseInt(joinedMatch[1]);
                                const currentYear = new Date().getFullYear();
                                result.host.yearsHosting = currentYear - joinedYear;
                            }
                        }

                        // 4. Extract Host Type (Superhost or Host)
                        if (text.includes("Superhost")) {
                            result.host.hostType = "Superhost";
                            result.host.isSuperhost = true;
                        } else {
                            // Only set if not already determined
                            if (!result.host.hostType) result.host.hostType = "Host";
                            if (result.host.isSuperhost === undefined) result.host.isSuperhost = false;
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            return result;
        }, addOnHostDetails);

        Object.assign(data, extractedData);
        // Alias title to name for consistency
        if (data.title && !data.name) data.name = data.title;

        // SANITY CHECK: If deep scraped title is generic (e.g. from redirect), nuke it
        // so we can fallback to search data
        if (data.name && (data.name.startsWith('Airbnb: ') || data.name.startsWith('Holiday Rentals') || data.name === 'Airbnb')) {
            data.name = null;
            data.title = null;
        }

        // Fallback to cached price from search page if deep extraction failed
        if ((!data.price || !data.price.amount) && cachedPrice) {
            data.price = cachedPrice;
        }
        return data;

    } catch (error) {
        log.error(`Error in detail extraction: ${error}`);
        return data;
    }
}

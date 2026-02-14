import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { router, getScrapedCount } from './routes.js';
import fs from 'fs';
import path from 'path';

interface Input {
    locationQueries?: string[];
    startUrls?: string[];
    maxListings?: number;
    simpleMode?: boolean;
    minPrice?: number;
    maxPrice?: number;
    checkIn?: string;
    checkOut?: string;
    currency?: string;
    proxyConfiguration?: any;
    addOnReviews?: boolean;
    addOnImages?: boolean;
    addOnDetails?: boolean;
    addOnHostDetails?: boolean;
    // Filters
    adults?: number;
    children?: number;
    infants?: number;
    pets?: number;
    minBeds?: number;
    minBedrooms?: number;
    minBathrooms?: number;
    // Horizontal Scaling Options
    priceShardingStep?: number;
    enableHorizontalScaling?: boolean;
}

await Actor.init();

const input = await Actor.getInput<Input>() || {};

const {
    locationQueries = ['London'],
    startUrls = [],
    maxListings: userMaxListings, // Rename to avoid conflict with calculated const
    simpleMode = true,
    currency = 'USD',
    proxyConfiguration,
    addOnReviews = false,
    addOnImages = false,
    addOnDetails = false,
    addOnHostDetails = false
} = input;

// If maxListings is not provided (or 0), treat as unlimited (Infinity)
const maxListings = (userMaxListings && userMaxListings > 0) ? userMaxListings : Infinity;

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

import { LABELS } from './constants.js';

// Fallback currency multipliers (for offline or API failure scenarios)
const FALLBACK_CURRENCY_MULTIPLIERS: Record<string, number> = {
    'USD': 1, 'EUR': 0.9, 'GBP': 0.8, 'AUD': 1.5, 'CAD': 1.4,
    'JPY': 150, 'KRW': 1300, 'INR': 83, 'IDR': 15500, 'VND': 25000,
    'THB': 36, 'PHP': 56, 'TWD': 32, 'TRY': 30, 'CNY': 7.2,
    'BRL': 5.0, 'MXN': 17, 'SAR': 3.75, 'AED': 3.67, 'ZAR': 19,
    'CHF': 0.9, 'NZD': 1.6, 'SGD': 1.35
};

/**
 * Fetch live exchange rate from free API
 * Returns multiplier relative to USD (how many units of target currency = 1 USD)
 */
async function fetchExchangeRate(targetCurrency: string): Promise<number> {
    if (targetCurrency === 'USD') return 1;

    try {

        const response = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`);

        if (!response.ok) {
            throw new Error(`API returned status ${response.status}`);
        }

        const data = await response.json();
        const rate = data.rates?.[targetCurrency];

        if (rate && typeof rate === 'number') {

            return rate;
        } else {
            throw new Error(`Currency ${targetCurrency} not found in API response`);
        }
    } catch (error) {
        console.warn(`[CURRENCY] Using fallback exchange rate for ${targetCurrency}`);
        return FALLBACK_CURRENCY_MULTIPLIERS[targetCurrency] || 1;
    }
}

// --- Price Shard Generator ---
// Splits a price range into smaller intervals for horizontal scraping
function generatePriceShards(
    minPrice: number,
    maxPrice: number,
    step: number
): { min: number; max: number }[] {
    const shards: { min: number; max: number }[] = [];
    for (let price = minPrice; price <= maxPrice; price += step) {
        shards.push({
            min: price,
            max: Math.min(price + step - 1, maxPrice)
        });
    }
    return shards;
}

// Prepare Start Requests
const startRequests: any[] = [];

// Extract horizontal scaling options
// Dynamic step size based on LIVE currency multiplier from API
const defaultStep = 5;
const currencyMultiplier = await fetchExchangeRate(currency);
// Scale the default $5 step by the live currency multiplier
const priceShardingStep = input.priceShardingStep ?? Math.ceil(defaultStep * currencyMultiplier);



// Forces horizontal scaling to be enabled by default as per requirements
// Auto-enable horizontal scaling if minPrice is set, or if explicitly enabled
let enableHorizontalScaling = input.enableHorizontalScaling ?? false;

// AUTO-ENABLE: If maxListings is unlimited (0/Infinity) and no price range is set,
// automatically enable price sharding with a wide range to avoid Airbnb's 300-result truncation.
if (maxListings === Infinity && input.minPrice === undefined && input.maxPrice === undefined) {
    enableHorizontalScaling = true;
    input.minPrice = 0;
    input.maxPrice = 10000;

}

// Validation: Ensure we have valid price range if horizontal scaling is enabled
// Enhanced: Auto-generate maxPrice when only minPrice is provided
if (input.minPrice !== undefined || enableHorizontalScaling) {

    // Enable by default if not strictly disabled (though we hid the option)
    if (input.minPrice !== undefined && input.enableHorizontalScaling !== false) {
        enableHorizontalScaling = true;

    }

    if (input.minPrice !== undefined && input.maxPrice === undefined) {
        // User only specified minPrice - auto-generate maxPrice to a high cap
        const SAFETY_MAX_PRICE = 10000;
        input.maxPrice = SAFETY_MAX_PRICE;

    } else if (input.minPrice === undefined && input.maxPrice === undefined) {
        if (enableHorizontalScaling) {

            input.minPrice = 0;
            input.maxPrice = 10000;
        }
    } else if (input.minPrice === undefined) {
        // Only maxPrice specified - start from 0
        input.minPrice = 0;

    }

    if (input.minPrice !== undefined && input.maxPrice !== undefined && input.minPrice >= input.maxPrice) {
        console.warn('[CONFIG] Invalid price range. Disabling price sharding.');
        enableHorizontalScaling = false;
    }

    // Update global config with resolved value
    input.enableHorizontalScaling = enableHorizontalScaling;
}

// Preserve the user's original global price range for cross-shard optimization
const globalMinPrice = input.minPrice;
const globalMaxPrice = input.maxPrice;

const commonUserData = {
    maxListings,
    simpleMode,
    addOnReviews,
    addOnImages,
    addOnDetails,
    addOnHostDetails,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    // Global price range passed to all requests for cross-shard optimization
    globalMinPrice,
    globalMaxPrice,
    adults: input.adults,
    children: input.children,
    infants: input.infants,
    pets: input.pets,
    minBeds: input.minBeds,
    minBedrooms: input.minBedrooms,
    minBathrooms: input.minBathrooms,
    currency,
    priceShardingStep,
    enableHorizontalScaling
};

// 1. Explicit Start URLs
if (startUrls && startUrls.length > 0) {
    startUrls.forEach(urlObj => {
        let url = typeof urlObj === 'string' ? urlObj : (urlObj as any).url;

        // Ensure currency is added to startUrl if not already present
        try {
            const urlWithCurrency = new URL(url);
            if (!urlWithCurrency.searchParams.has('currency') && currency) {
                urlWithCurrency.searchParams.set('currency', currency);
                url = urlWithCurrency.toString();
            }
        } catch (e) { /* ignore invalid URLs */ }

        const isDetail = url.match(/\/rooms\/\d+/);
        startRequests.push({
            url,
            uniqueKey: url,
            label: isDetail ? LABELS.DETAIL : LABELS.SEARCH,
            userData: { ...commonUserData }
        });
    });
}

// 2. Location Queries -> Search URLs (with optional Price Sharding)
if (locationQueries && locationQueries.length > 0) {
    for (const query of locationQueries) {
        // Resolve dates for search - Force 1-night if missing to ensure nightly prices
        let searchCheckIn = input.checkIn;
        let searchCheckOut = input.checkOut;

        if (!searchCheckIn) {
            const today = new Date();
            const future = new Date(today);
            future.setDate(today.getDate() + 30); // 30 days in future to ensure availability
            const nextDay = new Date(future);
            nextDay.setDate(future.getDate() + 1);

            searchCheckIn = future.toISOString().split('T')[0];
            searchCheckOut = nextDay.toISOString().split('T')[0];

        }

        // Check if horizontal scaling via price sharding is enabled
        const shouldShard = enableHorizontalScaling &&
            input.minPrice !== undefined &&
            input.maxPrice !== undefined &&
            input.maxPrice > input.minPrice;

        if (shouldShard) {
            // Generate price shards for horizontal scraping
            const shards = generatePriceShards(
                input.minPrice!,
                input.maxPrice!,
                priceShardingStep
            );



            for (const shard of shards) {
                const baseUrl = new URL('https://www.airbnb.com/s/' + encodeURIComponent(query) + '/homes');
                baseUrl.searchParams.set('checkin', searchCheckIn!);
                baseUrl.searchParams.set('checkout', searchCheckOut!);

                if (input.adults !== undefined) baseUrl.searchParams.set('adults', input.adults.toString());
                if (input.children !== undefined) baseUrl.searchParams.set('children', input.children.toString());
                if (input.infants !== undefined) baseUrl.searchParams.set('infants', input.infants.toString());
                if (input.pets !== undefined) baseUrl.searchParams.set('pets', input.pets.toString());

                // Apply shard-specific price range
                baseUrl.searchParams.set('price_min', shard.min.toString());
                baseUrl.searchParams.set('price_max', shard.max.toString());

                if (input.minBeds !== undefined) baseUrl.searchParams.set('min_beds', input.minBeds.toString());
                if (input.minBedrooms !== undefined) baseUrl.searchParams.set('min_bedrooms', input.minBedrooms.toString());
                if (input.minBathrooms !== undefined) baseUrl.searchParams.set('min_bathrooms', input.minBathrooms.toString());
                if (currency) baseUrl.searchParams.set('currency', currency);

                // CRITICAL: Force nightly price filtering with stable parameters
                baseUrl.searchParams.set('price_filter_input_type', '2');
                baseUrl.searchParams.set('price_filter_num_nights', '1');
                baseUrl.searchParams.set('search_type', 'filter_change');
                baseUrl.searchParams.set('channel', 'EXPLORE');

                startRequests.push({
                    url: baseUrl.toString(),
                    uniqueKey: `${query}_shard_${shard.min}_${shard.max}`,
                    label: LABELS.SEARCH,
                    userData: {
                        ...commonUserData,
                        checkIn: searchCheckIn,
                        checkOut: searchCheckOut,
                        minPrice: shard.min,
                        maxPrice: shard.max,
                        isShardedRequest: true,
                        shardRange: `${currency} ${shard.min}-${shard.max}`
                    }
                });
            }
        } else {
            // Standard single search request
            const baseUrl = new URL('https://www.airbnb.com/s/' + encodeURIComponent(query) + '/homes');
            baseUrl.searchParams.set('checkin', searchCheckIn!);
            baseUrl.searchParams.set('checkout', searchCheckOut!);

            if (input.adults !== undefined) baseUrl.searchParams.set('adults', input.adults.toString());
            if (input.children !== undefined) baseUrl.searchParams.set('children', input.children.toString());
            if (input.infants !== undefined) baseUrl.searchParams.set('infants', input.infants.toString());
            if (input.pets !== undefined) baseUrl.searchParams.set('pets', input.pets.toString());

            if (input.minPrice !== undefined) baseUrl.searchParams.set('price_min', input.minPrice.toString());
            if (input.maxPrice !== undefined) baseUrl.searchParams.set('price_max', input.maxPrice.toString());
            if (input.minBeds !== undefined) baseUrl.searchParams.set('min_beds', input.minBeds.toString());
            if (input.minBedrooms !== undefined) baseUrl.searchParams.set('min_bedrooms', input.minBedrooms.toString());
            if (input.minBathrooms !== undefined) baseUrl.searchParams.set('min_bathrooms', input.minBathrooms.toString());
            if (currency) baseUrl.searchParams.set('currency', currency);

            // Force nightly price filtering with stable parameters
            baseUrl.searchParams.set('price_filter_input_type', '2');
            baseUrl.searchParams.set('price_filter_num_nights', '1');
            baseUrl.searchParams.set('search_type', 'filter_change');
            baseUrl.searchParams.set('channel', 'EXPLORE');

            startRequests.push({
                url: baseUrl.toString(),
                uniqueKey: baseUrl.toString(),
                label: LABELS.SEARCH,
                userData: {
                    ...commonUserData,
                    checkIn: searchCheckIn,
                    checkOut: searchCheckOut
                }
            });
        }
    }
}

if (startRequests.length === 0) {
    startRequests.push({
        url: 'https://www.airbnb.com/s/Paris/homes',
        uniqueKey: 'FALLBACK_PARIS',
        label: LABELS.SEARCH,
        userData: { ...commonUserData }
    });
}

const activeMode = simpleMode ? 'FAST (Simple)' : 'DETAILED (Deep)';
const addOnStr = [
    addOnReviews ? '+Reviews' : '',
    addOnImages ? '+Images' : '',
    addOnDetails ? '+Details' : '',
    addOnHostDetails ? '+HostDetails' : ''
].filter(Boolean).join(' ');

console.log(`[SCRAPER] Starting | Mode: ${activeMode} ${addOnStr} | URLs: ${startRequests.length} | Limit: ${maxListings === Infinity ? 'unlimited' : maxListings}`);

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    // If maxListings is Infinity, let maxRequestsPerCrawl be undefined (unlimited)
    // Otherwise, budget for: all search pages (startRequests) + detail pages + pagination
    // In deep mode, each listing needs 1 detail page visit, plus search pages to find them
    maxRequestsPerCrawl: maxListings === Infinity ? undefined : Math.max(startRequests.length + maxListings * 2, maxListings * 5),
    maxConcurrency: 100, // Fixed high concurrency for performance
    useSessionPool: true,
    persistCookiesPerSession: true,
    requestHandler: router,
    launchContext: {
        useChrome: true,
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled']
        }
    },
    headless: true,
    navigationTimeoutSecs: 30, // Don't wait forever for pages to load
    requestHandlerTimeoutSecs: 60, // Limit per-request processing time
    preNavigationHooks: [
        async ({ page }, _gotoOptions) => {
            // Force currency cookie
            await page.context().addCookies([{
                name: 'currency',
                value: currency,
                domain: '.airbnb.com',
                path: '/'
            }]);

            // SPEED OPTIMIZATION: Block irrelevant resources aggressively
            // Commented out to reduce bot detection (missing resources can trigger blocks)
            /*
            await page.route('** / *', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'stylesheet', 'font'].includes(type) && !route.request().url().includes('favicon')) {
                    return route.abort();
                }
                return route.continue();
            });
            */
        }
    ],
});

await crawler.run(startRequests);

// Apify automatically saves data pushed via pushData()
// On Apify platform, data is in the default dataset
// Locally, we mirror it to results.json for convenience
const dataset = await Actor.openDataset();
const datasetInfo = await dataset.getInfo();
// Use internal counter for immediate feedback, fallback to dataset info
const localCount = getScrapedCount();
const cloudCount = datasetInfo?.itemCount || 0;
console.log(`[SCRAPER] Done. Total listings scraped: ${Math.max(localCount, cloudCount)}`);

// Local-only: Export to JSON file for easy viewing
if (!Actor.isAtHome()) {
    try {
        await dataset.exportToJSON('results');
        console.log('Results exported to storage/key_value_stores/default/results.json');

        const kvPath = path.join(process.cwd(), 'storage/key_value_stores/default/results.json');
        await new Promise(r => setTimeout(r, 1000));

        if (fs.existsSync(kvPath)) {
            fs.copyFileSync(kvPath, path.join(process.cwd(), 'results.json'));
            console.log('Results also mirrored to ./results.json');

            // Also mirror to storage/datasets/results.json as requested
            const datasetsDir = path.join(process.cwd(), 'storage/datasets');
            if (fs.existsSync(datasetsDir)) {
                fs.copyFileSync(kvPath, path.join(datasetsDir, 'results.json'));
                console.log('Results also mirrored to storage/datasets/results.json');
            }
        }
    } catch (err) {
        console.error(`Failed to export locally: ${err}`);
    }
}

await Actor.exit();

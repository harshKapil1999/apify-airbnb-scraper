export const LABELS = {
    SEARCH: 'SEARCH',
    DETAIL: 'DETAIL',
};

export const BASE_URL = 'https://www.airbnb.com';

export const SELECTORS = {
    SEARCH: {
        listingCard: '[data-testid="card-container"]',
        listingUrl: 'a[href^="/rooms/"]',
        nextPage: '[aria-label="Next"]', // This might change, needs verification
    },
    DETAIL: {
        title: 'h1',
        description: '[data-section-id="DESCRIPTION_DEFAULT"]',
        images: 'img[data-original-uri]', // Placeholder
        price: 'span._tyxjp1', // Placeholder
        amenities: '[data-section-id="AMENITIES_DEFAULT"]',
    },
};

export const DEFAULT_TIMEOUT = 60000;

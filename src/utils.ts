import { Page } from 'playwright';

export async function autoScroll(page: Page) {
    await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

interface SearchOptions {
    checkIn?: string;
    checkOut?: string;
    adults?: number;
    children?: number;
    infants?: number;
    pets?: number;
    minPrice?: number;
    maxPrice?: number;
    currency?: string;
    minBeds?: number;
    minBedrooms?: number;
    minBathrooms?: number;
}


function getDefaultDates() {
    const today = new Date();
    const checkInDate = new Date(today);
    checkInDate.setDate(today.getDate() + 7); // Start 7 days from now

    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkInDate.getDate() + 5); // Stay for 5 days

    return {
        checkIn: checkInDate.toISOString().split('T')[0],
        checkOut: checkOutDate.toISOString().split('T')[0]
    };
}

export function constructSearchUrl(location: string, options: SearchOptions = {}): string {
    const url = new URL('https://www.airbnb.com/s/homes');
    url.searchParams.append('query', location);

    const defaultDates = getDefaultDates();
    const checkIn = options.checkIn || defaultDates.checkIn;
    const checkOut = options.checkOut || defaultDates.checkOut;

    if (checkIn) url.searchParams.append('checkin', checkIn);
    if (checkOut) url.searchParams.append('checkout', checkOut);
    if (options.adults) url.searchParams.append('adults', options.adults.toString());
    if (options.children) url.searchParams.append('children', options.children.toString());
    if (options.infants) url.searchParams.append('infants', options.infants.toString());
    if (options.pets) url.searchParams.append('pets', options.pets.toString());
    if (options.minPrice) url.searchParams.append('price_min', options.minPrice.toString());
    if (options.maxPrice) url.searchParams.append('price_max', options.maxPrice.toString());
    if (options.currency) url.searchParams.append('currency', options.currency);
    if (options.minBeds) url.searchParams.append('min_beds', options.minBeds.toString());
    if (options.minBedrooms) url.searchParams.append('min_bedrooms', options.minBedrooms.toString());
    if (options.minBathrooms) url.searchParams.append('min_bathrooms', options.minBathrooms.toString());

    return url.toString();
}

export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

import { log } from 'crawlee';
export { log };

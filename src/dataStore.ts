// Global store for scraped data
let scrapedListings: any[] = [];

export function addListing(data: any) {
    scrapedListings.push(data);
}

export function getListings() {
    return [...scrapedListings];
}

export function clearListings() {
    scrapedListings = [];
}

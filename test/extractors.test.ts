import { describe, expect, it, vi } from 'vitest';
import { extractListingDetails } from '../src/extractors';

// Mock Page
const mockPage = {
    evaluate: vi.fn(),
    title: vi.fn(),
    url: vi.fn(),
    $: vi.fn(),
} as any;

describe('Airbnb Scraper Extractors', () => {
    it('should extract details from __NEXT_DATA__', async () => {
        const sampleData = {
            props: {
                pageProps: {
                    listing: {
                        id: '123456',
                        name: 'Cozy Apartment',
                        description: 'A beautiful place.',
                        roomType: 'Entire home',
                        p3SummaryTitle: 'Entire rental unit',
                        locationTitle: 'New York, NY',
                        city: 'New York',
                        state: 'NY',
                        countryCode: 'US',
                        lat: 40.7128,
                        lng: -74.0060,
                        neighborhood: 'Manhattan',
                        personCapacity: 2,
                        bedrooms: 1,
                        beds: 1,
                        bathrooms: 1,
                        starRating: 4.8,
                        reviewsCount: 100,
                        primaryHost: {
                            id: 'host123',
                            firstName: 'John',
                            isSuperhost: true
                        },
                        pricingQuote: {
                            structuredStayDisplayPrice: {
                                primaryLine: {
                                    price: '$150',
                                    currency: 'USD'
                                }
                            }
                        },
                        photos: [
                            { large: 'img1.jpg' }
                        ],
                        amenities: [
                            { name: 'Wifi' },
                            { name: 'Kitchen' }
                        ]
                    }
                }
            }
        };

        mockPage.evaluate.mockResolvedValueOnce(sampleData);

        const result = await extractListingDetails(mockPage);

        expect(result.id).toBe('123456');
        expect(result.title).toBe('Cozy Apartment');
        expect(result.description).toBe('A beautiful place.');
        expect(result.location.city).toBe('New York');
        expect(result.capacity.guests).toBe(2);
        expect(result.ratings.overall).toBe(4.8);
        expect(result.host.name).toBe('John');
        expect(result.pricing.basePrice).toBe('$150');
        expect(result.amenities).toEqual(['Wifi', 'Kitchen']);
    });

    it('should fallback to DOM if __NEXT_DATA__ fails', async () => {
        mockPage.evaluate.mockRejectedValueOnce(new Error('Failed')); // Fail __NEXT_DATA__
        mockPage.title.mockResolvedValueOnce('DOM Title');
        mockPage.url.mockReturnValue('https://airbnb.com/rooms/fallback');

        // Mocking json-ld extraction failure to test pure DOM fallback
        mockPage.evaluate.mockResolvedValueOnce(null);

        const result = await extractListingDetails(mockPage);

        expect(result.title).toBe('DOM Title');
        expect(result.url).toBe('https://airbnb.com/rooms/fallback');
    });
});

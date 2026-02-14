# 🏠 Airbnb Scraper: High-Performance Data Extraction

Unlock the full potential of Airbnb data with this state-of-the-art scraper. Designed for scale and speed, it extracts detailed listing information including pricing, host details, amenities, and more.

---

## 🚀 Key Features

- **⚡ High-Speed Sharding**: Automatically splits search queries into granular price brackets to maximize results.
- **🛠️ Customizable Enrichment**: Start with fast search extraction and selectively add deep details (descriptions, amenities, host info, images).
- **🌍 Global Reach**: Supports custom currencies, locales, and precise location-based queries.
- **🛡️ Anti-Block Technology**: Optimized for use with proxies to ensure consistent uptime.

---

## 📊 Extracted Data Fields

The scraper returns a comprehensive JSON object for each listing.

| Category | Fields |
|----------|--------|
| **Core Info** | `listingId`, `url`, `listingTitle`, `roomType`, `scrapedAt` |
| **Pricing** | `price` (amount, currency), `currency` |
| **Capacity** | `personCapacity`, `bedrooms`, `beds`, `bathrooms` |
| **Visuals** | `thumbnail`, `imagesCsv` (High-res URLs) |
| **Ratings** | `rating`, `reviewsCount` |
| **Details** | `listingDescription`, `subDescription`, `amenitiesCsv`, `houseRules` |
| **Host** | `host` (ID, Name, isSuperhost, Profile URL) |
| **Location** | `location` (City/Region), `coordinates` (Lat/Lng), `locale` |

### Example Output

```json
{
  "listingId": "12345678",
  "url": "https://www.airbnb.com/rooms/12345678",
  "listingTitle": "Stylish 1 bed by Tower Bridge",
  "price": {
    "amount": "150",
    "currency": "USD"
  },
  "rating": "4.85",
  "reviewsCount": 120,
  "personCapacity": 2,
  "bedrooms": 1,
  "beds": 1,
  "bathrooms": 1,
  "host": {
    "id": "987654321",
    "name": "Emma",
    "isSuperHost": true
  },
  "location": "London, United Kingdom",
  "amenitiesCsv": "Wifi, Kitchen, Air conditioning, Washer",
  "imagesCsv": "https://a0.muscache.com/im/pictures/..."
}
```

---

## 📥 Input Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `locationQueries` | Array | `["London"]` | Cities or regions to target. |
| `startUrls` | Array | `[]` | Direct URLs to scrape. |
| `checkIn` / `checkOut` | String | - | Dates (YYYY-MM-DD). Imparts accurate pricing. |
| `minPrice` / `maxPrice` | Integer | `0` / `2000` | Price range to scrape. |
| `maxListings` | Integer | `0` (Unlimited) | Stop after N listings. |
| `currency` | String | `USD` | Target currency for pricing. |
| `simpleMode` | Boolean | `true` | Fast mode (search results only). |
| `addOnDetails` | Boolean | `false` | Enrich with full description & rules. |
| `addOnImages` | Boolean | `false` | Enrich with all images. |
| `addOnHostDetails` | Boolean | `false` | Enrich with host profile. |

> **Note**: `proxyConfiguration` is hidden and defaults to using Apify Proxy for best performance.

---

## 💡 Usage Tips

1. **Date Selection**: Providing specific `checkIn` and `checkOut` dates ensures the most accurate nightly rates.
2. **Start Small**: Test with `maxListings: 10` before running larger scrapes.
3. **Price Filtering**: Use `minPrice` and `maxPrice` to narrow down listings and trigger sharding for better coverage.

---

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Run locally
npm start
```

## 💳 Pricing & Credits

- **Efficiency**: Optimized to minimize requests.
- **Cost**: Depends on "Deep Mode" features enabled.
# apify-airbnb-scraper
# apify-airbnb-scraper
# apify-airbnb-scraper
# apify-airbnb-scraper

# API Update: Shopify Integration Enhancement

**Date:** 2026-01-28
**Version:** 2.1.1
**Breaking Change:** No (additive changes, existing endpoints still work)

## Summary

Enhanced Shopify integration with richer product metadata mapping, a new platform availability endpoint, and Shopify API version update to `2026-01`. Product creation now uses Shopify's `productSet` mutation, sending pricing, SKU, barcode, weight, SEO, and metafields in a single API call.

---

## What's New

### 1. Platform Availability Endpoint

New endpoint to check which e-commerce platforms are configured on the backend. Use this to show/hide platform options in your UI.

### 2. Richer Shopify Product Data

Product pushes to Shopify now include significantly more metadata fields:

| Field | Before | After |
|-------|--------|-------|
| title, description, vendor, tags | ✅ | ✅ |
| price, compareAtPrice | ❌ | ✅ |
| sku, barcode | ❌ | ✅ |
| weight (with unit) | ❌ | ✅ |
| SEO title & description | ❌ | ✅ |
| Metafields (materials, color, gender, style) | ❌ | ✅ |

### 3. Shopify API Version Update

Backend now uses Shopify API version `2026-01` (previously `2024-01`). No front-end changes needed.

### 4. Response Schema Fixes

- `GET /api/v1/connections` now includes `lastError` in the response
- `GET /api/v1/listings/:id` now includes `platform` in the response

---

## New Endpoints

### GET /api/v1/platforms/available

Check which OAuth platforms are configured and available for connection. **Requires JWT auth.**

**Response:**
```json
{
  "platforms": [
    { "platform": "shopify", "configured": true, "name": "Shopify" },
    { "platform": "amazon", "configured": false, "name": "Amazon" },
    { "platform": "ebay", "configured": false, "name": "eBay" }
  ]
}
```

---

## Updated Responses

### GET /api/v1/connections

`lastError` field is now included (was returned by the API but missing from schema docs):

```json
{
  "connections": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "platform": "shopify",
      "platformAccountId": "shop-id",
      "status": "active",
      "metadata": { "shop": "mystore.myshopify.com", "shopName": "My Store" },
      "lastError": null,
      "lastUsedAt": "2026-01-28T10:00:00.000Z",
      "createdAt": "2026-01-20T10:00:00.000Z"
    }
  ]
}
```

### GET /api/v1/listings/:id

`platform` field is now included in the response:

```json
{
  "id": "listing-uuid",
  "connectionId": "connection-uuid",
  "jobId": "job-uuid",
  "platform": "shopify",
  "platformProductId": "gid://shopify/Product/123456",
  "status": "completed",
  "metadata": { "productUrl": "https://mystore.myshopify.com/admin/products/123456" },
  "lastError": null,
  "createdAt": "2026-01-28T10:00:00.000Z",
  "updatedAt": "2026-01-28T10:00:00.000Z"
}
```

### POST /api/v1/listings/push — Enhanced Shopify Metadata

When pushing to Shopify, the following product metadata fields are now mapped automatically from your job's `productMetadata`:

```json
{
  "jobId": "job-uuid",
  "connectionId": "shopify-connection-uuid",
  "options": {
    "publishAsDraft": true,
    "overrideMetadata": {
      "title": "Leather Crossbody Bag",
      "description": "<p>Handcrafted Italian leather bag</p>",
      "brand": "Artisan Co.",
      "category": "Bags",
      "tags": ["leather", "crossbody", "handmade"],
      "price": 129.99,
      "compareAtPrice": 159.99,
      "sku": "BAG-001",
      "barcode": "1234567890123",
      "weight": { "value": 1.2, "unit": "lb" },
      "shortDescription": "Handcrafted Italian leather crossbody bag",
      "materials": ["leather", "brass"],
      "color": "Brown",
      "gender": "Women",
      "style": "Casual"
    }
  }
}
```

These fields map to Shopify as follows:

| Metadata Field | Shopify GraphQL Field |
|---|---|
| `title` | `title` |
| `description` | `descriptionHtml` |
| `brand` | `vendor` |
| `category` | `productType` |
| `tags` | `tags` |
| `price` | `variants[0].price` |
| `compareAtPrice` | `variants[0].compareAtPrice` |
| `sku` | `variants[0].sku` |
| `barcode` | `variants[0].barcode` |
| `weight` | `variants[0].inventoryItem.measurement.weight` |
| `shortDescription` | `seo.description` |
| `materials` | `metafields` (namespace: `custom`, key: `materials`) |
| `color` | `metafields` (namespace: `custom`, key: `color`) |
| `gender` | `metafields` (namespace: `custom`, key: `gender`) |
| `style` | `metafields` (namespace: `custom`, key: `style`) |

---

## Integration Guide

### Step 1: Check Platform Availability

Before showing Shopify connection UI, check if the backend has Shopify configured:

**React Native (TypeScript):**
```typescript
interface PlatformInfo {
  platform: 'shopify' | 'amazon' | 'ebay';
  configured: boolean;
  name: string;
}

async function getAvailablePlatforms(): Promise<PlatformInfo[]> {
  const { data } = await client.get<{ platforms: PlatformInfo[] }>(
    '/api/v1/platforms/available'
  );
  return data.platforms;
}

// Usage: only show configured platforms
const platforms = await getAvailablePlatforms();
const configuredPlatforms = platforms.filter(p => p.configured);
```

**Flutter (Dart):**
```dart
class PlatformInfo {
  final String platform;
  final bool configured;
  final String name;

  PlatformInfo({required this.platform, required this.configured, required this.name});

  factory PlatformInfo.fromJson(Map<String, dynamic> json) => PlatformInfo(
    platform: json['platform'] as String,
    configured: json['configured'] as bool,
    name: json['name'] as String,
  );
}

Future<List<PlatformInfo>> getAvailablePlatforms() async {
  final response = await dio.get('/api/v1/platforms/available');
  final platforms = (response.data['platforms'] as List)
      .map((p) => PlatformInfo.fromJson(p))
      .toList();
  return platforms;
}
```

**iOS (Swift):**
```swift
struct PlatformInfo: Decodable {
    let platform: String
    let configured: Bool
    let name: String
}

func getAvailablePlatforms() async throws -> [PlatformInfo] {
    let response: PlatformsResponse = try await vopiClient.get("/api/v1/platforms/available")
    return response.platforms
}
```

**Android (Kotlin):**
```kotlin
data class PlatformInfo(
    val platform: String,
    val configured: Boolean,
    val name: String
)

suspend fun getAvailablePlatforms(): List<PlatformInfo> {
    val response = vopiClient.get<PlatformsResponse>("/api/v1/platforms/available")
    return response.platforms
}
```

### Step 2: Update Connection Models

Add `lastError` to your connection model:

**TypeScript:**
```typescript
export interface PlatformConnection {
  id: string;
  platform: 'shopify' | 'amazon' | 'ebay';
  platformAccountId: string;
  status: 'active' | 'expired' | 'revoked';
  metadata: Record<string, unknown>;
  lastError: string | null;  // NEW
  lastUsedAt: string | null;
  createdAt: string;
}
```

### Step 3: Update Listing Detail Model

Add `platform` to your listing detail model:

**TypeScript:**
```typescript
export interface ListingDetail {
  id: string;
  connectionId: string;
  jobId: string;
  platform: 'shopify' | 'amazon' | 'ebay';  // NEW
  platformProductId: string | null;
  status: 'pending' | 'pushing' | 'completed' | 'failed';
  metadata: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Step 4: Display Connection Errors

Use `lastError` to show connection issues in your UI:

```typescript
function ConnectionCard({ connection }: { connection: PlatformConnection }) {
  return (
    <View>
      <Text>{connection.metadata.shopName || connection.platformAccountId}</Text>
      <StatusBadge status={connection.status} />
      {connection.lastError && (
        <ErrorBanner message={connection.lastError} />
      )}
    </View>
  );
}
```

---

## Important Notes

1. **No breaking changes.** Existing `POST /api/v1/listings/push` calls continue to work. The additional metadata fields are sent automatically from `productMetadata` stored on the job.

2. **Override metadata.** You can override any field via `options.overrideMetadata` in the push request. This is useful for letting users edit title, price, etc. before pushing.

3. **Metafields.** Shopify metafields (materials, color, gender, style) are created under the `custom` namespace. If your Shopify store has metafield definitions set up, these will be filterable in the storefront.

4. **Weight units.** Supported weight units: `g`, `kg`, `oz`, `lb`, `pounds`. Unknown units fall back to `POUNDS`.

5. **SEO.** SEO title and description are only set when `shortDescription` is present in the product metadata. This avoids overriding Shopify's auto-generated SEO data with empty values.

---

## Questions?

If you encounter issues integrating, please open an issue on GitHub.

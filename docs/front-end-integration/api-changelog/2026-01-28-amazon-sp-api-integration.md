# API Update: Amazon SP-API Integration

**Date:** 2026-01-28
**Version:** 2.2.0
**Breaking Change:** No (additive changes, existing endpoints still work)

## Summary

Amazon SP-API is now fully integrated. Users can connect their Amazon Seller Central account via OAuth, and push product listings with images directly to Amazon. The backend uses the `amazon-sp-api` SDK for proper AWS Signature v4 signing and automatic token management.

---

## What's New

### 1. Amazon OAuth Connection

Users can now connect their Amazon Seller Central account. After OAuth, the backend retrieves the seller's real seller ID and marketplace IDs (no more placeholder data).

### 2. Amazon Listing Push

`POST /api/v1/listings/push` now fully supports Amazon connections. Product metadata is mapped to SP-API listing attributes, and images are attached as URL references.

### 3. Amazon Connection Testing

`POST /api/v1/connections/:id/test` now properly verifies Amazon connections using the SP-API (previously only checked the LWA profile endpoint).

---

## Amazon OAuth Flow

### Step 1: Check Platform Availability

```typescript
const { platforms } = await client.get('/api/v1/platforms/available');
const amazonAvailable = platforms.find(p => p.platform === 'amazon')?.configured;
```

### Step 2: Start OAuth

Redirect the user to the Amazon authorize endpoint:

```typescript
// Browser redirect
window.location.href = `${API_BASE}/api/v1/oauth/amazon/authorize`;
```

The user will be redirected to Amazon Seller Central to authorize your app, then back to the OAuth success page.

### Step 3: Verify Connection

After OAuth completes, the connection appears in the user's connections list:

```typescript
const { connections } = await client.get('/api/v1/connections');
const amazonConnection = connections.find(c => c.platform === 'amazon');

// Amazon connection metadata includes:
// {
//   "sellerId": "A1B2C3D4E5F6G7",
//   "marketplaceIds": ["ATVPDKIKX0DER"],
//   "region": "na"
// }
```

---

## Pushing Listings to Amazon

### Request

```json
{
  "jobId": "job-uuid",
  "connectionId": "amazon-connection-uuid",
  "options": {
    "publishAsDraft": false,
    "overrideMetadata": {
      "title": "Premium Leather Wallet",
      "description": "Handcrafted genuine leather bifold wallet with RFID protection",
      "brand": "WalletCo",
      "bulletPoints": [
        "Genuine full-grain leather",
        "RFID blocking technology",
        "Slim bifold design"
      ],
      "price": 49.99,
      "currency": "USD",
      "condition": "new",
      "category": "PRODUCT",
      "sku": "WALLET-001"
    }
  }
}
```

### Metadata Mapping

The following product metadata fields are mapped to Amazon SP-API attributes:

| Metadata Field | Amazon SP-API Attribute | Notes |
|---|---|---|
| `title` | `item_name` | Required |
| `description` | `product_description` | Full product description |
| `brand` | `brand` | Required for most categories |
| `bulletPoints` | `bullet_point` | Up to 5 recommended |
| `price` | `purchasable_offer` | With currency (default: USD) |
| `condition` | `condition_type` | Default: `new_new` |
| `category` | `productType` | Amazon product type (default: `PRODUCT`) |
| `sku` | SKU path parameter | Auto-generated if not provided |

### Image Handling

- Images are attached as URL references in listing attributes (Amazon fetches them)
- Up to 9 images: 1 main image + 8 additional
- Images must be publicly accessible — the backend generates presigned S3 URLs automatically
- Commercial images (AI-processed) are preferred over raw video frames

### Response

```json
{
  "id": "listing-uuid",
  "status": "completed",
  "platformProductId": "WALLET-001",
  "message": "Product pushed successfully"
}
```

**Note:** `platformProductId` for Amazon is the SKU (not an ASIN). Amazon assigns ASINs asynchronously after listing processing.

---

## Updated Models

### PlatformConnection — Amazon Metadata

Update your connection metadata type to handle Amazon-specific fields:

**TypeScript:**
```typescript
interface AmazonConnectionMetadata {
  sellerId: string;          // Amazon seller ID
  marketplaceIds: string[];  // e.g., ["ATVPDKIKX0DER"] for US
  region: string;            // "na", "eu", or "fe"
}

interface ShopifyConnectionMetadata {
  shop: string;
  shopName?: string;
}

// Use a union type for platform-specific metadata
type ConnectionMetadata = AmazonConnectionMetadata | ShopifyConnectionMetadata | Record<string, unknown>;
```

**Flutter (Dart):**
```dart
class AmazonConnectionMetadata {
  final String sellerId;
  final List<String> marketplaceIds;
  final String region;

  AmazonConnectionMetadata({
    required this.sellerId,
    required this.marketplaceIds,
    required this.region,
  });

  factory AmazonConnectionMetadata.fromJson(Map<String, dynamic> json) =>
      AmazonConnectionMetadata(
        sellerId: json['sellerId'] as String,
        marketplaceIds: List<String>.from(json['marketplaceIds']),
        region: json['region'] as String,
      );
}
```

**Swift:**
```swift
struct AmazonConnectionMetadata: Decodable {
    let sellerId: String
    let marketplaceIds: [String]
    let region: String
}
```

**Kotlin:**
```kotlin
data class AmazonConnectionMetadata(
    val sellerId: String,
    val marketplaceIds: List<String>,
    val region: String
)
```

---

## Integration Guide

### Step 1: Add Amazon to Platform Selection UI

Use `GET /api/v1/platforms/available` to check if Amazon is configured, then show it alongside Shopify/eBay:

```typescript
function PlatformSelector({ platforms }: { platforms: PlatformInfo[] }) {
  return (
    <View>
      {platforms.filter(p => p.configured).map(platform => (
        <PlatformButton
          key={platform.platform}
          name={platform.name}
          onPress={() => startOAuth(platform.platform)}
        />
      ))}
    </View>
  );
}
```

### Step 2: Handle Amazon OAuth

Amazon OAuth uses the same flow as Shopify — redirect to authorize endpoint, then the user is redirected back to the success page:

```typescript
function startAmazonOAuth() {
  // Open in browser / WebView
  const authUrl = `${API_BASE}/api/v1/oauth/amazon/authorize`;
  openBrowser(authUrl);
}
```

### Step 3: Display Amazon Connection Info

Show seller ID and marketplace info from connection metadata:

```typescript
function AmazonConnectionCard({ connection }: { connection: PlatformConnection }) {
  const meta = connection.metadata as AmazonConnectionMetadata;
  return (
    <View>
      <Text>Seller ID: {meta.sellerId}</Text>
      <Text>Marketplace: {meta.marketplaceIds.join(', ')}</Text>
      <Text>Region: {meta.region}</Text>
      <StatusBadge status={connection.status} />
    </View>
  );
}
```

### Step 4: Push Listings to Amazon

The push endpoint works the same as Shopify — just use an Amazon connection ID:

```typescript
async function pushToAmazon(jobId: string, connectionId: string, metadata?: Record<string, unknown>) {
  const response = await client.post('/api/v1/listings/push', {
    jobId,
    connectionId,
    options: {
      publishAsDraft: false, // Amazon doesn't support drafts
      overrideMetadata: metadata,
    },
  });
  return response.data;
}
```

---

## Important Notes

1. **No breaking changes.** All existing Shopify and eBay flows continue to work unchanged.

2. **Amazon doesn't support draft listings.** The `publishAsDraft` option is ignored for Amazon — listings go live immediately after Amazon processes them.

3. **SKU is the product identifier.** Amazon uses SKU (not ASIN) as the listing identifier. ASINs are assigned by Amazon asynchronously. The `platformProductId` in the listing response is the SKU.

4. **Image requirements.** Amazon requires images to be at least 1000x1000 pixels for zoom functionality. The commercial images generated by VOPI typically meet this requirement.

5. **Marketplace defaults to US.** If the seller has multiple marketplaces, the default is `ATVPDKIKX0DER` (Amazon.com US). Multi-marketplace support can be added in the future.

6. **Category/product type.** The `category` field maps to Amazon's `productType`. If not specified, it defaults to `PRODUCT`. For better listing placement, use Amazon-specific product types (e.g., `SHIRT`, `LUGGAGE`).

7. **Connection testing.** Use `POST /api/v1/connections/:id/test` to verify the Amazon connection is still valid before pushing. This calls the SP-API to confirm the refresh token works.

---

## Questions?

If you encounter issues integrating, please open an issue on GitHub.

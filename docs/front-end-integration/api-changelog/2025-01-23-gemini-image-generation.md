# API Update: Gemini Image Generation & Product Metadata

**Date:** 2025-01-23
**Version:** 1.2.0
**Breaking Change:** No (additive only)

## Summary

This update includes two major features:

1. **New `full_gemini` pipeline** - Uses Google Gemini for both video analysis and commercial image generation, with AI quality filtering.

2. **Product Metadata in API response** - Completed jobs now include `productMetadata` with AI-extracted product information (title, description, bullet points, etc.) pre-formatted for Shopify, Amazon, and eBay. Front-end apps should display this for user review before e-commerce upload.

When using the `full_gemini` pipeline, commercial images have **different variant names** and pass through an **AI quality filter** that automatically removes low-quality images.

---

## What's New

### 1. New Pipeline Template: `full_gemini`

A streamlined pipeline that uses Gemini for everything:

```
Download → Unified Video Analyzer → Gemini Image Generate → AI Quality Filter → Upload → Complete
```

**Benefits:**
- Single Gemini API for video analysis + image generation
- No external API dependencies (Claid, Stability)
- AI quality filter removes bad images automatically
- Generates 2 variants per selected angle

**Request Example:**

```json
{
  "videoUrl": "https://s3.amazonaws.com/bucket/uploads/uuid.mp4",
  "config": {
    "stackId": "full_gemini"
  }
}
```

### 2. New Commercial Image Variants

When using `full_gemini`, commercial images use **different variant names**:

| Full Gemini Variants | Description |
|---------------------|-------------|
| `white-studio` | Clean white background with professional lighting |
| `lifestyle` | Natural lifestyle setting (bathroom counter, vanity, etc.) |

**Note:** Existing pipelines (`classic`, `gemini_video`, `unified_video_analyzer`) still use the original variants (`transparent`, `solid`, `real`, `creative`).

### 3. AI Quality Filter

Images are automatically filtered to remove:
- Images with hands or body parts
- Blurry or low-quality images
- Images where product doesn't match the original
- Background contamination or artifacts

Only images that pass the filter are included in the job results.

### 4. Product Metadata in Job Response

Completed jobs now include `productMetadata` with extracted product information from audio analysis. This data should be displayed to users for review before uploading to e-commerce platforms.

**Job Response Structure:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "result": { ... },
  "productMetadata": {
    "transcript": "This is a beautiful handmade ceramic vase...",
    "product": {
      "title": "Handmade Ceramic Vase - Blue Floral Pattern",
      "description": "Beautiful handcrafted ceramic vase...",
      "shortDescription": "Handmade ceramic vase with floral design",
      "bulletPoints": [
        "Handcrafted by artisans",
        "Food-safe glaze",
        "Unique floral pattern"
      ],
      "brand": "ArtisanCraft",
      "category": "Home & Garden",
      "materials": ["ceramic"],
      "color": "Blue",
      "keywords": ["vase", "ceramic", "handmade", "floral"],
      "tags": ["handmade", "ceramic", "home-decor"],
      "confidence": {
        "overall": 85,
        "title": 90,
        "description": 80
      },
      "extractedFromAudio": true,
      "transcriptExcerpts": ["handmade ceramic", "beautiful blue color"]
    },
    "platforms": {
      "shopify": {
        "title": "Handmade Ceramic Vase - Blue Floral Pattern",
        "descriptionHtml": "<p>Beautiful handcrafted ceramic vase...</p>",
        "productType": "Home & Garden",
        "vendor": "ArtisanCraft",
        "tags": ["handmade", "ceramic", "home-decor"],
        "status": "DRAFT"
      },
      "amazon": {
        "item_name": "Handmade Ceramic Vase - Blue Floral Pattern",
        "brand_name": "ArtisanCraft",
        "bullet_point": ["Handcrafted by artisans", "Food-safe glaze", "..."],
        "product_description": "Beautiful handcrafted ceramic vase...",
        "generic_keyword": ["vase", "ceramic", "handmade"]
      },
      "ebay": {
        "title": "Handmade Ceramic Vase - Blue Floral Pattern",
        "description": "Beautiful handcrafted ceramic vase...",
        "condition": "NEW",
        "aspects": {
          "Brand": ["ArtisanCraft"],
          "Color": ["Blue"],
          "Material": ["ceramic"]
        }
      }
    },
    "extractedAt": "2025-01-23T10:30:00.000Z",
    "audioDuration": 45.5,
    "pipelineVersion": "1.0.0"
  }
}
```

**Recommended UX Flow:**

1. **Display** - Show extracted product info in an editable form
2. **Edit** - Let users modify any fields (title, description, bullet points, etc.)
3. **Review** - Show confidence scores to help users identify fields that may need attention
4. **Confirm** - User approves final data before e-commerce upload

**Important:** The `productMetadata` is AI-generated and should be treated as a **draft** for user review, not final data. Users should always have the ability to edit all fields before uploading to their e-commerce platform.

**Confidence Scores:** Use `product.confidence.overall`, `product.confidence.title`, etc. to highlight fields with lower confidence that may need user attention. For example, show a warning icon on fields with confidence < 70.

### 5. New API Endpoints for Product Metadata

Two new endpoints for managing product metadata:

#### GET /api/v1/jobs/:id/metadata

Get product metadata for a job.

**Response (200):**
```json
{
  "transcript": "This is a beautiful handmade ceramic vase...",
  "product": { ... },
  "platforms": { "shopify": {...}, "amazon": {...}, "ebay": {...} },
  "extractedAt": "2025-01-23T10:30:00.000Z",
  "audioDuration": 45.5,
  "pipelineVersion": "1.0.0"
}
```

**Error (404):** Job has no product metadata (audio analysis not performed).

#### PATCH /api/v1/jobs/:id/metadata

Update product metadata with user edits. Platform-specific formats (Shopify, Amazon, eBay) are automatically regenerated.

**Request:**
```json
{
  "title": "User Edited Title",
  "description": "User edited description with more details...",
  "bulletPoints": [
    "Updated feature 1",
    "Updated feature 2"
  ],
  "brand": "Updated Brand",
  "price": 29.99,
  "currency": "USD"
}
```

**Editable Fields:**
| Field | Type | Max Length |
|-------|------|------------|
| `title` | string | 500 |
| `description` | string | 10000 |
| `shortDescription` | string | 500 |
| `bulletPoints` | string[] | 10 items, 500 each |
| `brand` | string | 100 |
| `category` | string | 100 |
| `subcategory` | string | 100 |
| `materials` | string[] | 20 items |
| `color` | string | 50 |
| `colors` | string[] | 20 items |
| `size` | string | 50 |
| `sizes` | string[] | 20 items |
| `keywords` | string[] | 50 items |
| `tags` | string[] | 50 items |
| `price` | number | - |
| `currency` | string | 3 (ISO 4217) |
| `sku` | string | 100 |
| `barcode` | string | 50 |
| `condition` | enum | new, refurbished, used, open_box |
| `careInstructions` | string[] | 10 items |
| `warnings` | string[] | 10 items |

**Response (200):** Returns the full updated `productMetadata` with regenerated platform formats.

**Note:** When a field is updated, its confidence score is automatically set to 100 (user-verified).

---

## Download URLs Response (Full Gemini)

When using `full_gemini`, the download-urls response structure is the same, but variant names differ:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 3600,
  "frames": [...],
  "commercialImages": {
    "frame_00123": {
      "white-studio": "https://s3.../...?X-Amz-...",
      "lifestyle": "https://s3.../...?X-Amz-..."
    },
    "frame_00456": {
      "white-studio": "https://s3.../...?X-Amz-...",
      "lifestyle": "https://s3.../...?X-Amz-..."
    }
  }
}
```

---

## Migration Guide (Optional)

If you want to support the `full_gemini` pipeline, update your variant handling:

### Step 1: Update Variant Types

**iOS (Swift):**
```swift
// Add new variants (existing ones still work)
enum CommercialImageVariant: String, Decodable {
    // Existing variants (Stability pipelines)
    case transparent
    case solid
    case real
    case creative

    // New variants (full_gemini pipeline)
    case whiteStudio = "white-studio"
    case lifestyle
}
```

**Android (Kotlin):**
```kotlin
enum class CommercialImageVariant {
    // Existing variants
    @SerializedName("transparent") TRANSPARENT,
    @SerializedName("solid") SOLID,
    @SerializedName("real") REAL,
    @SerializedName("creative") CREATIVE,

    // New variants (full_gemini)
    @SerializedName("white-studio") WHITE_STUDIO,
    @SerializedName("lifestyle") LIFESTYLE,
}
```

**React Native (TypeScript):**
```typescript
// All possible variants across pipelines
export type CommercialImageVariant =
  // Stability pipeline variants
  | 'transparent'
  | 'solid'
  | 'real'
  | 'creative'
  // Gemini pipeline variants
  | 'white-studio'
  | 'lifestyle';
```

**Flutter (Dart):**
```dart
enum CommercialImageVariant {
  // Existing variants
  @JsonValue('transparent')
  transparent,
  @JsonValue('solid')
  solid,
  @JsonValue('real')
  real,
  @JsonValue('creative')
  creative,

  // New variants (full_gemini)
  @JsonValue('white-studio')
  whiteStudio,
  @JsonValue('lifestyle')
  lifestyle,
}
```

### Step 2: Add Product Metadata Models

**React Native (TypeScript):**
```typescript
export interface MetadataConfidence {
  overall: number;
  title: number;
  description: number;
  price?: number;
  attributes?: number;
}

export interface ProductMetadata {
  title: string;
  description: string;
  shortDescription?: string;
  bulletPoints: string[];
  brand?: string;
  category?: string;
  materials?: string[];
  color?: string;
  keywords?: string[];
  tags?: string[];
  confidence: MetadataConfidence;
  extractedFromAudio: boolean;
  transcriptExcerpts?: string[];
}

export interface ShopifyProductInput {
  title: string;
  descriptionHtml: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
}

export interface AmazonListingInput {
  item_name: string;
  brand_name?: string;
  bullet_point?: string[];
  product_description?: string;
  generic_keyword?: string[];
}

export interface EbayListingInput {
  title: string;
  description: string;
  condition: string;
  aspects?: Record<string, string[]>;
}

export interface ProductMetadataResponse {
  transcript: string;
  product: ProductMetadata;
  platforms: {
    shopify: ShopifyProductInput;
    amazon: AmazonListingInput;
    ebay: EbayListingInput;
  };
  extractedAt: string;
  audioDuration?: number;
  pipelineVersion: string;
}

// Access from job response
interface Job {
  id: string;
  status: string;
  result?: JobResult;
  productMetadata?: ProductMetadataResponse;  // NEW
  // ...
}
```

**iOS (Swift):**
```swift
struct MetadataConfidence: Decodable {
    let overall: Int
    let title: Int
    let description: Int
    let price: Int?
    let attributes: Int?
}

struct ProductMetadata: Decodable {
    let title: String
    let description: String
    let shortDescription: String?
    let bulletPoints: [String]
    let brand: String?
    let category: String?
    let materials: [String]?
    let color: String?
    let keywords: [String]?
    let tags: [String]?
    let confidence: MetadataConfidence
    let extractedFromAudio: Bool
    let transcriptExcerpts: [String]?
}

struct ProductMetadataResponse: Decodable {
    let transcript: String
    let product: ProductMetadata
    let platforms: PlatformFormats
    let extractedAt: String
    let audioDuration: Double?
    let pipelineVersion: String
}

struct PlatformFormats: Decodable {
    let shopify: ShopifyProductInput
    let amazon: AmazonListingInput
    let ebay: EbayListingInput
}

// Update Job model
struct Job: Decodable {
    let id: String
    let status: String
    let result: JobResult?
    let productMetadata: ProductMetadataResponse?  // NEW
    // ...
}
```

**Android (Kotlin):**
```kotlin
data class MetadataConfidence(
    val overall: Int,
    val title: Int,
    val description: Int,
    val price: Int? = null,
    val attributes: Int? = null
)

data class ProductMetadata(
    val title: String,
    val description: String,
    val shortDescription: String? = null,
    val bulletPoints: List<String>,
    val brand: String? = null,
    val category: String? = null,
    val materials: List<String>? = null,
    val color: String? = null,
    val keywords: List<String>? = null,
    val tags: List<String>? = null,
    val confidence: MetadataConfidence,
    val extractedFromAudio: Boolean,
    val transcriptExcerpts: List<String>? = null
)

data class ProductMetadataResponse(
    val transcript: String,
    val product: ProductMetadata,
    val platforms: PlatformFormats,
    val extractedAt: String,
    val audioDuration: Double? = null,
    val pipelineVersion: String
)

// Update Job model
data class Job(
    val id: String,
    val status: String,
    val result: JobResult? = null,
    val productMetadata: ProductMetadataResponse? = null  // NEW
)
```

### Step 3: Add API Methods for Metadata

**React Native (TypeScript):**
```typescript
// Get product metadata
async getProductMetadata(jobId: string): Promise<ProductMetadataResponse> {
  const { data } = await this.client.get<ProductMetadataResponse>(
    `/api/v1/jobs/${jobId}/metadata`
  );
  return data;
}

// Update product metadata (user edits)
async updateProductMetadata(
  jobId: string,
  updates: Partial<ProductMetadata>
): Promise<ProductMetadataResponse> {
  const { data } = await this.client.patch<ProductMetadataResponse>(
    `/api/v1/jobs/${jobId}/metadata`,
    updates
  );
  return data;
}
```

**iOS (Swift):**
```swift
func getProductMetadata(jobId: String) async throws -> ProductMetadataResponse {
    return try await request(path: "/api/v1/jobs/\(jobId)/metadata")
}

func updateProductMetadata(jobId: String, updates: [String: Any]) async throws -> ProductMetadataResponse {
    return try await request(
        path: "/api/v1/jobs/\(jobId)/metadata",
        method: "PATCH",
        body: updates
    )
}
```

**Android (Kotlin):**
```kotlin
@GET("api/v1/jobs/{id}/metadata")
suspend fun getProductMetadata(@Path("id") jobId: String): Response<ProductMetadataResponse>

@PATCH("api/v1/jobs/{id}/metadata")
suspend fun updateProductMetadata(
    @Path("id") jobId: String,
    @Body updates: Map<String, Any>
): Response<ProductMetadataResponse>
```

### Step 4: Handle Dynamic Variants (Recommended Approach)

Since different pipelines return different variants, handle them dynamically:

**React Native (TypeScript):**
```typescript
// Don't hardcode variants - iterate over what's returned
const downloadUrls = await vopiClient.getDownloadUrls(jobId);

for (const [frameId, variants] of Object.entries(downloadUrls.commercialImages)) {
  for (const [variantName, url] of Object.entries(variants)) {
    console.log(`Frame ${frameId} - ${variantName}: ${url}`);
    // Display based on variant name
  }
}
```

**iOS (Swift):**
```swift
// Handle variants dynamically
let urls = try await getDownloadUrls(jobId: jobId)

for (frameId, variants) in urls.commercialImages {
    for (variantName, url) in variants {
        print("Frame \(frameId) - \(variantName): \(url)")
    }
}
```

---

## Important Notes

1. **No Breaking Changes:** Existing pipelines (`classic`, `gemini_video`, etc.) continue to work exactly as before with the original variant names.

2. **API Key Requirements:** The `full_gemini` pipeline requires a Google AI API key with access to `gemini-2.0-flash-exp` (image generation capability).

3. **Fewer Images:** The AI quality filter may return fewer commercial images than requested, as it removes low-quality results. This is intentional.

4. **Quality Over Quantity:** The `full_gemini` pipeline prioritizes image quality through AI filtering rather than generating all possible variants.

5. **S3 Path:** Images from `full_gemini` that pass the filter are stored under `agent-filtered/` in S3, not `commercial/`.

---

## Questions?

If you encounter issues, please open an issue on GitHub.

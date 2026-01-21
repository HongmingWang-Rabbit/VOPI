# API Update: Private S3 Bucket & Presigned Download URLs

**Date:** 2025-01-20
**Version:** 1.1.0
**Breaking Change:** Yes

## Summary

The S3 storage bucket is now **private** for improved security. Direct URLs in job results are no longer publicly accessible. Clients must use the new `/jobs/:id/download-urls` endpoint to get time-limited presigned URLs.

---

## Breaking Changes

### 1. S3 Bucket Access Changed to Private

**Before:** URLs in `job.result.finalFrames` and `job.result.commercialImages` were publicly accessible.

**After:** These URLs return `403 Forbidden`. You must use the new endpoint to get presigned URLs.

### 2. New Job Status: `extracting_product`

A new pipeline step has been added between `classifying` and `generating`.

**Before:**
```
pending → downloading → extracting → scoring → classifying → generating → completed
```

**After:**
```
pending → downloading → extracting → scoring → classifying → extracting_product → generating → completed
```

---

## New Endpoint

### GET /api/v1/jobs/:id/download-urls

Returns presigned URLs for all job assets (frames and commercial images).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `expiresIn` | number | 3600 | URL expiration in seconds (60-86400) |

**Response:**

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 3600,
  "frames": [
    {
      "frameId": "frame_00123",
      "downloadUrl": "https://s3.../jobs/.../frames/...?X-Amz-..."
    }
  ],
  "commercialImages": {
    "product_1_variant_hero": {
      "transparent": "https://s3.../jobs/.../commercial/...?X-Amz-...",
      "solid": "https://s3.../jobs/.../commercial/...?X-Amz-...",
      "real": "https://s3.../jobs/.../commercial/...?X-Amz-...",
      "creative": "https://s3.../jobs/.../commercial/...?X-Amz-..."
    }
  }
}
```

**Error Response (job not complete):**

```json
{
  "error": "BAD_REQUEST",
  "message": "Job has no results yet. Wait for job to complete."
}
```

---

## Migration Guide

### Step 1: Add New Status to Enum

**iOS (Swift):**
```swift
enum JobStatusType: String, Decodable {
    // ... existing cases
    case extractingProduct = "extracting_product"
    // ...
}
```

**Android (Kotlin):**
```kotlin
enum class JobStatusType {
    // ... existing values
    @SerializedName("extracting_product") EXTRACTING_PRODUCT,
    // ...
}
```

**React Native (TypeScript):**
```typescript
export type JobStatusType =
  | 'pending'
  | 'downloading'
  | 'extracting'
  | 'scoring'
  | 'classifying'
  | 'extracting_product'  // NEW
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

**Flutter (Dart):**
```dart
enum JobStatusType {
  // ... existing values
  @JsonValue('extracting_product')
  extractingProduct,
  // ...
}
```

### Step 2: Add Download URLs Model

**iOS (Swift):**
```swift
struct DownloadUrlsResponse: Decodable {
    let jobId: String
    let expiresIn: Int
    let frames: [FrameDownload]
    let commercialImages: [String: [String: String]]
}

struct FrameDownload: Decodable {
    let frameId: String
    let downloadUrl: String
}
```

**Android (Kotlin):**
```kotlin
data class DownloadUrlsResponse(
    val jobId: String,
    val expiresIn: Int,
    val frames: List<FrameDownload>,
    val commercialImages: Map<String, Map<String, String>>
)

data class FrameDownload(
    val frameId: String,
    val downloadUrl: String
)
```

**React Native (TypeScript):**
```typescript
export interface DownloadUrlsResponse {
  jobId: string;
  expiresIn: number;
  frames: Array<{
    frameId: string;
    downloadUrl: string;
  }>;
  commercialImages: Record<string, Record<string, string>>;
}
```

**Flutter (Dart):**
```dart
@freezed
class DownloadUrlsResponse with _$DownloadUrlsResponse {
  const factory DownloadUrlsResponse({
    required String jobId,
    required int expiresIn,
    required List<FrameDownload> frames,
    required Map<String, Map<String, String>> commercialImages,
  }) = _DownloadUrlsResponse;

  factory DownloadUrlsResponse.fromJson(Map<String, dynamic> json) =>
      _$DownloadUrlsResponseFromJson(json);
}
```

### Step 3: Add API Method

**iOS (Swift):**
```swift
func getDownloadUrls(jobId: String, expiresIn: Int = 3600) async throws -> DownloadUrlsResponse {
    return try await request(path: "/api/v1/jobs/\(jobId)/download-urls?expiresIn=\(expiresIn)")
}
```

**Android (Kotlin):**
```kotlin
@GET("api/v1/jobs/{id}/download-urls")
suspend fun getDownloadUrls(
    @Path("id") jobId: String,
    @Query("expiresIn") expiresIn: Int = 3600
): Response<DownloadUrlsResponse>
```

**React Native (TypeScript):**
```typescript
async getDownloadUrls(jobId: string, expiresIn = 3600): Promise<DownloadUrlsResponse> {
  const { data } = await this.client.get<DownloadUrlsResponse>(
    `/api/v1/jobs/${jobId}/download-urls`,
    { params: { expiresIn } }
  );
  return data;
}
```

**Flutter (Dart):**
```dart
Future<DownloadUrlsResponse> getDownloadUrls(String jobId, {int expiresIn = 3600}) async {
  final response = await _dio.get(
    '/api/v1/jobs/$jobId/download-urls',
    queryParameters: {'expiresIn': expiresIn},
  );
  return DownloadUrlsResponse.fromJson(response.data);
}
```

### Step 4: Update Results Fetching

Replace `getGroupedImages()` with `getDownloadUrls()` when fetching completed job results:

**Before:**
```typescript
const images = await vopiClient.getGroupedImages(jobId);
```

**After:**
```typescript
const downloadUrls = await vopiClient.getDownloadUrls(jobId);
const images = downloadUrls.commercialImages;  // Use presigned URLs
```

---

## Important Notes

1. **URL Expiration:** Presigned URLs expire after `expiresIn` seconds (default: 1 hour). Generate new URLs if they expire before download completes.

2. **Caching:** Be careful with caching presigned URLs - they contain time-sensitive tokens.

3. **Parallel Generation:** The endpoint generates all presigned URLs in parallel for performance.

4. **Pipeline Steps:** The total pipeline steps increased from 6 to 7.

---

## Questions?

If you encounter issues migrating, please open an issue on GitHub.

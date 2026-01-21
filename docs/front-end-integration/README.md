# Mobile Front-End Integration Guide

This guide covers integrating VOPI (Video Object Processing Infrastructure) into mobile applications. VOPI extracts high-quality product photography frames from videos and generates commercial images.

> **Important: Check API Changelog**
>
> Before integrating or upgrading, review the [API Changelog](./api-changelog/) for breaking changes and migration guides.

## Quick Start

### Integration Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Mobile App    │     │   VOPI API      │     │   S3 Storage    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │  1. Get presigned URL │                       │
         │──────────────────────>│                       │
         │                       │                       │
         │  Return upload URL    │                       │
         │<──────────────────────│                       │
         │                       │                       │
         │  2. Upload video directly to S3              │
         │─────────────────────────────────────────────>│
         │                       │                       │
         │  3. Create job with publicUrl                │
         │──────────────────────>│                       │
         │                       │                       │
         │  Return job ID        │                       │
         │<──────────────────────│                       │
         │                       │                       │
         │  4. Poll status OR receive webhook           │
         │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│                       │
         │                       │                       │
         │  5. Get download URLs (presigned)            │
         │──────────────────────>│                       │
         │                       │                       │
         │  Return presigned URLs│                       │
         │<──────────────────────│                       │
         │                       │                       │
         │  6. Download images using presigned URLs     │
         │─────────────────────────────────────────────>│
```

> **Note:** The S3 bucket is private. Direct URLs in job results are not accessible. Use the `/jobs/:id/download-urls` endpoint to get time-limited presigned URLs.

## Authentication

All API requests require an API key passed via the `x-api-key` header:

```
x-api-key: your-api-key-here
```

## Base URL

Configure your base URL based on environment:

| Environment | Base URL |
|-------------|----------|
| Development | `http://localhost:3000` |
| Staging | `https://staging-api.your-domain.com` |
| Production | `https://api.your-domain.com` |

## Core Endpoints

### 1. Get Presigned Upload URL

**Endpoint:** `POST /api/v1/uploads/presign`

Request a presigned URL for direct video upload to S3.

**Request:**
```json
{
  "filename": "product-video.mp4",
  "contentType": "video/mp4",
  "expiresIn": 3600
}
```

**Response:**
```json
{
  "uploadUrl": "https://s3.amazonaws.com/bucket/uploads/uuid.mp4?X-Amz-...",
  "key": "uploads/uuid.mp4",
  "publicUrl": "https://s3.amazonaws.com/bucket/uploads/uuid.mp4",
  "expiresIn": 3600
}
```

### 2. Upload Video to S3

Upload directly to S3 using the presigned URL with a `PUT` request.

**Headers:**
```
Content-Type: video/mp4
```

### 3. Create Processing Job

**Endpoint:** `POST /api/v1/jobs`

**Request:**
```json
{
  "videoUrl": "https://s3.amazonaws.com/bucket/uploads/uuid.mp4",
  "config": {
    "fps": 10,
    "batchSize": 30,
    "commercialVersions": ["transparent", "solid", "real", "creative"],
    "aiCleanup": true
  },
  "callbackUrl": "https://your-server.com/webhook"
}
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "videoUrl": "...",
  "config": {...},
  "createdAt": "2025-01-19T10:00:00.000Z"
}
```

### 4. Poll Job Status

**Endpoint:** `GET /api/v1/jobs/:id/status`

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "classifying",
  "progress": {
    "step": "classifying",
    "percentage": 55,
    "message": "Processing batch 2/4",
    "totalSteps": 7,
    "currentStep": 4
  }
}
```

### 5. Get Download URLs (Required)

**Endpoint:** `GET /api/v1/jobs/:id/download-urls`

Get presigned URLs for accessing job assets. Required because S3 bucket is private.

**Query Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `expiresIn` | 3600 | URL expiration in seconds (60-86400) |

**Response:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 3600,
  "frames": [
    {
      "frameId": "frame_00123",
      "downloadUrl": "https://s3.../...?X-Amz-..."
    }
  ],
  "commercialImages": {
    "product_1_variant_hero": {
      "transparent": "https://s3.../...?X-Amz-...",
      "solid": "https://s3.../...?X-Amz-...",
      "real": "https://s3.../...?X-Amz-...",
      "creative": "https://s3.../...?X-Amz-..."
    }
  }
}
```

### 6. Get Full Job Details (Optional)

**Endpoint:** `GET /api/v1/jobs/:id`

Returns full job details including config, progress, and result metadata.

**Note:** The URLs in `job.result.commercialImages` are direct S3 URLs that are **not accessible**. Always use the download-urls endpoint for actual image access.

## Job Status Values

| Status | Description |
|--------|-------------|
| `pending` | Job created, waiting to be processed |
| `downloading` | Downloading video from source |
| `extracting` | Extracting frames from video |
| `scoring` | Calculating frame quality scores |
| `classifying` | AI classification of frames |
| `extracting_product` | Extracting and centering product |
| `generating` | Generating commercial images |
| `completed` | Job finished successfully |
| `failed` | Job failed with error |
| `cancelled` | Job was cancelled |

## Commercial Image Versions

| Version | Description |
|---------|-------------|
| `transparent` | PNG with transparent background |
| `solid` | AI-recommended solid color background |
| `real` | Realistic lifestyle setting |
| `creative` | Artistic/promotional style |

## Supported Video Formats

| Format | MIME Type |
|--------|-----------|
| MP4 | `video/mp4` |
| MOV | `video/quicktime` |
| WebM | `video/webm` |

## Error Handling

All errors follow this format:

```json
{
  "error": "Error message",
  "statusCode": 400,
  "details": {}
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing or invalid API key |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

## Platform-Specific Guides

- [iOS/Swift Integration](./ios-integration.md)
- [Android/Kotlin Integration](./android-integration.md)
- [React Native Integration](./react-native-integration.md)
- [Flutter/Dart Integration](./flutter-integration.md)
- [API Changelog](./api-changelog/) - Breaking changes and migration guides

## Best Practices

### Video Upload

1. **Validate video before upload**: Check file size, format, and duration on the client
2. **Show upload progress**: Use multipart upload progress callbacks
3. **Handle network interruptions**: Implement retry logic for uploads
4. **Compress if needed**: Consider client-side compression for large videos

### Job Processing

1. **Use webhooks when possible**: More efficient than polling
2. **Poll at reasonable intervals**: 3-5 seconds is recommended
3. **Implement exponential backoff**: For retries on transient failures
4. **Cache results**: Store completed job results locally

### UX Recommendations

1. **Show progress indicators**: Display current step and percentage
2. **Provide cancel option**: Allow users to cancel pending jobs
3. **Handle background processing**: Support app backgrounding during upload/processing
4. **Display intermediate results**: Show frames as they become available

## Rate Limits

While the API doesn't enforce rate limits directly, external AI services have their own limits. Recommended limits:

- Max concurrent jobs per user: 3
- Max video duration: 5 minutes
- Max video file size: 500 MB
- Min polling interval: 3 seconds

---

## For Maintainers: Updating Documentation

When making API changes that affect front-end clients, follow these steps:

### 1. Create a Changelog Entry

Create a new file in `docs/front-end-integration/api-changelog/` with the format:

```
YYYY-MM-DD-short-description.md
```

Example: `2025-01-20-private-bucket-presigned-urls.md`

### 2. Changelog Content

Each changelog should include:

- **Date and Version** - When the change was made
- **Breaking Change indicator** - Yes/No
- **Summary** - Brief description
- **Breaking Changes** - What will break if not updated
- **New Endpoints** - Full request/response examples
- **Migration Guide** - Code examples for each platform (iOS, Android, React Native, Flutter)
- **Important Notes** - Caveats and best practices

### 3. Update Platform Guides

Update all four platform-specific guides:

- `ios-integration.md`
- `android-integration.md`
- `react-native-integration.md`
- `flutter-integration.md`

Changes typically include:
- New status values in enums
- New API methods
- New model/type definitions
- Updated result handling code

### 4. Update This README

- Add new endpoints to the Core Endpoints section
- Update status values table if changed
- Update the integration flow diagram if needed

### 5. Update Changelog Index

Add the new entry to `api-changelog/README.md` index table.

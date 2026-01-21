# API Reference

## Base URL

```
http://localhost:3000
```

## Authentication

All `/api/v1/*` endpoints require an API key via the `x-api-key` header.

```bash
curl -H "x-api-key: your-api-key" http://localhost:3000/api/v1/jobs
```

### API Key Sources

API keys can come from two sources (checked in order):

1. **Database** (recommended) - Keys stored in the `api_keys` table with usage tracking
2. **Environment variable** (fallback) - Keys in `API_KEYS` env var (comma-separated, no usage tracking)

### Database API Keys

Database-stored keys support:
- **Usage limits**: Each key has a `max_uses` limit (default: 10)
- **Usage tracking**: Each job creation increments `used_count`
- **Expiration**: Optional `expires_at` timestamp
- **Revocation**: Soft delete via `revoked_at` timestamp

Manage keys via CLI:
```bash
pnpm keys create --name "John's Beta Access" --max-uses 20
pnpm keys list
pnpm keys revoke <key-id>
```

See [CLI Commands](#cli-commands) for full documentation.

## Interactive Documentation

Swagger UI is available at `/docs` when the server is running.

---

## Health Endpoints

### GET /health

Liveness check - returns immediately if the server is running.

**Response** `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2025-01-19T10:00:00.000Z"
}
```

### GET /ready

Readiness check - verifies database and Redis connections.

**Response** `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2025-01-19T10:00:00.000Z",
  "services": {
    "database": "ok",
    "redis": "ok"
  }
}
```

**Response** `503 Service Unavailable`
```json
{
  "status": "error",
  "services": {
    "database": "error",
    "redis": "ok"
  }
}
```

---

## Jobs Endpoints

### POST /api/v1/jobs

Create a new processing job.

**Request Body**
```json
{
  "videoUrl": "https://example.com/product-video.mp4",
  "config": {
    "fps": 10,
    "batchSize": 30,
    "commercialVersions": ["transparent", "solid", "real", "creative"],
    "aiCleanup": true,
    "geminiModel": "gemini-2.0-flash"
  },
  "callbackUrl": "https://your-server.com/webhook"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `videoUrl` | string (URL) | Yes | - | Video source URL (HTTP, HTTPS, or S3) |
| `config.fps` | number | No | 10 | Frame extraction rate (1-30) |
| `config.batchSize` | number | No | 30 | Frames per Gemini batch (1-100) |
| `config.commercialVersions` | array | No | all four | Which commercial versions to generate |
| `config.aiCleanup` | boolean | No | true | Use AI to remove obstructions |
| `config.geminiModel` | string | No | gemini-2.0-flash | Gemini model for classification |
| `callbackUrl` | string (URL) | No | - | Webhook URL for completion notification |

**Commercial Versions**
- `transparent` - PNG with transparent background
- `solid` - AI-recommended solid color background
- `real` - Realistic lifestyle setting
- `creative` - Artistic/promotional style

**Response** `201 Created`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "videoUrl": "https://example.com/product-video.mp4",
  "config": {
    "fps": 10,
    "batchSize": 30,
    "commercialVersions": ["transparent", "solid", "real", "creative"],
    "aiCleanup": true,
    "geminiModel": "gemini-2.0-flash"
  },
  "createdAt": "2025-01-19T10:00:00.000Z"
}
```

---

### GET /api/v1/jobs

List all jobs with optional filtering.

**Query Parameters**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | Filter by status |
| `limit` | number | 20 | Results per page (1-100) |
| `offset` | number | 0 | Pagination offset |

**Status Values**: `pending`, `downloading`, `extracting`, `scoring`, `classifying`, `extracting_product`, `generating`, `completed`, `failed`, `cancelled`

**Response** `200 OK`
```json
{
  "jobs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "completed",
      "videoUrl": "https://example.com/video.mp4",
      "progress": {
        "step": "completed",
        "percentage": 100,
        "message": "Pipeline completed"
      },
      "createdAt": "2025-01-19T10:00:00.000Z",
      "updatedAt": "2025-01-19T10:05:00.000Z"
    }
  ],
  "total": 1
}
```

---

### GET /api/v1/jobs/:id

Get detailed information about a specific job.

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "videoUrl": "https://example.com/video.mp4",
  "config": {
    "fps": 10,
    "batchSize": 30,
    "commercialVersions": ["transparent", "solid", "real", "creative"],
    "aiCleanup": true,
    "geminiModel": "gemini-2.0-flash"
  },
  "progress": {
    "step": "completed",
    "percentage": 100,
    "message": "Pipeline completed",
    "totalSteps": 6,
    "currentStep": 6
  },
  "result": {
    "variantsDiscovered": 3,
    "framesAnalyzed": 45,
    "finalFrames": [
      "https://s3.amazonaws.com/bucket/jobs/{id}/frames/hero_frame_00123_t4.50.png"
    ],
    "commercialImages": {
      "hero": {
        "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_transparent.png",
        "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_solid.png",
        "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_real.png",
        "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_creative.png"
      }
    }
  },
  "error": null,
  "createdAt": "2025-01-19T10:00:00.000Z",
  "updatedAt": "2025-01-19T10:05:00.000Z",
  "startedAt": "2025-01-19T10:00:01.000Z",
  "completedAt": "2025-01-19T10:05:00.000Z"
}
```

**Response** `404 Not Found`
```json
{
  "error": "Job not found",
  "statusCode": 404
}
```

---

### GET /api/v1/jobs/:id/status

Lightweight endpoint for polling job status.

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "classifying",
  "progress": {
    "step": "classifying",
    "percentage": 55,
    "message": "Processing batch 2/4",
    "totalSteps": 6,
    "currentStep": 4
  },
  "createdAt": "2025-01-19T10:00:00.000Z",
  "updatedAt": "2025-01-19T10:02:30.000Z"
}
```

---

### DELETE /api/v1/jobs/:id

Cancel a pending job. Uses atomic update to prevent race conditions.

**Note**: Only jobs with `pending` status can be cancelled. Jobs that have already started processing cannot be cancelled.

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "cancelled",
  "message": "Job cancelled successfully"
}
```

**Response** `400 Bad Request` (job already processing)
```json
{
  "error": "Job cannot be cancelled - status is not pending",
  "statusCode": 400
}
```

---

### GET /api/v1/jobs/:id/download-urls

Get presigned download URLs for job assets. Since the S3 bucket is private, this endpoint generates time-limited presigned URLs for secure access to frames and commercial images.

**Query Parameters**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `expiresIn` | number | 3600 | URL expiration in seconds (60-86400) |

**Response** `200 OK`
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 3600,
  "frames": [
    {
      "frameId": "frame_00123",
      "downloadUrl": "https://s3.amazonaws.com/bucket/jobs/{id}/frames/...?X-Amz-..."
    }
  ],
  "commercialImages": {
    "product_1_variant_hero": {
      "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-...",
      "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-...",
      "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-...",
      "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-..."
    }
  }
}
```

**Response** `400 Bad Request` (job not complete)
```json
{
  "error": "BAD_REQUEST",
  "message": "Job has no results yet. Wait for job to complete."
}
```

**Usage Notes**:
- Presigned URLs are time-limited and include authentication tokens
- URLs work from any client (browser, mobile app, curl)
- Generate new URLs if they expire before download completes
- URLs are generated in parallel for performance

---

## Upload Endpoints

### POST /api/v1/uploads/presign

Get a presigned URL for uploading a video directly to S3. This is the recommended way for mobile apps to upload videos.

**Request Body**
```json
{
  "filename": "product-video.mp4",
  "contentType": "video/mp4",
  "expiresIn": 3600
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `filename` | string | No | - | Original filename (max 255 chars, used to detect extension) |
| `contentType` | string | No | video/mp4 | MIME type: `video/mp4`, `video/quicktime`, or `video/webm` |
| `expiresIn` | number | No | 3600 | Presigned URL expiration in seconds (60-86400, i.e., 1 min to 24 hours) |

**Response** `200 OK`
```json
{
  "uploadUrl": "https://s3.amazonaws.com/bucket/uploads/550e8400-e29b-41d4-a716-446655440000.mp4?X-Amz-...",
  "key": "uploads/550e8400-e29b-41d4-a716-446655440000.mp4",
  "publicUrl": "https://s3.amazonaws.com/bucket/uploads/550e8400-e29b-41d4-a716-446655440000.mp4",
  "expiresIn": 3600
}
```

**Usage Flow**:
1. Call this endpoint to get a presigned upload URL
2. Upload the video directly to S3 using a PUT request to `uploadUrl`
3. Create a job using the `publicUrl` as the `videoUrl`
4. After job completion, the uploaded video is automatically deleted from S3

**Example (with curl)**:
```bash
# Step 1: Get presigned URL
UPLOAD_INFO=$(curl -s -X POST http://localhost:3000/api/v1/uploads/presign \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{"filename": "video.mp4"}')

UPLOAD_URL=$(echo $UPLOAD_INFO | jq -r '.uploadUrl')
PUBLIC_URL=$(echo $UPLOAD_INFO | jq -r '.publicUrl')

# Step 2: Upload video to S3
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: video/mp4" \
  --data-binary @video.mp4

# Step 3: Create job with the video URL
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d "{\"videoUrl\": \"$PUBLIC_URL\"}"
```

---

## Results Endpoints

### GET /api/v1/jobs/:id/video

Get video metadata for a completed job.

**Response** `200 OK`
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "sourceUrl": "https://example.com/video.mp4",
  "duration": 30.5,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "codec": "h264",
  "metadata": {
    "duration": 30.5,
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "codec": "h264",
    "filename": "video.mp4"
  },
  "createdAt": "2025-01-19T10:00:00.000Z"
}
```

---

### GET /api/v1/jobs/:id/frames

Get all extracted frames for a job.

**Response** `200 OK`
```json
[
  {
    "id": "770e8400-e29b-41d4-a716-446655440001",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "videoId": "660e8400-e29b-41d4-a716-446655440001",
    "frameId": "frame_00001",
    "timestamp": 0.1,
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/frames/frame_00001.png",
    "scores": {
      "sharpness": 1250.5,
      "motion": 0.02,
      "combined": 1245.4
    },
    "productId": null,
    "variantId": null,
    "angleEstimate": null,
    "isBestPerSecond": true,
    "isFinalSelection": false,
    "createdAt": "2025-01-19T10:00:05.000Z"
  }
]
```

---

### GET /api/v1/jobs/:id/frames/final

Get only the final selected frames (AI-classified variants).

**Response** `200 OK`
```json
[
  {
    "id": "770e8400-e29b-41d4-a716-446655440123",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "frameId": "frame_00123",
    "timestamp": 4.5,
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/frames/hero_frame_00123_t4.50.png",
    "productId": "product_1",
    "variantId": "variant_hero",
    "angleEstimate": "front",
    "variantDescription": "Primary product shot, white color variant",
    "obstructions": {
      "has_obstruction": false,
      "obstruction_types": [],
      "obstruction_description": null,
      "removable_by_ai": false
    },
    "backgroundRecommendations": {
      "solid_color": "#F5F5F5",
      "solid_color_name": "Light Gray",
      "real_life_setting": "Modern minimalist desk setup",
      "creative_shot": "Floating with soft shadows"
    },
    "createdAt": "2025-01-19T10:02:00.000Z"
  }
]
```

---

### GET /api/v1/jobs/:id/images

Get all commercial images for a job.

**Response** `200 OK`
```json
[
  {
    "id": "880e8400-e29b-41d4-a716-446655440001",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "frameId": "770e8400-e29b-41d4-a716-446655440123",
    "version": "transparent",
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_transparent.png",
    "backgroundColor": null,
    "backgroundPrompt": null,
    "success": true,
    "error": null,
    "createdAt": "2025-01-19T10:04:00.000Z"
  },
  {
    "id": "880e8400-e29b-41d4-a716-446655440002",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "frameId": "770e8400-e29b-41d4-a716-446655440123",
    "version": "solid",
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_solid.png",
    "backgroundColor": "#F5F5F5",
    "backgroundPrompt": null,
    "success": true,
    "error": null,
    "createdAt": "2025-01-19T10:04:05.000Z"
  }
]
```

---

### GET /api/v1/jobs/:id/images/grouped

Get commercial images grouped by product variant.

**Response** `200 OK`
```json
{
  "hero": {
    "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_transparent.png",
    "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_solid.png",
    "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_real.png",
    "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_creative.png"
  },
  "back_view": {
    "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_transparent.png",
    "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_solid.png",
    "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_real.png",
    "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_creative.png"
  }
}
```

---

## Webhook Callback

When a `callbackUrl` is provided, VOPI will POST to that URL on job completion or failure.

**Callback Payload**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "result": {
    "variantsDiscovered": 3,
    "framesAnalyzed": 45,
    "finalFrames": ["..."],
    "commercialImages": {"..."}
  },
  "completedAt": "2025-01-19T10:05:00.000Z"
}
```

**On Failure**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "error": "Video download failed: 404 Not Found",
  "failedAt": "2025-01-19T10:00:30.000Z"
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message",
  "statusCode": 400,
  "details": {}
}
```

### Common Status Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing or invalid API key |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Dependencies down |

---

## Rate Limits

The API does not enforce rate limits directly, but external services (Gemini, Photoroom) have their own limits. Large batch sizes or many concurrent jobs may result in throttling.

---

## Examples

### Create and Poll a Job

```bash
# Create job
JOB_ID=$(curl -s -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key" \
  -d '{"videoUrl": "https://example.com/video.mp4"}' \
  | jq -r '.id')

# Poll status
while true; do
  STATUS=$(curl -s -H "x-api-key: test-api-key" \
    "http://localhost:3000/api/v1/jobs/$JOB_ID/status" \
    | jq -r '.status')
  echo "Status: $STATUS"

  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  sleep 5
done

# Get results
curl -H "x-api-key: test-api-key" \
  "http://localhost:3000/api/v1/jobs/$JOB_ID/images/grouped"
```

### Using Webhook Instead of Polling

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key" \
  -d '{
    "videoUrl": "https://example.com/video.mp4",
    "callbackUrl": "https://your-server.com/vopi-webhook"
  }'
```

---

## Config Endpoints

Endpoints for managing runtime configuration. Write operations require admin API keys.

### GET /api/v1/config

Get all config values with metadata.

**Response** `200 OK`
```json
[
  {
    "key": "pipeline.strategy",
    "value": "classic",
    "type": "string",
    "category": "pipeline",
    "description": "Pipeline processing strategy",
    "isActive": true,
    "isDefault": true,
    "updatedAt": null
  },
  {
    "key": "pipeline.fps",
    "value": 10,
    "type": "number",
    "category": "pipeline",
    "description": "Frame extraction rate",
    "isActive": true,
    "isDefault": false,
    "updatedAt": "2025-01-21T10:00:00.000Z"
  }
]
```

---

### GET /api/v1/config/effective

Get the effective runtime configuration object.

**Response** `200 OK`
```json
{
  "pipelineStrategy": "classic",
  "fps": 10,
  "batchSize": 30,
  "geminiModel": "gemini-2.0-flash",
  "geminiVideoModel": "gemini-2.0-flash",
  "temperature": 0.2,
  "topP": 0.8,
  "motionAlpha": 0.3,
  "minTemporalGap": 1.0,
  "topKPercent": 0.3,
  "commercialVersions": ["transparent", "solid", "real", "creative"],
  "aiCleanup": true,
  "geminiVideoFps": 1,
  "geminiVideoMaxFrames": 10,
  "debugEnabled": false
}
```

---

### GET /api/v1/config/:key

Get a single config value.

**Response** `200 OK`
```json
{
  "key": "pipeline.fps",
  "value": 10
}
```

**Response** `404 Not Found`
```json
{
  "error": "Config key not found"
}
```

---

### PUT /api/v1/config (Admin Only)

Set a single config value.

**Request Body**
```json
{
  "key": "pipeline.fps",
  "value": 15,
  "type": "number",
  "category": "pipeline",
  "description": "Frame extraction rate"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | Config key |
| `value` | any | Yes | Config value |
| `type` | string | No | Value type (string/number/boolean/json) |
| `category` | string | No | Category for grouping |
| `description` | string | No | Human-readable description |
| `isActive` | boolean | No | Whether config is active (default: true) |

**Response** `200 OK`
```json
{
  "success": true,
  "key": "pipeline.fps"
}
```

**Response** `403 Forbidden`
```json
{
  "error": "FORBIDDEN",
  "message": "Admin access required for this operation"
}
```

---

### PUT /api/v1/config/batch (Admin Only)

Set multiple config values in a transaction.

**Request Body**
```json
[
  { "key": "pipeline.fps", "value": 15 },
  { "key": "ai.temperature", "value": 0.3 }
]
```

**Response** `200 OK`
```json
{
  "success": true,
  "count": 2
}
```

---

### DELETE /api/v1/config/:key (Admin Only)

Delete a config value (resets to default).

**Response** `200 OK`
```json
{
  "success": true,
  "deleted": true
}
```

---

### POST /api/v1/config/seed (Admin Only)

Initialize database with default config values.

**Response** `200 OK`
```json
{
  "success": true,
  "seeded": 14
}
```

---

### POST /api/v1/config/invalidate-cache (Admin Only)

Force cache invalidation.

**Response** `200 OK`
```json
{
  "success": true
}
```

---

## Admin Authentication

Admin endpoints require an admin API key set via the `ADMIN_API_KEYS` environment variable.

```bash
# Set admin keys (comma-separated)
export ADMIN_API_KEYS=admin-key-1,admin-key-2

# Use admin key for config operations
curl -X PUT http://localhost:3000/api/v1/config \
  -H "Content-Type: application/json" \
  -H "x-api-key: admin-key-1" \
  -d '{"key": "pipeline.strategy", "value": "gemini_video"}'
```

---

## CLI Commands

VOPI includes CLI commands for managing API keys.

### API Key Management

```bash
# Create a new API key
pnpm keys create --name "John's Beta Access" --max-uses 20

# Create with expiration
pnpm keys create --name "Trial Access" --max-uses 5 --expires "2025-06-30"

# Create with quiet mode (outputs only the key, useful for scripting)
pnpm keys create --name "Script Key" --quiet

# Use in scripts
API_KEY=$(pnpm keys create --name "Auto Key" --quiet)

# List active API keys
pnpm keys list

# List all keys (including revoked/expired)
pnpm keys list --all

# Get details about a specific key
pnpm keys info <key-id>

# Revoke an API key
pnpm keys revoke <key-id>

# Show help
pnpm keys help
```

### Output Examples

**Creating a key:**
```
✓ API Key Created

Key Details:
  ID:        550e8400-e29b-41d4-a716-446655440000
  Key:       dG9wX3NlY3JldF9rZXlfaGVyZQ...
  Name:      John's Beta Access
  Max Uses:  20
  Expires:   Never
  Created:   2025-01-19T10:00:00.000Z

⚠️  Save this key securely - it cannot be retrieved later!
```

**Listing keys:**
```
API Keys (3 total):

ID                                    Name                     Usage       Status      Created
----------------------------------------------------------------------------------------------------
550e8400-e29b-41d4-a716-446655440000  John's Beta Access       5/20        Active      2025-01-19
660e8400-e29b-41d4-a716-446655440001  Trial User               3/5         Active      2025-01-18
770e8400-e29b-41d4-a716-446655440002  Old Key                  10/10       Revoked     2025-01-10
```

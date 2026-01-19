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

Valid API keys are configured via the `API_KEYS` environment variable (comma-separated).

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

**Status Values**: `pending`, `downloading`, `extracting`, `scoring`, `classifying`, `generating`, `completed`, `failed`, `cancelled`

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

Cancel a pending or in-progress job.

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "cancelled",
  "message": "Job cancelled successfully"
}
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

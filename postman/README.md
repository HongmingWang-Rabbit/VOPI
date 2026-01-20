# VOPI API Postman Collection

This folder contains Postman collection and environment files for testing the VOPI API.

## Files

- `VOPI_API.postman_collection.json` - Main API collection with all endpoints
- `VOPI_Local.postman_environment.json` - Environment for local development
- `VOPI_Docker.postman_environment.json` - Environment for Docker deployment

## Setup

1. Open Postman
2. Import the collection: `VOPI_API.postman_collection.json`
3. Import an environment file based on your setup
4. Select the imported environment in the top-right dropdown

## Endpoints

### Health (No Auth Required)
- `GET /health` - Liveness check
- `GET /ready` - Readiness check (DB + Redis)

### Jobs
- `POST /api/v1/jobs` - Create a new pipeline job
- `GET /api/v1/jobs` - List all jobs
- `GET /api/v1/jobs/:id` - Get job details
- `GET /api/v1/jobs/:id/status` - Get job status (lightweight)
- `DELETE /api/v1/jobs/:id` - Cancel a job

### Uploads (Mobile App Integration)
- `POST /api/v1/uploads/presign` - Get presigned S3 URL for direct upload

### Results
- `GET /api/v1/jobs/:id/video` - Get video metadata
- `GET /api/v1/jobs/:id/frames` - Get all frames
- `GET /api/v1/jobs/:id/frames/final` - Get final selected frames
- `GET /api/v1/jobs/:id/images` - Get all commercial images
- `GET /api/v1/jobs/:id/images/grouped` - Get images grouped by variant

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `baseUrl` | API base URL | `http://localhost:3000` |
| `API_KEY` | API key for authentication | `test-api-key` |
| `JOB_ID` | Current job ID (auto-set on job creation) | - |
| `uploadUrl` | Presigned S3 upload URL (auto-set) | - |
| `videoPublicUrl` | Public URL of uploaded video (auto-set) | - |

## Quick Test Flow

1. **Check Service Health**
   - Run "Liveness Check" - should return `{"status": "ok"}`
   - Run "Readiness Check" - should return `{"status": "ok"}` with DB/Redis checks

2. **Create a Job**
   - Run "Create Job" with a valid video URL
   - The `JOB_ID` environment variable is automatically set

3. **Poll Status**
   - Run "Get Job Status" repeatedly to monitor progress
   - Status flow: `pending` → `downloading` → `extracting` → `scoring` → `classifying` → `generating` → `completed`

4. **Get Results**
   - Once status is `completed`, run "Get Job" to see full results
   - Run "Get Final Frames" to see selected frames with metadata
   - Run "Get Commercial Images (Grouped)" to see all generated images

## Example: Create Job with S3 URL

```json
POST /api/v1/jobs
{
  "videoUrl": "s3://vopi-storage/videos/product.mp4",
  "config": {
    "fps": 10,
    "commercialVersions": ["transparent", "solid"]
  }
}
```

## Example: Create Job with Callback

```json
POST /api/v1/jobs
{
  "videoUrl": "https://example.com/video.mp4",
  "callbackUrl": "https://your-server.com/webhook"
}
```

The callback will receive a POST with:
```json
{
  "jobId": "uuid",
  "status": "completed",
  "result": { ... }
}
```

## Mobile App Upload Flow

For mobile apps that need to upload videos directly from the device:

### 1. Get Presigned URL

```json
POST /api/v1/uploads/presign
{
  "contentType": "video/mp4",
  "expiresIn": 3600
}
```

Response:
```json
{
  "uploadUrl": "https://s3.../uploads/uuid.mp4?X-Amz-Signature=...",
  "key": "uploads/abc123.mp4",
  "publicUrl": "https://storage.example.com/uploads/abc123.mp4",
  "expiresIn": 3600
}
```

### 2. Upload Video Directly to S3

```bash
curl -X PUT "${uploadUrl}" \
  -H "Content-Type: video/mp4" \
  --data-binary @video.mp4
```

### 3. Create Job with Public URL

```json
POST /api/v1/jobs
{
  "videoUrl": "${publicUrl}",
  "config": {
    "fps": 10,
    "commercialVersions": ["transparent", "solid"]
  }
}
```

The video is automatically deleted from S3 after job completion (success or failure).

### Supported Video Types

| Content Type | Extension |
|--------------|-----------|
| `video/mp4` | .mp4 |
| `video/quicktime` | .mov |
| `video/webm` | .webm |

## API Key Management

API keys can be managed via CLI commands:

```bash
# Create a new API key
pnpm keys create --name "My App" --max-uses 100

# List active API keys
pnpm keys list

# List all keys including revoked/expired
pnpm keys list --all

# Get key details
pnpm keys info <key-id>

# Revoke a key
pnpm keys revoke <key-id>
```

Keys are stored in the database with usage tracking. Each job creation increments the usage count, and jobs fail with 403 when the limit is exceeded.

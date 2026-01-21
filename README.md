# VOPI - Video Object Processing Infrastructure

A backend microservice for extracting high-quality product frames from videos and generating commercial product images using AI.

## Features

- **Smart Frame Extraction** - Automatically extracts the sharpest, best-composed frames from product videos
- **AI-Powered Classification** - Uses Google Gemini to classify frames (hero, front, back, detail, etc.)
- **Commercial Image Generation** - Generates professional product photos with clean backgrounds
- **Job Queue System** - Async processing with BullMQ and Redis
- **S3-Compatible Storage** - Works with AWS S3 or MinIO for local development
- **REST API** - Fastify-based API with OpenAPI documentation

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   API Server    │────▶│   Redis/BullMQ  │────▶│     Worker      │
│   (Fastify)     │     │   (Job Queue)   │     │   (Processing)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                                               │
        ▼                                               ▼
┌─────────────────┐                           ┌─────────────────┐
│   PostgreSQL    │                           │   S3 / MinIO    │
│   (Job State)   │                           │   (Storage)     │
└─────────────────┘                           └─────────────────┘
```

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local development)
- pnpm (for local development)

### Run with Docker

1. Copy the environment file:
   ```bash
   cp .env.example .env
   ```

2. Add your API keys to `.env`:
   ```
   GOOGLE_AI_API_KEY=your_google_ai_key
   PHOTOROOM_API_KEY=your_photoroom_key  # Optional
   ```

3. Start all services:
   ```bash
   docker compose up
   ```

4. Access the API at `http://localhost:3000`
5. View API docs at `http://localhost:3000/docs`

### Local Development

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Start infrastructure (PostgreSQL, Redis, MinIO):
   ```bash
   docker compose up postgres redis minio minio-init
   ```

3. Run the API server:
   ```bash
   pnpm dev
   ```

4. Run the worker (in another terminal):
   ```bash
   pnpm dev:worker
   ```

## API Endpoints

### Health Checks

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness check |
| `GET /ready` | Readiness check (DB + Redis) |

### Jobs

| Endpoint | Description |
|----------|-------------|
| `POST /api/v1/jobs` | Create a new processing job |
| `GET /api/v1/jobs` | List all jobs |
| `GET /api/v1/jobs/:id` | Get job details |
| `GET /api/v1/jobs/:id/status` | Get job status (lightweight) |
| `DELETE /api/v1/jobs/:id` | Cancel a job |

### Results

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/jobs/:id/video` | Get video metadata |
| `GET /api/v1/jobs/:id/frames` | Get all extracted frames |
| `GET /api/v1/jobs/:id/frames/final` | Get final selected frames |
| `GET /api/v1/jobs/:id/images` | Get all commercial images |
| `GET /api/v1/jobs/:id/images/grouped` | Get images grouped by variant |

## Authentication

All API endpoints (except health checks) require an API key via the `x-api-key` header:

```bash
curl -H "x-api-key: your-api-key" http://localhost:3000/api/v1/jobs
```

## Example Usage

### Create a Job

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key" \
  -d '{
    "videoUrl": "https://example.com/product-video.mp4",
    "config": {
      "fps": 10,
      "commercialVersions": ["transparent", "solid"]
    }
  }'
```

### With Callback URL

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key" \
  -d '{
    "videoUrl": "s3://vopi-storage/videos/product.mp4",
    "callbackUrl": "https://your-server.com/webhook"
  }'
```

### Check Job Status

```bash
curl -H "x-api-key: test-api-key" \
  http://localhost:3000/api/v1/jobs/{job-id}/status
```

## Job Status Flow

```
pending → downloading → extracting → scoring → classifying → generating → completed
                                                                      ↘ failed
```

## CLI Tools

### Frame Extraction

Extract frames from a local video:

```bash
pnpm run extract ./product_video.mp4
```

With options:

```bash
pnpm run extract ./product_video.mp4 \
  --fps 8 \
  --top-k 20 \
  --output ./my_output
```

### Commercial Image Generation

Generate commercial product images:

```bash
pnpm run commercial ./product_video.mp4 \
  --generate-commercial \
  --bg-style studio
```

Background styles: `studio`, `gradient`, `lifestyle`, `minimal`

See `src/smartFrameExtractor/README.md` for detailed CLI documentation.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `development` |
| `PORT` | API server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `REDIS_URL` | Redis connection string | - |
| `API_KEYS` | Comma-separated valid API keys | - |
| `S3_BUCKET` | S3 bucket name | - |
| `S3_REGION` | S3 region | `us-east-1` |
| `S3_ENDPOINT` | S3-compatible storage endpoint (required) | - |
| `S3_ACCESS_KEY_ID` | S3 access key | - |
| `S3_SECRET_ACCESS_KEY` | S3 secret key | - |
| `GOOGLE_AI_API_KEY` | Google AI API key for Gemini | - |
| `PHOTOROOM_API_KEY` | Photoroom API key (optional) | - |
| `WORKER_CONCURRENCY` | Worker concurrency | `2` |
| `LOG_LEVEL` | Log level | `info` |

## Database

Run migrations:

```bash
pnpm db:push
```

Open Drizzle Studio:

```bash
pnpm db:studio
```

## Project Structure

```
├── src/
│   ├── config/           # Configuration
│   ├── controllers/      # Route handlers
│   ├── db/               # Database schema & migrations
│   ├── middleware/       # Auth, error handling
│   ├── queues/           # BullMQ job definitions
│   ├── routes/           # API routes
│   ├── services/         # Business logic
│   ├── smartFrameExtractor/  # Frame extraction pipeline
│   ├── utils/            # Utilities
│   ├── workers/          # Background job processors
│   ├── app.ts            # Fastify app setup
│   └── index.ts          # Entry point
├── postman/              # Postman collection & environments
├── docker-compose.yml    # Docker services
├── Dockerfile            # Production Docker image
└── drizzle.config.ts     # Drizzle ORM config
```

## License

MIT

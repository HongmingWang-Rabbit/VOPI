# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VOPI (Video Object Processing Infrastructure) is a TypeScript backend service that extracts high-quality product photography frames from videos using frame scoring algorithms and AI classification (Gemini 2.0). It includes optional commercial image generation via Photoroom API.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript 5.3 (ESM modules)
- **Framework**: Fastify 4.25 with Zod schema validation
- **Database**: PostgreSQL 16 with Drizzle ORM
- **Queue**: Redis 7 + BullMQ for async job processing
- **Storage**: AWS S3 / MinIO (local dev)
- **AI Services**: Google Gemini 2.0 Flash, Photoroom API
- **Video Processing**: FFmpeg (external binary required)

## Common Commands

```bash
# Development (run both in separate terminals)
pnpm dev              # API server with hot reload
pnpm dev:worker       # Job queue worker with hot reload

# Database
pnpm db:migrate       # Run migrations
pnpm db:push          # Push schema changes directly
pnpm db:studio        # Open Drizzle Studio GUI

# Build & Production
pnpm build            # TypeScript compilation
pnpm start            # Production API server
pnpm start:worker     # Production worker

# Type checking & Linting
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint

# CLI tool (standalone frame extraction)
pnpm extract [video.mp4] [options]
pnpm extract -- --skip-gemini     # Scoring only, no AI
pnpm commercial                    # Generate commercial images

# Pipeline testing CLI (interactive menu)
pnpm test:cli             # Test individual pipeline steps
```

## Architecture

### Pipeline Strategies
VOPI supports two pipeline strategies, controlled by `pipeline.strategy` global config:

**Classic Strategy** (default):
1. **Download** - Fetch video from URL
2. **Extract** - Dense frame extraction at configurable FPS via FFmpeg
3. **Score** - Calculate sharpness (Laplacian variance) + motion penalty
4. **Classify** - Send top-K candidates to Gemini for classification
5. **Extract Product** - Remove background, rotate, and center product
6. **Generate** - Optional commercial image generation (Photoroom)
7. **Upload** - Store results to S3, persist to database

**Gemini Video Strategy**:
1. **Download** - Fetch video from URL
2. **Transcode** - Auto-convert HEVC to H.264 if needed (for iPhone compatibility)
3. **Analyze** - Upload to Gemini Files API and analyze video directly
4. **Extract** - Extract only the selected frames at specific timestamps
5. **Extract Product** - Remove background, rotate, and center product
6. **Generate** - Optional commercial image generation (Photoroom)
7. **Upload** - Store results to S3, persist to database

The API (`src/index.ts`) handles HTTP requests while workers (`src/workers/`) process queued jobs independently. This separation allows horizontal scaling of workers.

### Key Directories
- `src/services/` - Core business logic (one service per domain: video, scoring, gemini, photoroom, storage)
- `src/providers/` - External service integrations (Gemini video analysis with HEVC transcoding)
- `src/routes/` + `src/controllers/` - HTTP layer
- `src/workers/` - BullMQ job processors
- `src/db/schema.ts` - Drizzle ORM schema (api_keys, jobs, videos, frames, commercialImages, globalConfig)
- `src/cli/` - CLI commands (API key management, pipeline testing)
- `src/templates/` - Gemini prompts and output schemas
- `src/utils/` - Shared utilities (logging, errors, URL validation, S3 URL parsing)
- `src/smartFrameExtractor/` - Standalone CLI tool (JavaScript)

### Database Relationships
```
api_keys (1) → jobs (N) → videos (1) → frames (N) → commercialImages (N)
```
All relationships use cascade delete (api_keys → jobs uses SET NULL).

### Mobile App Integration
For mobile clients uploading videos:
1. Get presigned URL: `POST /api/v1/uploads/presign`
2. Upload video directly to S3 using the presigned URL
3. Create job with the returned `publicUrl`
4. Poll job status or use webhook callback
5. Get presigned download URLs: `GET /api/v1/jobs/:id/download-urls`
6. Uploaded video is automatically deleted after job completion

**Note**: S3 bucket is private. Use the download-urls endpoint to get time-limited presigned URLs for accessing results.

## Local Development Setup

```bash
# Start infrastructure (Postgres, Redis, MinIO)
docker compose up -d postgres redis minio minio-init

# Configure environment
cp .env.example .env
# Edit .env: add GOOGLE_AI_API_KEY and PHOTOROOM_API_KEY

# Initialize database
pnpm db:migrate

# Run services
pnpm dev          # Terminal 1
pnpm dev:worker   # Terminal 2
```

API docs available at `http://localhost:3000/docs` (Swagger UI)

## API Authentication

All `/api/v1/*` endpoints require `x-api-key` header. API keys can come from:
1. **Database** (recommended) - Keys in `api_keys` table with usage tracking
2. **Environment** (fallback) - Keys in `API_KEYS` env var (comma-separated)

Database keys support:
- Usage limits: `max_uses` and `used_count` per key
- Expiration: Optional `expires_at` timestamp
- Revocation: Soft delete via `revoked_at`

Manage keys via CLI:
```bash
pnpm keys create --name "User Name" --max-uses 20
pnpm keys list
pnpm keys revoke <key-id>
```

Security features:
- Timing-safe API key comparison (prevents timing attacks)
- Configurable auth skip paths via `AUTH_SKIP_PATHS`
- CORS domain whitelist via `CORS_ALLOWED_DOMAINS`
- Callback URL SSRF protection via `CALLBACK_ALLOWED_DOMAINS`
- Admin API keys for config management via `ADMIN_API_KEYS`

## Global Configuration

Runtime configuration is stored in PostgreSQL and cached in memory:
- **Config API**: `GET/PUT/DELETE /api/v1/config` endpoints
- **Admin-only**: Config modification requires admin API key (`ADMIN_API_KEYS`)
- **Caching**: 60-second TTL (configurable via `CONFIG_CACHE_TTL_MS`)
- **Categories**: `pipeline.*`, `ai.*`, `scoring.*`, `commercial.*`, `geminiVideo.*`

Key config values:
- `pipeline.strategy`: `classic` or `gemini_video`
- `ai.geminiModel`: Model for frame classification
- `ai.geminiVideoModel`: Model for video analysis
- `scoring.motionAlpha`: Motion penalty weight (0-1)

## Frame Scoring Algorithm

```
score = sharpness - (alpha × motion × 255)
```
- **Sharpness**: Laplacian variance (high = in-focus)
- **Motion**: Pixel difference with previous frame (low = still moment)
- Temporal diversity enforced via minimum gap between selections

## External Dependencies

- **FFmpeg** must be installed and in PATH (configurable via `FFMPEG_PATH`, `FFPROBE_PATH`)
- **Gemini API** for frame classification (configurable model via `GEMINI_MODEL`)
- **Photoroom API** for background removal (configurable hosts via `PHOTOROOM_*_HOST`)

## Configuration

All configuration is via environment variables with sensible defaults. Key categories:
- **Database**: Connection pooling settings (`DB_POOL_*`)
- **Queue**: Job retry and retention (`QUEUE_*`)
- **Worker**: Concurrency, timeouts, rate limiting (`WORKER_*`, `API_*`)
- **Security**: CORS, auth skip paths, callback domains

See `.env.example` for all available options.

## Documentation

Detailed documentation is available in the `/docs` folder:
- [Architecture](./docs/architecture.md) - System design and data flow
- [API Reference](./docs/api.md) - REST API endpoints
- [Services](./docs/services.md) - Core service modules
- [Database](./docs/database.md) - Schema and migrations
- [Deployment](./docs/deployment.md) - Setup and production guide

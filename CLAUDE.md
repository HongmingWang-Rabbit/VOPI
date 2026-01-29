# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VOPI (Video Object Processing Infrastructure) is a TypeScript backend service that extracts high-quality product photography frames from videos using frame scoring algorithms and AI classification (Gemini 2.0). It includes commercial image generation via Stability AI, Gemini native image generation, or Photoroom (fallback).

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript 5.3 (ESM modules)
- **Framework**: Fastify 4.25 with Zod schema validation
- **Database**: PostgreSQL 16 with Drizzle ORM
- **Queue**: Redis 7 + BullMQ for async job processing
- **Storage**: AWS S3 / MinIO (local dev)
- **AI Services**: Google Gemini 2.0 Flash, Claid.ai, Stability AI, Photoroom API
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
5. **Extract Product** - Claid.ai background removal with selective object retention
6. **Fill Holes** - Stability AI inpainting to fill gaps from obstruction removal
7. **Center** - Center and pad product in frame
8. **Upscale** - Stability AI image upscaling (conservative/creative modes)
9. **Generate** - Commercial image generation via Stability AI (transparent, solid, real, creative versions)
10. **Upload** - Store results to S3, persist to database

**Gemini Video Strategy**:
1. **Download** - Fetch video from URL
2. **Transcode** - Auto-convert HEVC to H.264 if needed (for iPhone compatibility)
3. **Analyze** - Upload to Gemini Files API and analyze video directly
4. **Extract** - Extract only the selected frames at specific timestamps
5. **Extract Product** - Claid.ai background removal with selective object retention
6. **Fill Holes** - Stability AI inpainting to fill gaps from obstruction removal
7. **Center** - Center and pad product in frame
8. **Upscale** - Stability AI image upscaling (conservative/creative modes)
9. **Generate** - Commercial image generation via Stability AI
10. **Upload** - Store results to S3, persist to database

**Unified Video Analyzer Strategy** (most efficient):
1. **Download** - Fetch video from URL
2. **Unified Analysis** - Single Gemini call for audio transcription + video frame selection
3. **Extract Product** - Claid.ai background removal
4. **Fill Holes** - Stability AI inpainting
5. **Center** - Center and pad product in frame
6. **Upscale** - Stability AI image upscaling
7. **Generate** - Commercial image generation via Stability AI
8. **Upload** - Store results to S3, persist to database

**Full Gemini Stack** (no external image APIs):
1. **Download** - Fetch video from URL
2. **Unified Analysis** - Single Gemini call for audio transcription + video frame selection (extracts up to 8 frames)
3. **Gemini Image Generate** - Uses Gemini native image generation for background removal + commercial variants
   - Selects 4 best angles from extracted frames
   - Generates 2 variants per angle: `white-studio` (clean background) and `lifestyle` (contextual scene)
   - Uses product metadata from audio analysis for lifestyle scene generation
4. **Quality Filter** (optional) - AI-powered filtering to remove images that don't match the original product
5. **Upload** - Store results to S3, persist to database

This strategy eliminates dependency on Stability AI, Claid.ai, and Photoroom APIs by using Gemini's native image generation capabilities.

The API (`src/index.ts`) handles HTTP requests while workers (`src/workers/`) process queued jobs independently. This separation allows horizontal scaling of workers.

### Audio Analysis Pipeline (Optional)
VOPI can extract audio from videos and generate structured e-commerce metadata:
1. **Extract Audio** - FFmpeg extracts 16kHz mono MP3 optimized for speech recognition
2. **Analyze Audio** - Gemini 2.0 Flash transcribes and extracts product information
3. **Format Metadata** - Generates `metadata.json` with platform-specific formats (Shopify, Amazon, eBay)

The audio pipeline produces:
- Full transcript from seller's audio description
- Structured product metadata (title, description, bullet points, materials, etc.)
- Platform-specific formatted data ready for listing APIs
- Confidence scores for extracted information

### Composable Processor Stack
The pipeline is built on a modular processor stack architecture using a unified `DataPath` type system:
- **DataPaths** define what data processors require/produce: `video`, `images`, `text`, `frames`, `audio`, `transcript`, `product.metadata`, `frames.scores`, `frames.classifications`, `frames.dbId`, `frames.s3Url`, `frames.version`
- **Processors** declare their IO contracts using these paths
- **Stacks** compose processors into pipelines with validated data flow
- **Swapping** allows replacing processors with compatible IO contracts (e.g., `photoroom-bg-remove` ↔ `claid-bg-remove`)
- **Templates** provide pre-defined stacks: `classic`, `gemini_video`, `minimal`, `frames_only`, `custom_bg_removal`, `unified_video_analyzer`, `stability_bg_removal`, `full_gemini`
- **Concurrency** is centralized in `src/processors/concurrency.ts` with documented defaults per processor type, overridable via `VOPI_CONCURRENCY_*` env vars

See `src/processors/` for implementation details.

### Key Directories
- `src/processors/` - Composable processor stack architecture (registry, runner, implementations)
- `src/services/` - Core business logic (one service per domain: video, scoring, gemini, photoroom, storage)
- `src/providers/` - External service integrations (Gemini video/image, Stability AI, Claid.ai)
- `src/providers/ecommerce/` - E-commerce platform providers (Shopify `productSet`, Amazon SP-API, eBay Inventory API)
- `src/providers/utils/` - Shared provider utilities (Stability API, Gemini utils)
- `src/services/oauth/` - Platform OAuth services (Shopify, Amazon, eBay)
- `src/routes/` + `src/controllers/` - HTTP layer
- `src/workers/` - BullMQ job processors
- `src/db/schema.ts` - Drizzle ORM schema (api_keys, jobs, videos, frames, commercialImages, globalConfig)
- `src/cli/` - CLI commands (API key management, pipeline testing)
- `src/templates/` - Gemini prompts and output schemas
- `src/types/` - Type definitions including `product-metadata.types.ts` for e-commerce metadata
- `src/utils/` - Shared utilities (logging, errors, URL validation, S3 URL parsing, MIME types, parallel processing, image utils, frame selection)
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
- OAuth open redirect prevention via `OAUTH_ALLOWED_REDIRECT_SCHEMES`
- `trustProxy: 1` for correct protocol detection behind reverse proxy

## Global Configuration

Runtime configuration is stored in PostgreSQL and cached in memory:
- **Config API**: `GET/PUT/DELETE /api/v1/config` endpoints
- **Admin-only**: Config modification requires admin API key (`ADMIN_API_KEYS`)
- **Caching**: 60-second TTL (configurable via `CONFIG_CACHE_TTL_MS`)
- **Categories**: `pipeline.*`, `ai.*`, `scoring.*`, `commercial.*`, `geminiVideo.*`

Key config values:
- `pipeline.strategy`: `classic`, `gemini_video`, `unified_video_analyzer`, or `full_gemini`
- `ai.geminiModel`: Model for frame classification
- `ai.geminiVideoModel`: Model for video analysis
- `ai.geminiImageModel`: Model for native image generation (default: `gemini-2.5-flash-image`)
- `scoring.motionAlpha`: Motion penalty weight (0-1)

## Frame Scoring Algorithm

```
score = sharpness - (alpha × motion × 255)
```
- **Sharpness**: Laplacian variance (high = in-focus)
- **Motion**: Pixel difference with previous frame (low = still moment)
- **Minimum sharpness threshold**: Frames with sharpness < 5 are rejected (prevents blurry frames)
- Temporal diversity enforced via minimum gap between selections

The minimum sharpness threshold (default: 5) can be overridden via processor options:
```typescript
{ minSharpnessThreshold: 10 }  // Stricter - fewer frames
{ minSharpnessThreshold: 0 }   // Disabled - old behavior
```

## External Dependencies

- **FFmpeg** must be installed and in PATH (configurable via `FFMPEG_PATH`, `FFPROBE_PATH`)
- **Gemini API** for frame classification and video analysis (`GOOGLE_AI_API_KEY`)
- **Stability AI** for commercial image generation, upscaling, and inpainting (`STABILITY_API_KEY`, `STABILITY_API_BASE`)
- **Claid API** for background removal with object retention (`CLAID_API_KEY`) - primary provider
- **Photoroom API** (optional, legacy) for commercial image generation (`PHOTOROOM_API_KEY`)

## Configuration

All configuration is via environment variables with sensible defaults. Key categories:
- **Database**: Connection pooling settings (`DB_POOL_*`)
- **Queue**: Job retry and retention (`QUEUE_*`)
- **Worker**: Concurrency, timeouts, rate limiting (`WORKER_*`, `API_*`)
- **Audio**: Processing timeouts and retries (`AUDIO_PROCESSING_TIMEOUT_MS`, `AUDIO_POLLING_INTERVAL_MS`, `AUDIO_MAX_RETRIES`)
- **Transcoding**: HEVC→H.264 conversion settings (`VOPI_TRANSCODE_*`, `VOPI_FFPROBE_*`)
- **Concurrency**: Processor parallelism (`VOPI_CONCURRENCY_*`)
- **Security**: CORS, auth skip paths, callback domains
- **OAuth**: Platform connection settings (`OAUTH_SUCCESS_REDIRECT_URL`, `OAUTH_ALLOWED_REDIRECT_SCHEMES`, `SHOPIFY_*`, `AMAZON_*`, `EBAY_*`)

### Transcoding Configuration

HEVC videos (common from iPhones) are automatically transcoded to H.264 for Gemini compatibility:

| Variable | Default | Description |
|----------|---------|-------------|
| `VOPI_TRANSCODE_HEIGHT` | `720` | Target video height (720p default) |
| `VOPI_TRANSCODE_TIMEOUT_MS` | `600000` | Transcoding timeout (10 minutes) |
| `VOPI_FFPROBE_TIMEOUT_MS` | `30000` | Codec detection timeout (30 seconds) |

See `.env.example` for all available options.

## Documentation

Detailed documentation is available in the `/docs` folder:
- [Architecture](./docs/architecture.md) - System design and data flow
- [API Reference](./docs/api.md) - REST API endpoints
- [Services](./docs/services.md) - Core service modules
- [Database](./docs/database.md) - Schema and migrations
- [Deployment](./docs/deployment.md) - Setup and production guide

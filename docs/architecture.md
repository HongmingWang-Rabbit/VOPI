# Architecture

## System Overview

VOPI follows a distributed architecture with separate API and worker processes, connected via a Redis-backed job queue.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Client Applications                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API Server (Fastify)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │    Routes    │  │  Controllers │  │  Middleware  │  │   Swagger    │     │
│  │  /api/v1/*   │  │              │  │  Auth/Error  │  │    /docs     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
        │                                       │
        ▼                                       ▼
┌───────────────────┐                 ┌───────────────────┐
│    PostgreSQL     │                 │   Redis + BullMQ  │
│   (Job State)     │                 │   (Job Queue)     │
└───────────────────┘                 └───────────────────┘
        │                                       │
        └───────────────────┬───────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Worker Process                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Pipeline Service                                │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │ │
│  │  │ Video   │  │ Scoring │  │ Gemini  │  │Photoroom│  │   Storage   │  │ │
│  │  │ Service │  │ Service │  │ Service │  │ Service │  │   Service   │  │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         External Services                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   FFmpeg     │  │ Google Gemini│  │   Claid.ai   │  │ Stability AI │    │
│  │ (local bin)  │  │    API       │  │     API      │  │     API      │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                       ┌──────────────┐                       │
│                                       │  Photoroom   │                       │
│                                       │     API      │                       │
│                                       └──────────────┘                       │
└─────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          S3 / MinIO Storage                                  │
│                    (frames, commercial images, results)                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### API Server (`src/index.ts`)

The HTTP layer built on Fastify:

- **Routes** (`src/routes/`): Define HTTP endpoints with OpenAPI schemas
- **Controllers** (`src/controllers/`): Handle request/response logic
- **Middleware** (`src/middleware/`): Authentication and error handling
- **App** (`src/app.ts`): Fastify configuration, plugins, and route registration

Key features:
- Zod schema validation for request/response
- Swagger UI at `/docs`
- API key authentication via `x-api-key` header (timing-safe comparison)
- Configurable CORS with domain whitelist
- Configurable auth skip paths
- Health checks at `/health` and `/ready`

### Job Queue (`src/queues/`)

BullMQ-based async job processing:

- **Redis Connection** (`src/queues/redis.ts`): Shared Redis client configuration
- **Pipeline Queue** (`src/queues/pipeline.queue.ts`): Job queue definition with retry logic

Job lifecycle:
1. API creates job record in PostgreSQL with `pending` status
2. Job is added to BullMQ queue
3. Worker picks up job and processes through pipeline
4. Status updates are persisted to PostgreSQL
5. Optional webhook callback on completion (with SSRF protection)

Queue configuration is fully customizable:
- Retry attempts and backoff delays
- Job retention policies (age and count limits)
- Concurrency settings

### Worker Process (`src/workers/`)

Independent process that consumes jobs from the queue:

- **Worker Entry** (`src/workers/index.ts`): Worker process startup
- **Pipeline Worker** (`src/workers/pipeline.worker.ts`): Job processing logic

The worker:
- Runs independently from API (can be scaled horizontally)
- Processes one job at a time per worker (configurable concurrency)
- Handles failures with automatic retry and exponential backoff
- Cleans up temp files after each job
- Sends webhook callbacks with timeout and retry logic

### Services (`src/services/`)

Core business logic modules:

| Service | File | Purpose |
|---------|------|---------|
| Video | `video.service.ts` | Video download, metadata extraction, frame extraction via FFmpeg |
| Frame Scoring | `frame-scoring.service.ts` | Sharpness/motion calculation, candidate selection |
| Gemini | `gemini.service.ts` | AI classification, variant discovery |
| Photoroom | `photoroom.service.ts` | Background removal, commercial image generation |
| Storage | `storage.service.ts` | S3 upload/download, presigned URLs |
| Pipeline | `pipeline.service.ts` | Orchestrates the full processing pipeline |
| Global Config | `global-config.service.ts` | Runtime configuration with database persistence |

### Database (`src/db/`)

PostgreSQL with Drizzle ORM:

- **Schema** (`src/db/schema.ts`): Table definitions and relations
- **Migrations** (`src/db/migrations/`): SQL migration files
- **Index** (`src/db/index.ts`): Database connection and utilities

See [Database Documentation](./database.md) for schema details.

## Processing Pipeline

### Pipeline Strategies

VOPI supports two pipeline strategies, controlled by the `pipeline.strategy` global config:

#### Classic Strategy (default)
The traditional approach that extracts all frames first, then uses AI for classification:
1. Download video
2. Extract ALL frames at configured FPS using FFmpeg
3. Score frames for sharpness and motion
4. Send top candidates to Gemini for classification
5. Remove background with Claid.ai (selective object retention)
6. Fill holes with Stability AI inpainting (for obstruction removal artifacts)
7. Center product in frame
8. Generate commercial images
9. Upload to S3

Best for: Shorter videos, when you need fine-grained frame selection

#### Gemini Video Strategy
Direct video analysis using Gemini's video understanding capabilities:
1. Download video
2. Auto-transcode HEVC → H.264 if needed (for iPhone compatibility)
3. Upload video to Gemini Files API
4. Gemini analyzes video directly and selects optimal timestamps
5. Extract only the selected frames
6. Remove background with Claid.ai (selective object retention)
7. Fill holes with Stability AI inpainting (for obstruction removal artifacts)
8. Center product in frame
9. Generate commercial images
10. Upload to S3

Best for: Longer videos, when you want faster processing without extracting all frames

**Note**: HEVC (H.265) videos from iPhones are automatically transcoded to H.264 since Gemini doesn't support HEVC.

### Pipeline Steps (Classic Strategy)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Pipeline Flow                                   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. DOWNLOAD (5%)                                                        │
│     ├─ Fetch video from URL (HTTP/HTTPS/S3)                             │
│     └─ Save to temp directory                                           │
│                                                                          │
│  2. EXTRACT (10-15%)                                                     │
│     ├─ Get video metadata (duration, resolution, fps)                   │
│     └─ Extract frames at configured FPS using FFmpeg                    │
│                                                                          │
│  3. SCORE (30-45%)                                                       │
│     ├─ Calculate sharpness (Laplacian variance)                         │
│     ├─ Calculate motion penalty (frame difference)                      │
│     └─ Select best frame per second as candidates                       │
│                                                                          │
│  4. CLASSIFY (50-60%)                                                    │
│     ├─ Send candidate frames to Gemini in batches                       │
│     ├─ Discover product variants                                        │
│     ├─ Select best frame per variant                                    │
│     └─ Get background recommendations                                   │
│                                                                          │
│  5. EXTRACT PRODUCT (60-70%)                                             │
│     ├─ Remove background via Claid.ai (selective object retention)      │
│     ├─ Fill transparent holes via Stability AI inpainting               │
│     └─ Center product in frame with padding                             │
│                                                                          │
│  6. GENERATE (70-95%)                                                    │
│     ├─ Use extracted product as input                                   │
│     ├─ Generate 4 versions per frame                                    │
│     └─ Upload results to S3                                             │
│                                                                          │
│  7. COMPLETE (100%)                                                      │
│     ├─ Update job status                                                │
│     ├─ Trigger callback if configured                                   │
│     └─ Cleanup temp files                                               │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Job Status Flow

```
pending → downloading → extracting → scoring → classifying → extracting_product → generating → completed
                                                                                            ↘ failed
                                                                               cancelled ←──┘
```

### Data Flow

```
Video URL
    │
    ▼
┌─────────────────┐
│  Download to    │
│  temp storage   │
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Extract frames  │───────▶ /tmp/vopi/{jobId}/frames/
│ (dense, N fps)  │         frame_00001.png ... frame_NNNNN.png
└─────────────────┘
    │
    ▼
┌─────────────────┐
│  Score frames   │───────▶ ScoredFrame[] (sharpness, motion, combined)
│                 │
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Select best per │───────▶ /tmp/vopi/{jobId}/candidates/
│   second        │         (subset of frames)
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Gemini classify │───────▶ RecommendedFrame[] (variant, angle, recommendations)
│   (batched)     │
└─────────────────┘
    │
    ▼
┌─────────────────┐
│  Save final     │───────▶ /tmp/vopi/{jobId}/final/
│   selections    │         hero_frame_00123_t4.50.png, etc.
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Claid bg-remove │───────▶ /tmp/vopi/{jobId}/extracted/
│ + hole filling  │         hero_transparent.png (background removed)
│ + centering     │         hero_filled.png (holes filled, centered)
└─────────────────┘
    │
    ▼
┌─────────────────┐
│   Photoroom     │───────▶ /tmp/vopi/{jobId}/commercial/
│   generate      │         hero_transparent.png, hero_solid.png, etc.
└─────────────────┘
    │
    ▼
┌─────────────────┐
│  Upload to S3   │───────▶ s3://bucket/jobs/{jobId}/frames/
│                 │         s3://bucket/jobs/{jobId}/commercial/
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Save to DB      │───────▶ videos, frames, commercial_images tables
│                 │
└─────────────────┘
```

## Composable Processor Stack Architecture

VOPI uses a modular processor stack architecture that enables flexible workflow composition through simple IO type contracts.

### Core Concepts

```
┌─────────────────────────────────────────────────────────────────┐
│                        Stack Template                            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │download │→│extract  │→│ score   │→│classify │→ ...         │
│  │ →video  │  │video→img│  │img→img │  │img→meta│              │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

**IO Types**: Processors declare what they require and produce:
- `video` - Video file path
- `images` - Array of image paths
- `text` - Text/JSON data
- `metadata` - Structured metadata

Any processor that outputs `images` can connect to any processor that requires `images`.

### Processor IO Contracts

| Processor | Requires | Produces | Description |
|-----------|----------|----------|-------------|
| download | - | video | Downloads video from URL |
| extract-frames | video | images | Extracts frames with FFmpeg |
| gemini-video-analysis | video | images, metadata | Direct video analysis |
| score-frames | images | images, metadata | Calculates quality scores |
| gemini-classify | images | metadata | AI classification |
| filter-by-score | images, metadata | images | Filters by score |
| photoroom-bg-remove | images | images | Background removal (Photoroom) |
| claid-bg-remove | images | images | Background removal (Claid) - swappable |
| center-product | images | images | Centers product in frame |
| rotate-image | images | images | Rotates images |
| fill-product-holes | images | images | Fills transparent holes in products |
| extract-products | images | images | Full product extraction |
| upload-frames | images | text | Uploads to S3 |
| generate-commercial | images | images | Commercial image generation |
| save-frame-records | metadata | - | Persists to database |
| complete-job | - | - | Finalizes job |

### Stack Configuration

Jobs can customize pipeline behavior via `StackConfig`:

```typescript
interface StackConfig {
  stackId?: string;                           // Which template to use
  processorSwaps?: Record<string, string>;    // Swap processors
  processorOptions?: Record<string, any>;     // Override processor options
  insertProcessors?: Array<{
    after: string;
    processor: string;
    options?: Record<string, any>;
  }>;
}
```

**Example: Swap background removal provider**
```typescript
{
  processorSwaps: {
    'photoroom-bg-remove': 'claid-bg-remove'
  }
}
```

### Pre-defined Stack Templates

| Stack ID | Description |
|----------|-------------|
| `classic` | Full pipeline: extract → score → classify → extract-products → generate |
| `gemini_video` | Direct video analysis with Gemini |
| `minimal` | Extract and upload without commercial generation |
| `frames_only` | Extract frames with scoring, no AI classification |
| `custom_bg_removal` | Configurable background removal provider |

### Stack Validation

The StackRunner validates stacks before execution:
1. Verifies all processors exist in registry
2. Checks IO flow (each processor's requirements are satisfied by previous outputs)
3. Validates processor swaps have compatible IO contracts

### Key Files

| File | Purpose |
|------|---------|
| `src/processors/types.ts` | IOType, Processor, Stack interfaces |
| `src/processors/registry.ts` | ProcessorRegistry for managing processors |
| `src/processors/runner.ts` | StackRunner with validation and execution |
| `src/processors/templates/index.ts` | Pre-defined stack templates |
| `src/processors/impl/` | Individual processor implementations |

## Directory Structure

```
src/
├── app.ts                  # Fastify app configuration
├── index.ts                # API server entry point
├── config/
│   ├── env.ts             # Environment validation (Zod)
│   └── index.ts           # Configuration exports
├── controllers/
│   ├── jobs.controller.ts  # Job CRUD operations
│   └── frames.controller.ts # Frame/image queries
├── db/
│   ├── index.ts           # Database connection
│   ├── schema.ts          # Drizzle ORM schema
│   └── migrations/        # SQL migrations
├── middleware/
│   ├── auth.middleware.ts  # API key authentication
│   └── error.middleware.ts # Error handling
├── processors/             # Composable processor stack
│   ├── types.ts           # IO types and interfaces
│   ├── registry.ts        # Processor registry
│   ├── runner.ts          # Stack runner
│   ├── constants.ts       # Progress constants
│   ├── setup.ts           # Processor registration
│   ├── impl/              # Processor implementations
│   └── templates/         # Pre-defined stacks
├── queues/
│   ├── redis.ts           # Redis connection
│   └── pipeline.queue.ts  # BullMQ queue definition
├── routes/
│   ├── health.routes.ts   # Health check endpoints
│   ├── jobs.routes.ts     # Job management endpoints
│   └── frames.routes.ts   # Frame/image query endpoints
├── services/
│   ├── video.service.ts   # Video processing
│   ├── frame-scoring.service.ts # Quality scoring
│   ├── gemini.service.ts  # AI classification
│   ├── photoroom.service.ts # Image generation
│   ├── storage.service.ts # S3 operations
│   └── pipeline.service.ts # Pipeline orchestration
├── smartFrameExtractor/   # Standalone CLI tool (JavaScript)
├── types/
│   └── job.types.ts       # TypeScript types and Zod schemas
├── utils/
│   ├── errors.ts          # Custom error classes
│   └── logger.ts          # Pino logger configuration
└── workers/
    ├── index.ts           # Worker entry point
    └── pipeline.worker.ts # Job processor
```

## Scaling Considerations

### Horizontal Scaling

- **API servers**: Stateless, can run multiple instances behind load balancer
- **Workers**: Can run multiple instances, each processing jobs independently
- **Redis**: Single instance for coordination (can use Redis Cluster for HA)
- **PostgreSQL**: Single instance (can use read replicas for scaling reads)

### Resource Requirements

- **API**: Low CPU, moderate memory (~256MB)
- **Worker**: High CPU (FFmpeg, image processing), moderate memory (~512MB-1GB)
- **Storage**: Plan for ~50-100MB temp storage per concurrent job

### Bottlenecks

1. **Gemini API**: Rate limited, batching helps
2. **Photoroom API**: Rate limited, sequential per variant
3. **FFmpeg**: CPU-intensive, consider dedicated worker nodes
4. **S3 uploads**: Network bound, parallelized where possible

## Global Configuration System

VOPI includes a database-backed runtime configuration system that allows changing pipeline behavior without redeploying.

### Configuration Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Config API     │────▶│  Global Config  │────▶│  PostgreSQL     │
│  (Admin only)   │     │    Service      │     │  global_config  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │   In-Memory     │
                        │     Cache       │
                        │  (TTL: 60s)     │
                        └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  Pipeline &     │
                        │  Services       │
                        └─────────────────┘
```

### Key Configuration Categories

| Category | Keys | Description |
|----------|------|-------------|
| Pipeline | `pipeline.strategy`, `pipeline.fps`, `pipeline.batchSize` | Control processing behavior |
| AI | `ai.geminiModel`, `ai.temperature`, `ai.topP` | Gemini model settings |
| Scoring | `scoring.motionAlpha`, `scoring.minTemporalGap` | Frame scoring parameters |
| Commercial | `commercial.versions`, `commercial.aiCleanup` | Commercial image settings |
| Gemini Video | `geminiVideo.fps`, `geminiVideo.maxFrames` | Video strategy settings |

### Admin Authorization

Config modification endpoints require admin API keys (separate from regular API keys):
- Set via `ADMIN_API_KEYS` environment variable
- Endpoints: `PUT /config`, `DELETE /config/:key`, `POST /config/seed`
- Regular users can only read config via `GET /config/effective`

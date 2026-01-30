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
│  │  │ Video   │  │ Scoring │  │ Gemini  │  │Stability│  │   Storage   │  │ │
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
| Stability | `stability.service.ts` | Stability AI integration (inpainting, upscaling, commercial) |
| Photoroom | `photoroom.service.ts` | Background removal, commercial image generation (legacy) |
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
8. Upscale with Stability AI (conservative/creative modes)
9. Generate commercial images via Stability AI (transparent, solid, real, creative versions)
10. Upload to S3

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
9. Upscale with Stability AI
10. Generate commercial images via Stability AI
11. Upload to S3

Best for: Longer videos, when you want faster processing without extracting all frames

#### Unified Video Analyzer Strategy (most efficient)
Single Gemini API call for combined audio + video analysis:
1. Download video
2. Unified Gemini analysis (audio transcription + frame selection in one call)
3. Remove background with Claid.ai
4. Fill holes with Stability AI inpainting
5. Center product in frame
6. Upscale with Stability AI
7. Generate commercial images via Stability AI
8. Upload to S3

Best for: Maximum efficiency, when you need both audio metadata and frame selection

#### Full Gemini Stack (no external image APIs)
Uses Gemini for both video analysis AND image generation:
1. Download video
2. Unified Gemini analysis (audio transcription + frame selection, extracts up to 8 frames)
3. Gemini Image Generate (selects 4 best angles, generates 2 variants each: white-studio + lifestyle)
4. Optional quality filtering (AI-powered filtering for product consistency)
5. Upload to S3

Best for: When you want to minimize external API dependencies or prefer Gemini's image generation quality

**Note**: HEVC (H.265) videos from iPhones are automatically transcoded to H.264 since Gemini doesn't support HEVC. The transcoding is optimized for speed:
- Uses `ultrafast` preset and 720p resolution for fast encoding
- Attempts to copy audio stream (instant), falls back to AAC if incompatible
- Includes timeout protection (10 min default, configurable via `VOPI_TRANSCODE_TIMEOUT_MS`)

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
│     ├─ Filter out blurry frames (sharpness < threshold)                 │
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
│ Stability AI    │───────▶ /tmp/vopi/{jobId}/upscaled/
│   upscale       │         hero_upscaled.png
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Stability AI    │───────▶ /tmp/vopi/{jobId}/commercial/
│   commercial    │         hero_transparent.png, hero_solid.png,
│                 │         hero_real.png, hero_creative.png
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

**DataPath Types**: Processors declare what data paths they require and produce using a unified type system:

```typescript
type DataPath =
  // Core data types
  | 'video'                   // Video file data (path, metadata, sourceUrl)
  | 'images'                  // Array of image file paths
  | 'text'                    // Text/string data
  // Audio pipeline paths
  | 'audio'                   // Audio file data (path, format, duration, hasAudio)
  | 'transcript'              // Transcribed text from audio
  | 'product.metadata'        // Structured product metadata for e-commerce
  // Frame metadata paths
  | 'frames'                  // Base frame metadata exists
  | 'frames.scores'           // Frames have score fields (sharpness, motion)
  | 'frames.classifications'  // Frames have classification fields (productId, variantId)
  | 'frames.dbId'             // Frames have database IDs
  | 'frames.s3Url'            // Frames have S3 URLs
  | 'frames.version';         // Frames have commercial version field
```

Any processor that outputs a data path can connect to any processor that requires that path.

### Processor IO Contracts

| Processor | Requires | Produces | Description |
|-----------|----------|----------|-------------|
| download | video | video | Downloads video from URL |
| extract-frames | video | images, frames | Extracts frames with FFmpeg |
| extract-audio | video | audio | Extracts audio track (16kHz mono MP3) |
| gemini-video-analysis | video | images, frames, frames.classifications | Direct video analysis |
| gemini-audio-analysis | audio | transcript, product.metadata | Transcription + metadata extraction |
| score-frames | images, frames | images, frames.scores | Calculates quality scores |
| gemini-classify | images, frames | frames.classifications | AI classification |
| filter-by-score | images, frames, frames.scores | images | Filters by score |
| photoroom-bg-remove | images, frames | images | Background removal (Photoroom) |
| claid-bg-remove | images, frames | images | Background removal (Claid) - swappable |
| stability-bg-remove | images, frames | images | Background removal (Stability AI) |
| center-product | images, frames | images | Centers product in frame |
| rotate-image | images, frames | images | Rotates images |
| fill-product-holes | images, frames | images | Fills transparent holes in products |
| stability-upscale | images, frames | images | Image upscaling (Stability AI) |
| extract-products | images, frames | images | Full product extraction |
| upload-frames | images, frames | text, frames.s3Url | Uploads to S3 |
| stability-commercial | images, frames | images, frames.version | Commercial image generation (Stability AI) |
| generate-commercial | images, frames | images, frames.version | Commercial image generation (Photoroom - legacy) |
| save-frame-records | frames | frames.dbId | Persists to database |
| complete-job | - | - | Finalizes job, uploads metadata.json |
| gemini-unified-video-analyzer | video | images, frames, frames.classifications, transcript, product.metadata | Combined audio + video analysis |
| gemini-image-generate | images, frames | images, frames.version | Native Gemini image generation (white-studio + lifestyle) |
| gemini-quality-filter | images, frames | images | AI-powered quality filtering for product consistency |

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
| `classic` | Full pipeline: extract → score → classify → extract-products → upscale → generate |
| `gemini_video` | Direct video analysis with Gemini |
| `unified_video_analyzer` | Single Gemini call for audio + video, most efficient |
| `unified_video_analyzer_minimal` | Unified analysis without commercial generation |
| `minimal` | Extract and upload without commercial generation |
| `frames_only` | Extract frames with scoring, no AI classification |
| `custom_bg_removal` | Configurable background removal provider |
| `stability_bg_removal` | Uses Stability AI for background removal |
| `full_product_analysis` | Audio-first approach with enhanced frame classification |
| `audio_metadata_only` | Extract audio and generate metadata only |
| `full_gemini` | Gemini for video analysis AND image generation (no external image APIs) |

### Stack Validation

The StackRunner validates stacks before execution:
1. Verifies all processors exist in registry
2. Checks IO flow (each processor's requirements are satisfied by previous outputs)
3. Validates processor swaps have compatible IO contracts

### Processor Concurrency

Each processor has a configurable concurrency limit for parallel operations. Defaults are centralized in `src/processors/concurrency.ts`:

| Processor Type | Default | Rationale |
|----------------|---------|-----------|
| `CLAID_BG_REMOVE` | 5 | External API, 2-5s per request |
| `STABILITY_INPAINT` | 4 | External API, 3-8s per request |
| `STABILITY_BG_REMOVE` | 4 | External API, 2-5s per request |
| `STABILITY_UPSCALE` | 4 | External API, 2-5s per request |
| `STABILITY_COMMERCIAL` | 3 | External API, 3-10s per request (Replace Background + Relight) |
| `SHARP_TRANSFORM` | 8 | CPU-bound local processing, ~50-200ms |
| `PHOTOROOM_GENERATE` | 3 | External API, 2-4s per request |
| `FFMPEG_EXTRACT` | 4 | I/O bound, balanced for disk throughput |
| `GEMINI_CLASSIFY` | 2 | External API, 30-180s per batch |
| `GEMINI_IMAGE_GENERATE` | 2 | External API, Gemini native image generation |
| `GEMINI_QUALITY_FILTER` | 2 | External API, image quality evaluation |
| `S3_UPLOAD` | 6 | Network I/O, connection reuse via keep-alive |

**Override via processor options**:
```typescript
// In stack configuration
{
  processorOptions: {
    'claid-bg-remove': { concurrency: 10 }
  }
}
```

**Override via environment variables**:
```bash
# All concurrency settings can be overridden via VOPI_CONCURRENCY_* env vars
VOPI_CONCURRENCY_GEMINI_CLASSIFY=4
VOPI_CONCURRENCY_S3_UPLOAD=10
VOPI_CONCURRENCY_CLAID_BG_REMOVE=8
VOPI_CONCURRENCY_STABILITY_COMMERCIAL=5
VOPI_CONCURRENCY_STABILITY_UPSCALE=6
VOPI_CONCURRENCY_GEMINI_IMAGE_GENERATE=3
VOPI_CONCURRENCY_GEMINI_QUALITY_FILTER=3
```

### Token Usage Tracking

The stack runner automatically tracks Gemini API token usage across all processors in a pipeline run. A `TokenUsageTracker` is created at the start of each `execute()` call and attached to `ProcessorContext`. Each Gemini provider captures `response.usageMetadata` (promptTokenCount, candidatesTokenCount) after every `generateContent()` call and records it via the tracker.

At the end of stack execution, a summary is logged with per-processor+model breakdowns and totals:

```
Token Usage Summary:
  Processor                      | Model             | Calls | Prompt | Candidates | Total
  gemini-unified-video-analyzer  | gemini-2.0-flash  |     1 |  12543 |       1832 | 14375
  gemini-image-generate          | gemini-2.5-flash  |     8 |   8201 |       4521 | 12722
  TOTAL                          |                   |     9 |  20744 |       6353 | 27097
```

Tracked call sites:
- `gemini.service.ts` — frame classification
- `gemini-audio-analysis.provider.ts` — audio transcription
- `gemini-video-analysis.provider.ts` — video analysis
- `gemini-unified-video-analyzer.provider.ts` — combined audio+video analysis
- `gemini-image-generate.provider.ts` — native image generation
- `gemini-quality-filter.provider.ts` — quality filtering

### Key Files

| File | Purpose |
|------|---------|
| `src/processors/types.ts` | IOType, Processor, Stack interfaces |
| `src/processors/registry.ts` | ProcessorRegistry for managing processors |
| `src/processors/runner.ts` | StackRunner with validation and execution |
| `src/processors/concurrency.ts` | Centralized concurrency configuration |
| `src/processors/templates/index.ts` | Pre-defined stack templates |
| `src/processors/impl/` | Individual processor implementations |
| `src/utils/token-usage.ts` | Gemini token usage tracking utility |

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
│   ├── concurrency.ts     # Centralized concurrency configuration
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
2. **Stability AI API**: Rate limited, concurrent requests help but watch limits
3. **FFmpeg**: CPU-intensive, consider dedicated worker nodes
4. **S3 uploads**: Network bound, parallelized with keep-alive connections

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
| AI | `ai.geminiModel`, `ai.geminiVideoModel`, `ai.geminiImageModel`, `ai.temperature`, `ai.topP` | Gemini model settings |
| Scoring | `scoring.motionAlpha`, `scoring.minTemporalGap` | Frame scoring parameters |
| Commercial | `commercial.versions`, `commercial.aiCleanup` | Commercial image settings |
| Gemini Video | `geminiVideo.fps`, `geminiVideo.maxFrames` | Video strategy settings |

### Admin Authorization

Config modification endpoints require admin API keys (separate from regular API keys):
- Set via `ADMIN_API_KEYS` environment variable
- Endpoints: `PUT /config`, `DELETE /config/:key`, `POST /config/seed`
- Regular users can only read config via `GET /config/effective`

## Audio Analysis Pipeline

VOPI includes an optional audio analysis pipeline that extracts audio from product videos, transcribes it using Gemini 2.0 Flash, and generates structured e-commerce metadata.

### Audio Pipeline Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Audio Analysis Pipeline                            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. EXTRACT AUDIO                                                        │
│     ├─ Use FFmpeg to extract audio track from video                     │
│     ├─ Convert to 16kHz mono MP3 (optimized for speech recognition)     │
│     └─ Check if video has audio track (skip if no audio)                │
│                                                                          │
│  2. UPLOAD TO GEMINI                                                     │
│     ├─ Upload audio to Gemini Files API                                 │
│     ├─ Wait for processing (with configurable timeout)                  │
│     └─ Handle processing failures gracefully                            │
│                                                                          │
│  3. TRANSCRIBE & ANALYZE                                                 │
│     ├─ Send audio to Gemini 2.0 Flash with analysis prompt              │
│     ├─ Extract: transcript, product title, description, features        │
│     ├─ Detect: brand, materials, colors, sizes, price mentions          │
│     └─ Calculate confidence scores for each field                       │
│                                                                          │
│  4. FORMAT FOR PLATFORMS                                                 │
│     ├─ Shopify: GraphQL productSet mutation format (API 2026-01)        │
│     ├─ Amazon: SP-API Listings Items format (item_name, bullet_point)   │
│     └─ eBay: Inventory API format (title max 80 chars, aspects)         │
│                                                                          │
│  5. SAVE METADATA                                                        │
│     ├─ Generate metadata.json with all platform formats                 │
│     ├─ Upload to S3 alongside frame images                              │
│     └─ Store metadata S3 URL in jobs table                              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Metadata Output Structure

The pipeline generates a `metadata.json` file in S3:

```json
{
  "transcript": "Full audio transcription from seller's description...",
  "product": {
    "title": "Product Name",
    "description": "Full HTML/text description",
    "shortDescription": "Brief summary",
    "bulletPoints": ["Feature 1", "Feature 2", "Feature 3"],
    "brand": "Brand Name",
    "materials": ["leather", "cotton"],
    "color": "Black",
    "colors": ["Black", "Brown"],
    "size": "Large",
    "sizes": ["S", "M", "L", "XL"],
    "category": "Clothing",
    "keywords": ["keyword1", "keyword2"],
    "condition": "new",
    "confidence": {
      "overall": 85,
      "title": 90,
      "description": 80,
      "price": 70,
      "attributes": 85
    },
    "extractedFromAudio": true,
    "transcriptExcerpts": ["relevant quote 1", "relevant quote 2"]
  },
  "platforms": {
    "shopify": { /* Shopify GraphQL format */ },
    "amazon": { /* SP-API format */ },
    "ebay": { /* Inventory API format */ }
  },
  "extractedAt": "2026-01-22T12:00:00.000Z",
  "audioDuration": 45.2,
  "pipelineVersion": "2.0.0"
}
```

### Platform Format Mapping

| Field | Shopify | Amazon | eBay |
|-------|---------|--------|------|
| Title | `title` | `item_name` | `title` (max 80 chars) |
| Description | `descriptionHtml` | `product_description` | `description` |
| Features | - | `bullet_point` (max 5) | - |
| Brand | `vendor` | `brand_name` | `aspects.Brand` |
| Keywords | `tags` | `generic_keyword` | - |
| Weight | `variants[].weight` + `weightUnit` | `item_weight.value` + `unit` | `packageWeightAndSize.weight` |
| Condition | - | `condition_type` | `condition` |

### Audio Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIO_PROCESSING_TIMEOUT_MS` | 180000 | Gemini file processing timeout (3 minutes) |
| `AUDIO_POLLING_INTERVAL_MS` | 3000 | Polling interval for processing status |
| `AUDIO_MAX_RETRIES` | 3 | Max retries for audio analysis API calls |

### Video Transcoding Configuration

HEVC videos (common from iPhones) are automatically transcoded to H.264 for Gemini compatibility. The transcoding is optimized for speed over quality since the output is only used for AI analysis.

| Variable | Default | Description |
|----------|---------|-------------|
| `VOPI_TRANSCODE_HEIGHT` | 720 | Target video height (720p balances quality and speed) |
| `VOPI_TRANSCODE_TIMEOUT_MS` | 600000 | Timeout for transcoding operations (10 minutes) |
| `VOPI_FFPROBE_TIMEOUT_MS` | 30000 | Timeout for codec detection (30 seconds) |

**Transcoding settings** (hardcoded for optimal speed):
- **Preset**: `ultrafast` - Fastest software encoding (~3-5x faster than `fast`)
- **CRF**: `28` - Acceptable quality for AI analysis
- **Audio**: Attempts copy first, falls back to AAC 128k if incompatible
- **Threads**: Uses all available CPU cores

### Edge Cases

1. **No audio track**: Pipeline detects and skips gracefully, sets `extractedFromAudio: false`
2. **Poor audio quality**: Lower confidence scores, all fields still extracted where possible
3. **Processing timeout**: Configurable timeout, fails gracefully without blocking pipeline
4. **API failures**: Retry with exponential backoff, graceful degradation if all retries fail

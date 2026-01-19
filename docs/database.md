# Database Documentation

VOPI uses PostgreSQL 16 with Drizzle ORM for database operations.

## Schema Overview

```
┌─────────────────┐
│      jobs       │
│─────────────────│
│ id (PK)         │
│ status          │
│ videoUrl        │
│ config          │
│ progress        │
│ result          │
│ error           │
│ callbackUrl     │
│ timestamps      │
└────────┬────────┘
         │
         │ 1:1
         ▼
┌─────────────────┐
│     videos      │
│─────────────────│
│ id (PK)         │
│ jobId (FK)      │────────┐
│ sourceUrl       │        │
│ duration        │        │
│ dimensions      │        │
│ metadata        │        │
└────────┬────────┘        │
         │                 │
         │ 1:N             │
         ▼                 │
┌─────────────────┐        │
│     frames      │        │
│─────────────────│        │
│ id (PK)         │        │
│ jobId (FK)      │◄───────┘
│ videoId (FK)    │
│ frameId         │
│ timestamp       │
│ scores          │
│ classification  │
│ flags           │
└────────┬────────┘
         │
         │ 1:N
         ▼
┌─────────────────┐
│commercial_images│
│─────────────────│
│ id (PK)         │
│ jobId (FK)      │
│ frameId (FK)    │
│ version         │
│ s3Url           │
│ background      │
│ status          │
└─────────────────┘
```

## Tables

### jobs

Main table tracking processing jobs.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | No | `gen_random_uuid()` | Primary key |
| `status` | VARCHAR(50) | No | `'pending'` | Current job status |
| `video_url` | TEXT | No | - | Source video URL |
| `config` | JSONB | No | - | Job configuration |
| `progress` | JSONB | Yes | - | Current progress info |
| `result` | JSONB | Yes | - | Final results on completion |
| `error` | TEXT | Yes | - | Error message if failed |
| `callback_url` | TEXT | Yes | - | Webhook URL for notifications |
| `created_at` | TIMESTAMP | No | `now()` | Creation timestamp |
| `updated_at` | TIMESTAMP | No | `now()` | Last update timestamp |
| `started_at` | TIMESTAMP | Yes | - | Processing start time |
| `completed_at` | TIMESTAMP | Yes | - | Processing end time |

**Status Values**:
- `pending` - Job created, waiting for worker
- `downloading` - Downloading video from URL
- `extracting` - Extracting frames with FFmpeg
- `scoring` - Computing quality scores
- `classifying` - AI classification in progress
- `generating` - Creating commercial images
- `completed` - Successfully finished
- `failed` - Processing failed
- `cancelled` - Cancelled by user

**Config Schema** (JSONB):
```typescript
{
  fps: number;              // Frame extraction rate
  batchSize: number;        // Gemini batch size
  commercialVersions: string[];  // Versions to generate
  aiCleanup: boolean;       // Remove obstructions
  geminiModel: string;      // Model name
}
```

**Progress Schema** (JSONB):
```typescript
{
  step: string;           // Current status
  percentage: number;     // 0-100
  message: string;        // Human-readable
  totalSteps: number;     // Total pipeline steps
  currentStep: number;    // Current step number
}
```

**Result Schema** (JSONB):
```typescript
{
  variantsDiscovered: number;
  framesAnalyzed: number;
  finalFrames: string[];      // S3 URLs
  commercialImages: {
    [variantName]: {
      [version]: string       // S3 URL
    }
  }
}
```

---

### videos

Video metadata for each job.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | No | `gen_random_uuid()` | Primary key |
| `job_id` | UUID | No | - | Foreign key to jobs |
| `source_url` | TEXT | No | - | Original video URL |
| `local_path` | TEXT | Yes | - | Temp file path during processing |
| `duration` | REAL | Yes | - | Video duration in seconds |
| `width` | INTEGER | Yes | - | Frame width in pixels |
| `height` | INTEGER | Yes | - | Frame height in pixels |
| `fps` | REAL | Yes | - | Video frame rate |
| `codec` | VARCHAR(50) | Yes | - | Video codec (e.g., "h264") |
| `metadata` | JSONB | Yes | - | Full ffprobe metadata |
| `created_at` | TIMESTAMP | No | `now()` | Creation timestamp |

**Foreign Keys**:
- `job_id` → `jobs.id` (CASCADE DELETE)

---

### frames

Extracted and scored frames.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | No | `gen_random_uuid()` | Primary key |
| `job_id` | UUID | No | - | Foreign key to jobs |
| `video_id` | UUID | No | - | Foreign key to videos |
| `frame_id` | VARCHAR(50) | No | - | Frame identifier (e.g., "frame_00001") |
| `timestamp` | REAL | No | - | Timestamp in seconds |
| `local_path` | TEXT | Yes | - | Temp file path |
| `s3_url` | TEXT | Yes | - | S3 URL if uploaded |
| `scores` | JSONB | Yes | - | Quality scores |
| `product_id` | VARCHAR(50) | Yes | - | Gemini product ID |
| `variant_id` | VARCHAR(50) | Yes | - | Gemini variant ID |
| `angle_estimate` | VARCHAR(50) | Yes | - | Estimated angle |
| `variant_description` | TEXT | Yes | - | Variant description |
| `obstructions` | JSONB | Yes | - | Detected obstructions |
| `background_recommendations` | JSONB | Yes | - | AI background suggestions |
| `is_best_per_second` | BOOLEAN | Yes | `false` | Best in its second |
| `is_final_selection` | BOOLEAN | Yes | `false` | Selected for output |
| `created_at` | TIMESTAMP | No | `now()` | Creation timestamp |

**Foreign Keys**:
- `job_id` → `jobs.id` (CASCADE DELETE)
- `video_id` → `videos.id` (CASCADE DELETE)

**Scores Schema** (JSONB):
```typescript
{
  sharpness: number;    // Laplacian variance
  motion: number;       // 0-1 motion score
  combined: number;     // Final combined score
  geminiScore?: number; // AI quality rating (0-100)
}
```

**Obstructions Schema** (JSONB):
```typescript
{
  has_obstruction: boolean;
  obstruction_types: string[];  // ["hand", "cord", etc.]
  obstruction_description: string | null;
  removable_by_ai: boolean;
}
```

**Background Recommendations Schema** (JSONB):
```typescript
{
  solid_color: string;        // Hex color
  solid_color_name: string;   // e.g., "Light Gray"
  real_life_setting: string;  // Setting description
  creative_shot: string;      // Creative concept
}
```

---

### commercial_images

Generated commercial product images.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | No | `gen_random_uuid()` | Primary key |
| `job_id` | UUID | No | - | Foreign key to jobs |
| `frame_id` | UUID | No | - | Foreign key to frames |
| `version` | VARCHAR(20) | No | - | Image version type |
| `local_path` | TEXT | Yes | - | Temp file path |
| `s3_url` | TEXT | Yes | - | S3 URL if uploaded |
| `background_color` | VARCHAR(20) | Yes | - | Solid background hex color |
| `background_prompt` | TEXT | Yes | - | AI generation prompt |
| `success` | BOOLEAN | Yes | `true` | Generation succeeded |
| `error` | TEXT | Yes | - | Error message if failed |
| `created_at` | TIMESTAMP | No | `now()` | Creation timestamp |

**Foreign Keys**:
- `job_id` → `jobs.id` (CASCADE DELETE)
- `frame_id` → `frames.id` (CASCADE DELETE)

**Version Values**:
- `transparent` - PNG with transparent background
- `solid` - Solid color background
- `real` - Realistic lifestyle setting
- `creative` - Artistic/promotional style

---

## Relations

Drizzle ORM relations are defined for easy querying:

```typescript
// Job has one video
jobsRelations: jobs.id → videos.jobId (one-to-one)

// Job has many frames
jobsRelations: jobs.id → frames.jobId (one-to-many)

// Job has many commercial images
jobsRelations: jobs.id → commercialImages.jobId (one-to-many)

// Video has many frames
videosRelations: videos.id → frames.videoId (one-to-many)

// Frame has many commercial images
framesRelations: frames.id → commercialImages.frameId (one-to-many)
```

All foreign keys use `CASCADE DELETE` - deleting a job removes all related records.

---

## Migrations

Migrations are managed with Drizzle Kit.

### Commands

```bash
# Generate migration from schema changes
pnpm db:generate

# Run pending migrations
pnpm db:migrate

# Push schema directly (dev only)
pnpm db:push

# Open Drizzle Studio GUI
pnpm db:studio
```

### Initial Migration

Location: `src/db/migrations/0001_initial.sql`

Creates all four tables with:
- UUID primary keys with default random generation
- Timestamp columns with defaults
- Foreign key constraints with cascade delete
- JSONB columns for flexible data storage

---

## Indexes

The schema relies on primary key indexes. For production workloads, consider adding:

```sql
-- Status filtering
CREATE INDEX idx_jobs_status ON jobs(status);

-- Job queries
CREATE INDEX idx_videos_job_id ON videos(job_id);
CREATE INDEX idx_frames_job_id ON frames(job_id);
CREATE INDEX idx_frames_video_id ON frames(video_id);
CREATE INDEX idx_commercial_images_job_id ON commercial_images(job_id);
CREATE INDEX idx_commercial_images_frame_id ON commercial_images(frame_id);

-- Final frame filtering
CREATE INDEX idx_frames_final ON frames(job_id) WHERE is_final_selection = true;
```

---

## Drizzle Configuration

**File**: `drizzle.config.ts`

```typescript
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

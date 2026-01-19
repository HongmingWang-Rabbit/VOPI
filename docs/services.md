# Services Documentation

The `/src/services/` directory contains the core business logic modules. Each service is a singleton class with methods for specific domain operations.

## Service Overview

| Service | File | Purpose |
|---------|------|---------|
| **Video** | `video.service.ts` | FFmpeg operations for frame extraction |
| **Frame Scoring** | `frame-scoring.service.ts` | Quality analysis and candidate selection |
| **Gemini** | `gemini.service.ts` | AI classification via Google Gemini |
| **Photoroom** | `photoroom.service.ts` | Background removal and image generation |
| **Storage** | `storage.service.ts` | S3/MinIO file operations |
| **Pipeline** | `pipeline.service.ts` | Orchestrates the full processing pipeline |

---

## Video Service

**File**: `src/services/video.service.ts`

Handles all FFmpeg-based video processing operations.

### Methods

#### `getMetadata(videoPath: string): Promise<VideoMetadata>`

Extract video metadata using ffprobe.

**Returns**:
```typescript
interface VideoMetadata {
  duration: number;    // Duration in seconds
  width: number;       // Frame width in pixels
  height: number;      // Frame height in pixels
  fps: number;         // Frames per second
  codec: string;       // Video codec (e.g., "h264")
  filename: string;    // Original filename
}
```

#### `extractFramesDense(videoPath, outputDir, options): Promise<ExtractedFrame[]>`

Extract frames at a fixed FPS rate.

**Options**:
```typescript
interface ExtractFramesOptions {
  fps?: number;         // Extraction rate (default: 5)
  quality?: number;     // FFmpeg quality (default: 2, lower = better)
  scale?: string | null; // Optional scale filter
}
```

**Returns**:
```typescript
interface ExtractedFrame {
  filename: string;     // e.g., "frame_00001_t0.10.png"
  path: string;         // Full path to file
  index: number;        // Frame sequence number
  timestamp: number;    // Timestamp in seconds
  frameId: string;      // e.g., "frame_00001"
}
```

#### `extractSingleFrame(videoPath, timestamp, outputPath, options): Promise<string>`

Extract a single high-quality frame at an exact timestamp.

#### `extractBestFrameInWindow(videoPath, centerTimestamp, outputPath, scoreFunction, options)`

Extract the best frame within a time window using a custom scoring function.

### Dependencies

- FFmpeg and FFprobe must be installed and available in PATH
- Configurable via `FFMPEG_PATH` and `FFPROBE_PATH` environment variables

### Configuration

FFmpeg paths are loaded from application config:
```typescript
const config = getConfig();
const ffmpegPath = config.ffmpeg.ffmpegPath;   // Default: 'ffmpeg'
const ffprobePath = config.ffmpeg.ffprobePath; // Default: 'ffprobe'
```

---

## Frame Scoring Service

**File**: `src/services/frame-scoring.service.ts`

Analyzes frame quality using image processing algorithms.

### Scoring Algorithm

```
combined_score = sharpness - (alpha × motion × 255)
```

- **Sharpness**: Laplacian variance of grayscale image (higher = more in-focus)
- **Motion**: Average pixel difference from previous frame (lower = still moment)
- **Alpha**: Weight factor for motion penalty (default: 0.2)

### Named Constants

The service uses documented constants for all magic numbers:

```typescript
const SCORING_CONSTANTS = {
  MOTION_COMPARISON_SIZE: 256,    // Image resize for motion comparison
  MAX_PIXEL_VALUE: 255,           // For normalization
  LOW_SHARPNESS_THRESHOLD: 5,     // Poor quality threshold
  HIGH_MOTION_THRESHOLD: 0.2,     // High motion detection
  LOW_MOTION_THRESHOLD: 0.1,      // Low motion detection
  MIN_LOW_MOTION_FRAMES: 5,       // Minimum for good quality
};
```

### Configuration

```typescript
interface ScoringConfig {
  alpha?: number;              // Motion penalty weight (default: 0.2)
  topK?: number;              // Max candidates to select (default: 24)
  minTemporalGap?: number;    // Min seconds between selections (default: 0.3)
  minSharpnessThreshold?: number;
  motionNormalizationFactor?: number;
}
```

### Methods

#### `computeSharpness(imagePath: string): Promise<number>`

Calculate sharpness using Laplacian variance approximation.

**Algorithm**:
1. Convert image to grayscale
2. Apply Laplacian operator (edge detection)
3. Calculate variance of result
4. Return square root of variance

#### `computeMotion(prevPath: string | null, currPath: string): Promise<number>`

Calculate motion score between consecutive frames.

**Algorithm**:
1. Resize both frames to 256x256 grayscale
2. Calculate absolute pixel-wise difference
3. Return normalized average (0-1 range)

#### `scoreFrames(frames, config, onProgress): Promise<ScoredFrame[]>`

Score all extracted frames for quality.

**Returns**:
```typescript
interface ScoredFrame extends ExtractedFrame {
  sharpness: number;  // Laplacian variance
  motion: number;     // 0-1, lower = less motion
  score: number;      // Combined score
}
```

#### `selectBestFramePerSecond(scoredFrames): ScoredFrame[]`

Select the highest-scoring frame from each second of video. This provides a diverse set of candidate frames for AI classification.

#### `selectCandidates(scoredFrames, config): { candidates, unusableReason }`

Select top candidates with temporal diversity enforcement.

#### `generateQualityReport(scoredFrames, videoMetadata): QualityReport`

Generate a human-readable quality report with tips for improvement.

---

## Gemini Service

**File**: `src/services/gemini.service.ts`

Integrates with Google Gemini 2.0 Flash for AI-powered frame classification.

### Purpose

1. **Product Detection**: Identify distinct products in the video
2. **Variant Discovery**: Find unique views/angles of each product
3. **Quality Scoring**: Rate frame quality for AI image generation
4. **Obstruction Detection**: Identify hands, cords, tags, etc.
5. **Background Recommendations**: Suggest colors and settings

### Classification Output

```typescript
interface GeminiResponse {
  products_detected: Array<{
    product_id: string;
    description: string;
    product_category: string;
  }>;
  frame_evaluation: Array<{
    frame_id: string;
    timestamp_sec: number;
    product_id: string;
    variant_id: string;
    angle_estimate: string;
    quality_score_0_100: number;
    similarity_note: string;
    obstructions: FrameObstructions;
  }>;
  variants_discovered: Array<{
    product_id: string;
    variant_id: string;
    description: string;
    best_frame_id: string;
    obstructions: FrameObstructions;
    background_recommendations: BackgroundRecommendations;
  }>;
}
```

### Obstruction Types

| Type | Description |
|------|-------------|
| `hand` | Human hand holding product |
| `finger` | Fingers touching product |
| `arm` | Arm visible in frame |
| `cord` | Power cords, cables |
| `tag` | Price tags, labels |
| `reflection` | Unwanted reflections |
| `shadow` | Harsh shadows |
| `other_object` | Any other covering object |

### Background Recommendations

```typescript
interface BackgroundRecommendations {
  solid_color: string;      // Hex color code
  solid_color_name: string; // Human-readable name
  real_life_setting: string; // Lifestyle setting description
  creative_shot: string;     // Artistic concept description
}
```

### Methods

#### `classifyFrames(frames, metadata, videoMetadata, options): Promise<GeminiResponse>`

Send batch of frames to Gemini for classification.

**Options**:
```typescript
{
  model?: string;       // Model name (default from GEMINI_MODEL env)
  maxRetries?: number;  // Retry attempts (default: 3)
  retryDelay?: number;  // Base delay for retries (from API_RETRY_DELAY_MS)
}
```

#### `getRecommendedFrames(response, frames): RecommendedFrame[]`

Extract recommended frames from Gemini response, selecting the best frame for each discovered variant.

### Configuration

Model and prompts are configurable:
- `GEMINI_MODEL`: Model to use (default: `gemini-2.0-flash`)
- System prompt and output schema stored in `src/templates/`

### Cost Optimization

- Only candidate frames (best per second) are sent to Gemini
- Frames are batched to reduce API calls
- Image data is base64-encoded inline (no upload needed)
- Automatic retry with exponential backoff on failures

---

## Photoroom Service

**File**: `src/services/photoroom.service.ts`

Integrates with Photoroom API for background removal and commercial image generation.

### Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `{PHOTOROOM_BASIC_HOST}/v1/segment` | Basic background removal |
| `{PHOTOROOM_PLUS_HOST}/v2/edit` | AI-powered editing and generation |

Hosts are configurable via environment variables (defaults: `sdk.photoroom.com`, `image-api.photoroom.com`).

### Commercial Image Versions

| Version | Description | Generation Method |
|---------|-------------|-------------------|
| `transparent` | PNG with transparent background | Basic segmentation |
| `solid` | Solid color background | Edit API with color |
| `real` | Realistic lifestyle setting | Edit API with prompt |
| `creative` | Artistic marketing shot | Edit API with prompt |

### Methods

#### `removeBackground(imagePath, outputPath): Promise<ProcessResult>`

Remove background using basic segmentation API.

#### `generateWithBackground(imagePath, outputPath, options): Promise<ProcessResult>`

Generate commercial image with specified background.

**Options**:
```typescript
{
  backgroundColor?: string;  // Hex color for solid backgrounds
  prompt?: string;           // Text prompt for AI generation
}
```

#### `generateAllVersions(frame, outputDir, options): Promise<AllVersionsResult>`

Generate all commercial versions for a frame.

**Options**:
```typescript
{
  useAIEdit?: boolean;  // Use AI to remove obstructions first
  versions?: string[];  // Which versions to generate
}
```

### AI Cleanup

When `aiCleanup: true` and obstructions are detected, Photoroom's edit API is used to remove hands, cords, and other obstructions before generating commercial images.

### Rate Limiting

API calls are rate-limited with configurable delays:
- `API_RATE_LIMIT_DELAY_MS`: Delay between API calls (default: 500ms)
- `API_RETRY_DELAY_MS`: Base delay for retries with exponential backoff

---

## Storage Service

**File**: `src/services/storage.service.ts`

Handles S3-compatible storage operations (AWS S3 or MinIO).

### Methods

#### `init(): S3Client`

Initialize or return cached S3 client.

#### `uploadFile(localPath, s3Key): Promise<UploadResult>`

Upload a local file to S3.

**Returns**:
```typescript
interface UploadResult {
  key: string;   // S3 object key
  url: string;   // Public URL
  size: number;  // File size in bytes
}
```

#### `uploadBuffer(buffer, s3Key, contentType): Promise<UploadResult>`

Upload a buffer directly to S3.

#### `downloadFile(s3Key, localPath): Promise<void>`

Download a file from S3 to local path.

#### `downloadFromUrl(url, localPath): Promise<void>`

Download a file from any URL (HTTP, HTTPS, or S3).

#### `getPresignedUrl(s3Key, expiresIn): Promise<string>`

Generate a presigned URL for temporary access.

#### `getPublicUrl(s3Key): string`

Get the public URL for an S3 object.

#### `getJobKey(jobId, category, filename): string`

Generate standardized S3 key for job assets.

**Pattern**: `jobs/{jobId}/{category}/{filename}`

### Configuration

Configured via environment variables:
- `S3_BUCKET`: Bucket name
- `S3_REGION`: AWS region
- `S3_ENDPOINT`: Custom endpoint (for MinIO)
- `S3_ACCESS_KEY_ID`: Access key
- `S3_SECRET_ACCESS_KEY`: Secret key
- `S3_FORCE_PATH_STYLE`: Use path-style URLs (required for MinIO)

---

## Pipeline Service

**File**: `src/services/pipeline.service.ts`

Orchestrates the complete processing pipeline, coordinating all other services.

### Pipeline Steps

1. **Download** (5%) - Fetch video from URL
2. **Extract** (10-15%) - Get metadata and extract frames
3. **Score** (30-45%) - Calculate quality scores
4. **Classify** (50-65%) - AI variant discovery
5. **Generate** (70-95%) - Commercial image creation
6. **Complete** (100%) - Finalize and cleanup

### Methods

#### `runPipeline(job, onProgress): Promise<JobResult>`

Execute the full pipeline for a job.

**Parameters**:
- `job`: Job record from database
- `onProgress`: Optional callback for progress updates

**Returns**:
```typescript
interface JobResult {
  variantsDiscovered: number;
  framesAnalyzed: number;
  finalFrames: string[];           // S3 URLs
  commercialImages: Record<string, Record<string, string>>;
}
```

### Progress Updates

Progress is reported via callback and persisted to database:

```typescript
interface PipelineProgress {
  status: JobStatus;
  percentage: number;
  message?: string;
  step?: number;
  totalSteps?: number;
}
```

### Error Handling

- Errors are caught and persisted to job record
- Job status is set to `failed` with error message
- Temp directory is cleaned up even on failure

### Temp Directory Structure

```
/tmp/{TEMP_DIR_NAME}/{jobId}/
├── video/          # Downloaded video
├── frames/         # All extracted frames
├── candidates/     # Best frame per second
├── final/          # AI-selected variants
└── commercial/     # Generated images
```

The temp directory name is configurable via `TEMP_DIR_NAME` (default: `vopi`).

All temp files are cleaned up after pipeline completion (success or failure).

### Refactored Architecture

The pipeline service has been refactored for better maintainability:

- **PipelineContext**: Shared context passed between pipeline steps
- **WorkDirs**: Structured working directory configuration
- Modular step functions for each pipeline phase
- Job config validation using Zod schemas

---

## URL Validator Utility

**File**: `src/utils/url-validator.ts`

Provides URL validation utilities for SSRF protection.

### Methods

#### `isCallbackUrlAllowed(url: string): boolean`

Check if a callback URL domain is in the allowed list.

#### `isSafeProtocol(url: string): boolean`

Verify URL uses http or https protocol.

#### `isPrivateUrl(url: string): boolean`

Detect if URL targets private/internal IP addresses (localhost, 10.x.x.x, 172.16-31.x.x, 192.168.x.x).

#### `validateCallbackUrlComprehensive(url: string): { valid: boolean; error?: string }`

Full validation combining protocol, private IP, and domain checks.

### Configuration

- `CALLBACK_ALLOWED_DOMAINS`: Comma-separated whitelist of allowed callback domains
- Private URL blocking is relaxed in development mode

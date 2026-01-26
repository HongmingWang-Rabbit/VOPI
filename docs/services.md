# Services Documentation

The `/src/services/` directory contains the core business logic modules. Each service is a singleton class with methods for specific domain operations.

## Service Overview

| Service | File | Purpose |
|---------|------|---------|
| **Auth** | `auth.service.ts` | JWT token generation, verification, and user management |
| **Credits** | `credits.service.ts` | User credits balance and transaction management |
| **Video** | `video.service.ts` | FFmpeg operations for frame extraction |
| **Frame Scoring** | `frame-scoring.service.ts` | Quality analysis and candidate selection |
| **Gemini** | `gemini.service.ts` | AI classification via Google Gemini |
| **Gemini Audio** | `gemini-audio-analysis.provider.ts` | Audio transcription and metadata extraction |
| **Gemini Image** | `gemini-image-generate.provider.ts` | Native Gemini image generation |
| **Gemini Quality Filter** | `gemini-quality-filter.provider.ts` | AI-powered image quality filtering |
| **Photoroom** | `photoroom.service.ts` | Background removal and image generation |
| **Stability** | `stability.service.ts` | AI inpainting, upscaling, and commercial image generation |
| **Storage** | `storage.service.ts` | S3/MinIO file operations |
| **Pipeline** | `pipeline.service.ts` | Orchestrates the full processing pipeline |
| **Global Config** | `global-config.service.ts` | Runtime configuration with caching |
| **Stripe** | `stripe.service.ts` | Payment processing and checkout sessions |
| **State Store** | `state-store.service.ts` | OAuth state storage (Redis/memory) |

---

## Auth Service

**File**: `src/services/auth.service.ts`

Handles JWT token generation, verification, refresh token rotation, and user management for OAuth authentication.

### Methods

#### `generateAccessToken(user): string`

Generate a JWT access token for a user.

**Parameters**:
- `user` - Object with `id` and `email` fields

**Returns**: JWT access token string (expires based on `JWT_ACCESS_TOKEN_EXPIRES_IN`)

#### `generateRefreshToken(user, deviceInfo?): Promise<string>`

Generate a refresh token and store its hash in the database.

**Parameters**:
- `user` - Object with `id` field
- `deviceInfo` - Optional device identification for tracking

**Returns**: Refresh token string

**Note**: Token hash is stored in `refresh_tokens` table for validation and revocation.

#### `verifyAccessToken(token): JwtPayload`

Verify and decode an access token.

**Throws**:
- `AccessTokenExpiredError` - Token has expired
- `AccessTokenInvalidError` - Signature verification failed
- `AccessTokenMalformedError` - Token is not valid JWT format
- `AccessTokenWrongTypeError` - Token type is not "access"

#### `refreshAccessToken(refreshToken, deviceInfo?): Promise<TokenPair>`

Refresh an expired access token using a refresh token. Implements token rotation for security.

**Returns**:
```typescript
{
  accessToken: string;
  refreshToken: string;  // New token (old one is revoked)
  expiresIn: number;     // Seconds until access token expires
}
```

**Throws**:
- `RefreshTokenExpiredError` - Token has expired
- `RefreshTokenInvalidError` - Signature verification failed
- `RefreshTokenRevokedError` - Token was explicitly revoked
- `RefreshTokenReusedError` - Token was already used (security alert)
- `UserNotFoundError` - User no longer exists
- `UserDeletedError` - User account was deleted

#### `findOrCreateUserFromOAuth(provider, profile, tokens, deviceInfo?): Promise<User>`

Find existing user or create new one from OAuth profile.

**Behavior**:
1. If OAuth account exists → update tokens, return user
2. If user email exists → link OAuth account, return user
3. Otherwise → create new user + OAuth account

**Note**: New users automatically receive signup credits (abuse-protected).

#### `revokeRefreshToken(token): Promise<void>`

Revoke a specific refresh token (for logout).

#### `revokeAllRefreshTokens(userId): Promise<void>`

Revoke all refresh tokens for a user (logout from all devices).

### Error Classes

Auth errors are defined in `src/utils/auth-errors.ts`:

| Error Class | Code | Description |
|-------------|------|-------------|
| `AccessTokenExpiredError` | `ACCESS_TOKEN_EXPIRED` | JWT has expired |
| `AccessTokenInvalidError` | `ACCESS_TOKEN_INVALID` | Signature verification failed |
| `AccessTokenMalformedError` | `ACCESS_TOKEN_MALFORMED` | Not a valid JWT structure |
| `AccessTokenWrongTypeError` | `ACCESS_TOKEN_WRONG_TYPE` | Wrong token type |
| `RefreshTokenExpiredError` | `REFRESH_TOKEN_EXPIRED` | Token has expired |
| `RefreshTokenInvalidError` | `REFRESH_TOKEN_INVALID` | Signature verification failed |
| `RefreshTokenRevokedError` | `REFRESH_TOKEN_REVOKED` | Token was explicitly revoked |
| `RefreshTokenReusedError` | `REFRESH_TOKEN_REUSED` | Possible token theft |
| `UserNotFoundError` | `USER_NOT_FOUND` | User doesn't exist |
| `UserDeletedError` | `USER_DELETED` | User account deleted |

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

## Gemini Audio Analysis Provider

**File**: `src/providers/implementations/gemini-audio-analysis.provider.ts`

Transcribes audio from product videos and extracts structured e-commerce metadata using Gemini 2.0 Flash.

### Methods

#### `analyzeAudio(audioPath, options): Promise<AudioAnalysisResult>`

Upload audio to Gemini Files API and analyze for product metadata.

**Options**:
```typescript
interface AudioAnalysisOptions {
  model?: string;          // Gemini model (default from config)
  maxBulletPoints?: number; // Max bullet points to extract (default: 5)
  maxRetries?: number;     // Retry attempts (default: 3)
  retryDelay?: number;     // Retry delay in ms
  temperature?: number;    // Model temperature
  topP?: number;           // Top-p sampling
  focusAreas?: string[];   // Areas to focus on (e.g., ['price', 'materials'])
}
```

**Returns**:
```typescript
interface AudioAnalysisResult {
  transcript: string;           // Full audio transcription
  language: string;             // Detected language (ISO code)
  audioQuality: number;         // Quality score 0-100
  productMetadata: ProductMetadata;
  confidence: MetadataConfidence;
  relevantExcerpts: string[];   // Key quotes from transcript
  rawResponse: unknown;         // Raw Gemini response
}
```

#### `uploadAudio(audioPath): Promise<string>`

Upload audio file to Gemini Files API and wait for processing.

#### `deleteAudio(audioUri): Promise<void>`

Clean up uploaded audio file from Gemini.

### ProductMetadata Structure

```typescript
interface ProductMetadata {
  // Core fields
  title: string;
  description: string;
  shortDescription?: string;
  bulletPoints: string[];

  // Brand & classification
  brand?: string;
  category?: string;
  subcategory?: string;
  keywords?: string[];
  tags?: string[];

  // Physical attributes
  materials?: string[];
  color?: string;
  colors?: string[];
  size?: string;
  sizes?: string[];

  // Pricing (if mentioned in audio)
  price?: number;
  currency?: string;

  // Confidence tracking
  confidence: {
    overall: number;   // 0-100
    title: number;
    description: number;
    price?: number;
    attributes?: number;
  };

  // Source tracking
  extractedFromAudio: boolean;
  transcriptExcerpts?: string[];
}
```

### Platform Formatters

The provider includes helper functions to format metadata for specific platforms:

| Function | Output Format |
|----------|---------------|
| `formatForShopify()` | Shopify GraphQL `productCreate` format |
| `formatForAmazon()` | SP-API Listings Items JSON |
| `formatForEbay()` | eBay Inventory API format |

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIO_PROCESSING_TIMEOUT_MS` | 180000 | File processing timeout |
| `AUDIO_POLLING_INTERVAL_MS` | 3000 | Polling interval |
| `AUDIO_MAX_RETRIES` | 3 | Max retries for analysis |

### Error Handling

- Files are uploaded to Gemini Files API and deleted after processing
- Processing failures are detected via file state polling
- Graceful degradation: audio analysis failure doesn't block the visual pipeline

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

## Stability Service

**File**: `src/services/stability.service.ts`

Provides AI inpainting capabilities for filling transparent holes in product images using Stability AI's v2beta API.

### Use Case

When background removal also removes obstructions (like hands holding a product), it can leave transparent "holes" inside the product. This service fills those holes with AI-generated content that seamlessly matches the surrounding product.

### Methods

#### `inpaintHoles(imagePath, maskPath, outputPath, options): Promise<InpaintResult>`

Fill transparent holes in an image using AI inpainting.

**Parameters**:
- `imagePath`: Source image with holes
- `maskPath`: Mask image (white = fill, black = preserve)
- `outputPath`: Output path for result
- `options`: Inpainting options

**Options**:
```typescript
interface InpaintOptions {
  prompt?: string;         // Inpainting prompt
  negativePrompt?: string; // Things to avoid
  debug?: boolean;         // Save debug files
  cleanup?: boolean;       // Clean up intermediate files
}
```

**Returns**:
```typescript
interface InpaintResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  error?: string;
}
```

### Algorithm

1. **Prepare Image**: Resize to max 4MP, align to 64px multiples (required by Stable Diffusion)
2. **Prepare Mask**: Dilate mask to expand fill area, blur edges for smooth transitions
3. **Inpaint**: Send to Stability AI v2beta API with grow_mask for additional blending
4. **Restore Alpha**: Apply original alpha channel to preserve transparency
5. **Upscale**: Resize back to original dimensions

### Features

- Automatic image resizing and alignment
- Mask dilation (3px radius) for edge coverage
- Gaussian blur (σ=4) for feathered mask edges
- Alpha channel restoration after inpainting
- Retry logic with exponential backoff (max 3 attempts)
- Debug mode for inspecting intermediate files

### Configuration

```bash
STABILITY_API_KEY=your-stability-api-key
STABILITY_API_BASE=https://api.stability.ai  # Optional, defaults to official API
```

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
- `S3_BUCKET`: Bucket name (required)
- `S3_REGION`: Region (default: `us-east-1`)
- `S3_ENDPOINT`: Storage endpoint URL (required) - e.g., `http://localhost:9000` for MinIO, `https://s3.us-east-1.amazonaws.com` for AWS
- `S3_ACCESS_KEY_ID`: Access key (required)
- `S3_SECRET_ACCESS_KEY`: Secret key (required)
- `S3_FORCE_PATH_STYLE`: Use path-style URLs (required for MinIO, default: `false`)

---

## Pipeline Service

**File**: `src/services/pipeline.service.ts`

Orchestrates the complete processing pipeline, coordinating all other services.

### Pipeline Steps

1. **Download** (5%) - Fetch video from URL
2. **Extract** (10-15%) - Get metadata and extract frames
3. **Score** (30-45%) - Calculate quality scores
4. **Classify** (50-60%) - AI variant discovery
5. **Extract Product** (60-70%) - Claid bg-remove → fill holes → center
6. **Generate** (70-95%) - Commercial image creation
7. **Complete** (100%) - Finalize and cleanup

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
├── extracted/      # Product extraction results (bg removed, rotated, centered)
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

## S3 URL Utility

**File**: `src/utils/s3-url.ts`

Provides shared utilities for extracting S3 keys from various URL formats.

### Methods

#### `extractS3KeyFromUrl(url, config, options): string | null`

Extract S3 key from various URL formats.

**Supported Formats**:
- S3 protocol: `s3://bucket/key`
- Path-style HTTP: `http://endpoint/bucket/key` (MinIO, custom endpoints)
- Path-style with any host: `http://any-host/bucket/key` (Docker internal URLs)
- Virtual-hosted AWS: `https://bucket.s3.region.amazonaws.com/key`

**Parameters**:
```typescript
interface StorageConfig {
  bucket: string;
  endpoint?: string;
  region: string;
}

options: {
  allowAnyHost?: boolean;  // Match any hostname (for Docker internal URLs)
}
```

**Returns**: The S3 key or `null` if not a valid S3 URL for this bucket.

**Usage**:
```typescript
const config = { bucket: 'vopi-storage', region: 'us-east-1', endpoint: 'http://localhost:9000' };

// Docker internal URL (minio:9000)
extractS3KeyFromUrl('http://minio:9000/vopi-storage/jobs/123/frame.png', config, { allowAnyHost: true })
// Returns: 'jobs/123/frame.png'

// S3 protocol
extractS3KeyFromUrl('s3://vopi-storage/uploads/video.mp4', config)
// Returns: 'uploads/video.mp4'
```

#### `isUploadedVideoUrl(url, config): boolean`

Check if a URL belongs to the S3 uploads prefix (uploaded via presigned URL).

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

---

## Global Config Service

**File**: `src/services/global-config.service.ts`

Provides database-backed runtime configuration with in-memory caching.

### Purpose

1. **Runtime Configuration**: Change pipeline behavior without redeploying
2. **Caching**: In-memory cache with configurable TTL (default: 60s)
3. **Type Safety**: Strongly-typed config values with validation
4. **Defaults**: Sensible defaults with database override capability

### Methods

#### `getAllConfig(): Promise<Map<string, GlobalConfigValue>>`

Get all config values merged with defaults.

#### `getValue<T>(key: string): Promise<T | undefined>`

Get a single config value by key.

#### `getValueOrDefault<T>(key: string, defaultValue: T): Promise<T>`

Get config value with fallback to provided default.

#### `getEffectiveConfig(): Promise<EffectiveConfig>`

Get the complete effective configuration object with all settings typed:

```typescript
interface EffectiveConfig {
  pipelineStrategy: PipelineStrategy;  // 'classic' | 'gemini_video' | 'unified_video_analyzer' | 'full_gemini'
  fps: number;
  batchSize: number;
  geminiModel: string;
  geminiVideoModel: string;
  geminiImageModel: string;       // Model for native image generation
  temperature: number;
  topP: number;
  motionAlpha: number;
  minTemporalGap: number;
  topKPercent: number;
  commercialVersions: string[];
  aiCleanup: boolean;
  geminiVideoFps: number;
  geminiVideoMaxFrames: number;
  debugEnabled: boolean;
}
```

#### `setValue(request: UpsertConfigRequest): Promise<void>`

Set a single config value (upsert).

#### `setValues(configs: UpsertConfigRequest[]): Promise<void>`

Set multiple config values in a transaction.

#### `deleteValue(key: string): Promise<boolean>`

Delete a config value (resets to default).

#### `seedDefaults(): Promise<number>`

Initialize database with default values. Returns count of seeded values.

#### `invalidateCache(): void`

Clear the in-memory cache.

### Configuration Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pipeline.strategy` | string | `classic` | Pipeline strategy (`classic` or `gemini_video`) |
| `pipeline.fps` | number | 10 | Frame extraction rate |
| `pipeline.batchSize` | number | 30 | Frames per Gemini batch |
| `ai.geminiModel` | string | `gemini-2.0-flash` | Model for classification |
| `ai.geminiVideoModel` | string | `gemini-2.0-flash` | Model for video analysis |
| `ai.geminiImageModel` | string | `gemini-2.5-flash-image` | Model for image generation |
| `ai.temperature` | number | 0.2 | AI temperature |
| `ai.topP` | number | 0.8 | AI top-p |
| `scoring.motionAlpha` | number | 0.3 | Motion penalty weight |
| `scoring.minTemporalGap` | number | 1.0 | Min seconds between frames |
| `scoring.topKPercent` | number | 0.3 | Top percentage for candidates |
| `commercial.versions` | array | `["transparent","solid","real","creative"]` | Versions to generate |
| `commercial.aiCleanup` | boolean | true | Enable AI obstruction removal |
| `geminiVideo.fps` | number | 1 | Video analysis FPS |
| `geminiVideo.maxFrames` | number | 10 | Max frames to select |

### Database Schema

Config is stored in the `global_config` table:

```sql
CREATE TABLE global_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## S3 Presign Utilities

**File**: `src/utils/s3-presign.ts`

Shared utilities for S3 presigned URL operations, used by external API integrations (Photoroom, Claid).

### Purpose

1. **Detect Environment**: Determine if S3 is local (MinIO) vs production
2. **Upload with Presigned URL**: Upload files and get presigned URLs for external APIs
3. **Cleanup**: Remove temporary files after API calls

### Methods

#### `isLocalS3(): boolean`

Check if S3 endpoint is localhost (MinIO, local development).

```typescript
// Returns true for:
// - localhost endpoints
// - 127.0.0.1 endpoints
// - ::1 (IPv6 localhost) endpoints
```

#### `getPresignedImageUrl(imagePath, prefix, expirySeconds?): Promise<PresignedUploadResult>`

Upload file to S3 and get presigned URL for external API access.

**Parameters**:
- `imagePath`: Local file path to upload
- `prefix`: S3 key prefix (e.g., `temp/photoroom`, `temp/claid`)
- `expirySeconds`: Optional expiry time (default: `API_PRESIGN_EXPIRY_SECONDS` config)

**Returns**:
```typescript
interface PresignedUploadResult {
  url: string;      // Presigned URL for external API
  tempKey: string;  // S3 key for cleanup
}
```

#### `cleanupTempS3File(tempKey): Promise<void>`

Delete temporary S3 file. Silently handles errors to avoid disrupting main flow.

### Configuration

- `API_PRESIGN_EXPIRY_SECONDS`: Presigned URL expiry (default: 300 seconds)

### Usage Pattern

```typescript
import { isLocalS3, getPresignedImageUrl, cleanupTempS3File } from '../utils/s3-presign.js';

let tempKey: string | undefined;
try {
  if (!isLocalS3()) {
    // Production: use presigned URL
    const result = await getPresignedImageUrl(imagePath, 'temp/myapi');
    tempKey = result.tempKey;
    // Call external API with result.url
  } else {
    // Local: use multipart upload
  }
} finally {
  await cleanupTempS3File(tempKey);
}
```

---

## Claid Background Removal Provider

**File**: `src/providers/implementations/claid-background-removal.provider.ts`

Alternative background removal using Claid.ai API with selective object retention.

### Purpose

1. **Selective Removal**: Keep specific objects using text prompts
2. **Dual Mode**: Presigned URL (production) or multipart upload (local)
3. **Swappable**: Same IO contract as Photoroom provider

### Methods

#### `removeBackground(imagePath, outputPath, options): Promise<BackgroundRemovalResult>`

Remove background while keeping specified object.

**Options**:
```typescript
interface BackgroundRemovalOptions {
  customPrompt?: string;  // Object to keep (default: "product")
  useAIEdit?: boolean;    // Run inpainting to fill holes
}
```

**Returns**:
```typescript
interface BackgroundRemovalResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  method?: string;      // 'claid-selective' or 'claid-selective+inpaint'
  error?: string;
}
```

#### `isAvailable(): boolean`

Check if Claid API key is configured.

### API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `https://api.claid.ai/v1/image/edit` | JSON endpoint (presigned URL input) |
| `https://api.claid.ai/v1/image/edit/upload` | Multipart endpoint (direct file upload) |

### Configuration

- `CLAID_API_KEY`: Claid API key (required for availability)

### Processor Swapping

Both Photoroom and Claid have the same IO contract:
```typescript
io: {
  requires: ['images', 'frames'],
  produces: ['images'],
}
```

Swap via job config:
```typescript
{
  processorSwaps: {
    'photoroom-bg-remove': 'claid-bg-remove'
  }
}
```

---

## Gemini Video Analysis Provider

**File**: `src/providers/implementations/gemini-video-analysis.provider.ts`

Direct video analysis using Gemini's video understanding capabilities.

### Purpose

1. **Direct Analysis**: Send video to Gemini without extracting all frames first
2. **HEVC Support**: Automatic transcoding of iPhone HEVC videos to H.264
3. **Timestamp Selection**: Gemini analyzes video and returns optimal timestamps
4. **Cleanup**: Automatic cleanup of Gemini-uploaded files

### Methods

#### `analyzeVideo(videoPath, options): Promise<VideoAnalysisResult>`

Analyze video and get optimal frame timestamps.

**Options**:
```typescript
interface VideoAnalysisOptions {
  model?: string;         // Gemini model (default from config)
  maxFrames?: number;     // Max frames to select (default: 10)
  maxRetries?: number;    // Retry attempts (default: 3)
  retryDelay?: number;    // Retry delay ms
  temperature?: number;   // AI temperature
  topP?: number;          // AI top-p
}
```

**Returns**:
```typescript
interface VideoAnalysisResult {
  products: Array<{
    productId: string;
    description: string;
    category?: string;
  }>;
  selectedFrames: Array<{
    timestamp: number;           // Seconds
    selectionReason: string;
    productId: string;
    variantId: string;
    angleEstimate: string;
    qualityScore: number;        // 0-100
    rotationAngleDeg: number;    // Degrees to rotate
    variantDescription?: string;
    obstructions: {...};
    backgroundRecommendations: {...};
  }>;
  videoDuration: number;
  framesAnalyzed: number;
  rawResponse: object;
}
```

#### `uploadVideo(videoPath): Promise<string>`

Upload video to Gemini Files API and wait for processing.

#### `deleteVideo(videoUri): Promise<void>`

Delete video from Gemini Files API.

### HEVC Auto-Transcoding

When an HEVC (H.265) video is detected:
1. `ffprobe` checks codec: `hevc` or `h265`
2. `ffmpeg` transcodes to H.264: `-c:v libx264 -preset fast -crf 23`
3. Transcoded file is uploaded to Gemini
4. Original video is preserved
5. Transcoded temp file is cleaned up after analysis

### Error Handling

- Video processing failures include detailed error info (file name, size, error code)
- Automatic retry with exponential backoff
- Cleanup runs even on errors (finally block)

---

## Parallel Processing Utility

**File**: `src/utils/parallel.ts`

Provides controlled concurrency for parallel async operations with error handling.

### Purpose

1. **Controlled Concurrency**: Limit parallel operations to avoid rate limiting
2. **Error Isolation**: Capture errors per-item without failing the entire batch
3. **Order Preservation**: Results maintain input order

### Functions

#### `parallelMap<T, R>(items, fn, options): Promise<ParallelMapResult<R>>`

Process items in parallel with concurrency limit.

**Parameters**:
```typescript
interface ParallelMapOptions {
  concurrency: number;  // Max concurrent operations
}
```

**Returns**:
```typescript
interface ParallelMapResult<R> {
  results: Array<R | ParallelError>;  // Results in input order
  successCount: number;
  errorCount: number;
}
```

**Example**:
```typescript
import { parallelMap, isParallelError } from '../utils/parallel.js';

const results = await parallelMap(
  frames,
  async (frame) => processFrame(frame),
  { concurrency: 5 }
);

// Handle results
results.results.forEach((result, i) => {
  if (isParallelError(result)) {
    console.error(`Frame ${i} failed: ${result.message}`);
  } else {
    console.log(`Frame ${i} processed`);
  }
});
```

#### `isParallelError(result): result is ParallelError`

Type guard to check if a result is an error.

```typescript
interface ParallelError {
  error: true;
  message: string;
  originalError?: unknown;
}
```

### Usage in Processors

All image processing processors use `parallelMap` with centralized concurrency defaults:

```typescript
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const concurrency = getConcurrency('CLAID_BG_REMOVE', options);
const results = await parallelMap(frames, processFrame, { concurrency });
```

---

## Stability AI Providers

VOPI includes multiple Stability AI providers for image processing tasks.

### Stability Commercial Provider

**File**: `src/providers/implementations/stability-commercial.provider.ts`

Generates commercial images using Stability AI's Replace Background and Relight API.

#### Purpose

1. **AI-Generated Backgrounds**: Create realistic or creative backgrounds from text prompts
2. **Lighting Control**: Adjust lighting direction and intensity
3. **Solid Backgrounds**: Local Sharp-based processing for solid color backgrounds

#### Methods

##### `generateWithAIBackground(imagePath, outputPath, options): Promise<CommercialResult>`

Generate commercial image with AI-generated background.

**Options**:
```typescript
interface CommercialBackgroundOptions {
  backgroundPrompt: string;         // Description of desired background
  foregroundPrompt?: string;        // Description of product style
  negativePrompt?: string;          // What to avoid
  lightSourceDirection?: string;    // 'above' | 'below' | 'left' | 'right'
  lightSourceStrength?: number;     // 0.0-1.0
  preserveOriginalSubject?: number; // 0.0-1.0 (how much to preserve product)
  seed?: number;
  outputFormat?: 'png' | 'jpeg' | 'webp';
}
```

##### `generateWithSolidBackground(imagePath, outputPath, options): Promise<CommercialResult>`

Generate commercial image with solid color background (local processing).

**Options**:
```typescript
interface SolidBackgroundOptions {
  backgroundColor: string;  // Hex color (e.g., '#FFFFFF')
  padding?: number;        // Padding ratio (default: 0.12)
}
```

#### API Endpoint

```
POST /v2beta/stable-image/edit/replace-background-and-relight
```

The API is asynchronous - returns 202 with result ID, then polls for completion.

### Stability Upscale Provider

**File**: `src/providers/implementations/stability-upscale.provider.ts`

Image upscaling using Stability AI's upscale APIs.

#### Purpose

1. **Conservative Upscale**: Fast 2x upscale preserving original details
2. **Creative Upscale**: AI-enhanced upscale with optional prompt guidance

#### Methods

##### `upscale(imagePath, outputPath, options): Promise<UpscaleResult>`

Upscale an image using Stability AI.

**Options**:
```typescript
interface UpscaleOptions {
  creativity?: number;      // 0.0-1.0 (>0.5 uses creative endpoint)
  prompt?: string;          // Prompt for creative upscale
  negativePrompt?: string;
  seed?: number;
  outputFormat?: 'png' | 'jpeg' | 'webp';
}
```

**Returns**:
```typescript
interface UpscaleResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  method?: string;  // 'stability-conservative-upscale' | 'stability-creative-upscale'
  error?: string;
}
```

#### API Endpoints

| Endpoint | When Used |
|----------|-----------|
| `/v1/generation/esrgan-v1-x2plus/image-to-image` | `creativity <= 0.5` (conservative) |
| `/v2beta/stable-image/upscale/creative` | `creativity > 0.5` (creative) |

### Stability Background Removal Provider

**File**: `src/providers/implementations/stability-background-removal.provider.ts`

Background removal using Stability AI's remove-background API.

#### Purpose

Alternative to Claid for background removal when Stability AI is preferred.

#### Methods

##### `removeBackground(imagePath, outputPath): Promise<BackgroundRemovalResult>`

Remove background from an image.

#### API Endpoint

```
POST /v2beta/stable-image/edit/remove-background
```

### Shared Stability API Utilities

**File**: `src/providers/utils/stability-api.ts`

Shared utilities for all Stability AI API calls.

#### Functions

##### `makeStabilityRequest(options): Promise<Buffer>`

Make synchronous API request with retry logic.

**Options**:
```typescript
interface StabilityRequestOptions {
  apiKey: string;
  endpoint: string;
  formData: FormData;
  maxRetries?: number;      // Default: 3
  retryDelayMs?: number;    // Default: 2000
  operationName?: string;
}
```

##### `makeStabilityAsyncRequest(options): Promise<Buffer>`

Make async API request with polling for results.

```typescript
interface StabilityAsyncRequestOptions extends StabilityRequestOptions {
  apiBase: string;
  pollingIntervalMs?: number;    // Default: 3000
  maxPollingAttempts?: number;   // Default: 60
}
```

##### `parseHexColor(hex): { r, g, b, alpha }`

Parse hex color string with validation.

- Handles `#FFFFFF` and `FFFFFF` formats
- Trims whitespace
- Returns white `{ r: 255, g: 255, b: 255, alpha: 1 }` for invalid input

##### `isWithinSizeLimit(sizeBytes): boolean`

Check if file is within Stability AI's 10MB limit.

##### `getFileSizeError(sizeBytes): string`

Get human-readable error message for oversized files.

#### Constants

```typescript
export const STABILITY_API_CONSTANTS = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
  POLLING_INTERVAL_MS: 3000,
  MAX_POLLING_ATTEMPTS: 60,
  MAX_INPUT_SIZE_BYTES: 10 * 1024 * 1024,  // 10MB
};
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `STABILITY_API_KEY` | - | Stability AI API key (required) |
| `STABILITY_API_BASE` | `https://api.stability.ai` | API base URL |

---

## Unified Video Analyzer Provider

**File**: `src/providers/implementations/gemini-unified-video-analyzer.provider.ts`

Combines audio transcription and video frame analysis in a single Gemini API call.

### Purpose

1. **Single API Call**: Audio + video analysis together (most efficient)
2. **Cross-Modal Context**: Audio informs frame selection
3. **Metadata Extraction**: Product metadata from audio transcription
4. **Frame Selection**: Optimal timestamps for product photography

### Methods

#### `analyzeVideo(videoPath, options): Promise<UnifiedVideoAnalysisResult>`

Analyze video with combined audio and visual understanding.

**Returns**:
```typescript
interface UnifiedVideoAnalysisResult {
  products: Array<{
    productId: string;
    description: string;
    category?: string;
  }>;
  selectedFrames: Array<{
    timestamp: number;
    productId: string;
    variantId: string;
    angleEstimate: string;
    qualityScore: number;
    rotationAngleDeg: number;
    obstructions: {...};
    backgroundRecommendations: {...};
  }>;
  transcript: string;
  productMetadata: ProductMetadata;
  videoDuration: number;
}
```

### Processor

**File**: `src/processors/impl/gemini/gemini-unified-video-analyzer.ts`

This processor replaces the combination of:
- `extract-audio`
- `gemini-audio-analysis`
- `extract-frames`
- `score-frames`
- `gemini-classify`
- `save-frame-records`

With a single unified step that:
1. Uploads video to Gemini Files API
2. Sends combined prompt for audio + video analysis
3. Extracts frames at selected timestamps
4. Saves frame records to database
5. Returns frames with classifications and product metadata

### Configuration

Uses the same Gemini configuration as other video analysis providers.

---

## Gemini Image Generation Provider

**File**: `src/providers/implementations/gemini-image-generate.provider.ts`

Uses Gemini's native image generation capabilities to create commercial product images directly from raw video frames.

### Purpose

1. **Background Replacement**: Generate clean backgrounds without external APIs
2. **Variant Generation**: Create white-studio and lifestyle variants
3. **Product Context**: Use audio metadata to inform lifestyle scene generation
4. **Reference Frames**: Use other frames as product reference for consistency

### Methods

#### `generateVariant(imagePath, outputPath, options): Promise<GeminiImageGenerateResult>`

Generate a single image variant using Gemini native image generation.

**Options**:
```typescript
interface GeminiImageGenerateOptions {
  variant: 'white-studio' | 'lifestyle';
  productTitle?: string;
  productDescription?: string;
  productCategory?: string;
  referenceFramePaths?: string[];  // Other frames for product context
}
```

**Returns**:
```typescript
interface GeminiImageGenerateResult {
  success: boolean;
  variant: GeminiImageVariant;
  outputPath?: string;
  size?: number;
  error?: string;
}
```

#### `generateAllVariants(imagePath, outputDir, frameId, options): Promise<GeminiImageGenerateAllResult>`

Generate all variants for a single frame.

**Returns**:
```typescript
interface GeminiImageGenerateAllResult {
  frameId: string;
  variants: Record<GeminiImageVariant, GeminiImageGenerateResult>;
  successCount: number;
  errorCount: number;
}
```

### Variant Types

| Variant | Description | Prompt Focus |
|---------|-------------|--------------|
| `white-studio` | Clean white background | Professional e-commerce lighting, soft shadows |
| `lifestyle` | Contextual scene | Natural environment matching product category |

### Reference Frames

When `referenceFramePaths` is provided:
- Up to 4 reference frames are sent (MAX_REFERENCE_FRAMES limit)
- Frames are sent before the target frame for product context
- Helps Gemini understand what the product should look like

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `ai.geminiImageModel` | `gemini-2.5-flash-image` | Model for image generation |

### Processor

**File**: `src/processors/impl/gemini/gemini-image-generate.ts`

The processor:
1. Selects 4 best angles from available frames (based on quality scores)
2. Groups frames by angle to avoid duplicates
3. Generates 2 variants per angle (white-studio + lifestyle)
4. Processes in parallel with concurrency limits
5. Returns up to 8 commercial images (4 angles × 2 variants)

**IO Contract**:
```typescript
io: {
  requires: ['images', 'frames'],
  produces: ['images', 'frames.version'],
}
```

---

## Gemini Quality Filter Provider

**File**: `src/providers/implementations/gemini-quality-filter.provider.ts`

AI-powered quality filtering to remove generated images that don't match the original product.

### Purpose

1. **Product Consistency**: Filter out images where AI changed the product
2. **Reference Comparison**: Compare generated images against original frames
3. **Batch Processing**: Evaluate multiple images efficiently

### Methods

#### `evaluateImages(images, options): Promise<QualityFilterResult>`

Evaluate a batch of images for product consistency.

**Parameters**:
```typescript
interface QualityFilterImage {
  imageId: string;     // Unique ID (frameId::version format)
  imagePath: string;   // Path to generated image
}

interface QualityFilterOptions {
  referenceImagePaths?: string[];  // Original product frames for comparison
}
```

**Returns**:
```typescript
interface QualityFilterResult {
  evaluations: Array<{
    imageId: string;
    keep: boolean;         // Whether to keep the image
    confidence: number;    // 0-100 confidence score
    reason: string;        // Explanation
    issues?: string[];     // Detected problems
  }>;
  keptCount: number;
  filteredCount: number;
  averageConfidence: number;
}
```

### Evaluation Criteria

The filter checks for:
- **Product shape/proportions**: Does the product match the original?
- **Color accuracy**: Are colors consistent?
- **Key features**: Are distinguishing features preserved?
- **Missing elements**: Were parts of the product removed?
- **Added elements**: Were things added that shouldn't be there?

### Processor

**File**: `src/processors/impl/gemini/gemini-quality-filter.ts`

The processor:
1. Loads generated commercial images from data
2. Groups images by frameId for efficient evaluation
3. Calls Gemini to evaluate each batch
4. Updates database records with S3 URLs for kept images
5. Moves filtered images to `agent-filtered/` folder

**IO Contract**:
```typescript
io: {
  requires: ['images', 'frames'],
  produces: ['images'],
}
```

### Configuration

| Setting | Description |
|---------|-------------|
| `VOPI_CONCURRENCY_GEMINI_QUALITY_FILTER` | Parallel evaluation limit (default: 2) |

---

## Shared Image Utilities

**File**: `src/utils/image-utils.ts`

Shared utilities for image processing across providers.

### Functions

#### `getImageMimeType(filePath): ImageMimeType`

Get MIME type from file extension.

```typescript
type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
```

#### `limitReferenceFrames(paths, max): string[]`

Limit reference frames to avoid API token limits.

```typescript
const MAX_REFERENCE_FRAMES = 4;

// Example
const limited = limitReferenceFrames(allFrames, MAX_REFERENCE_FRAMES);
// Returns first 4 frames
```

---

## Frame Selection Utilities

**File**: `src/utils/frame-selection.ts`

Utilities for selecting optimal frames from a set.

### Functions

#### `selectBestAngles(frames, maxAngles): FrameMetadata[]`

Select the best frames representing distinct angles.

**Algorithm**:
1. Group frames by `angleEstimate` field
2. Sort each group by quality score (descending)
3. Select best frame from each angle
4. Return up to `maxAngles` frames

#### `getFrameScore(frame): number`

Get the quality score for a frame, handling missing scores.

#### `groupFramesByAngle(frames): Map<string, FrameMetadata[]>`

Group frames by their angle estimate for analysis.

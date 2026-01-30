/**
 * Processor Types
 *
 * Core type definitions for the composable process stack architecture.
 * Processors are modular units that can be composed into stacks/pipelines.
 *
 * This module exports:
 * - DataPath: Union type for all data paths (video, images, text, frames, etc.)
 * - FrameMetadata: Unified frame metadata interface (progressively enriched)
 * - Data validation: validateDataRequirements() for path validation
 * - Processor interfaces: Processor, ProcessorIO, ProcessorResult, ProcessorContext
 * - Stack interfaces: StackTemplate, StackStep, StackConfig, StackValidationResult
 * - Data interfaces: PipelineData, PipelineMetadata, VideoData, WorkDirs
 */

import type { Job } from '../db/schema.js';
import type { JobConfig, JobStatus, FrameScores, FrameObstructions, BackgroundRecommendations } from '../types/job.types.js';
import type { VideoMetadata } from '../types/job.types.js';
import type { EffectiveConfig } from '../types/config.types.js';
import type { PipelineTimer } from '../utils/timer.js';
import type { TokenUsageTracker } from '../utils/token-usage.js';

/**
 * Data path identifiers for processor requirements and outputs
 *
 * Unified type for all data that flows through the pipeline:
 * - Core data: video, images, text
 * - Frame metadata: frames, frames.scores, frames.classifications, etc.
 *
 * Processors declare what data paths they require and produce using these identifiers.
 */
export type DataPath =
  // Core data types
  | 'video'                 // Video file data (path, metadata, sourceUrl)
  | 'images'                // Array of image file paths
  | 'text'                  // Text/string data
  // Audio data types
  | 'audio'                 // Audio file data (path, format, duration)
  | 'transcript'            // Transcribed text from audio
  | 'product.metadata'      // Structured product metadata for e-commerce
  // Frame metadata paths
  | 'frames'                // Base frame metadata exists
  | 'frames.scores'         // Frames have score fields (sharpness, motion, score)
  | 'frames.classifications' // Frames have classification fields (productId, variantId)
  | 'frames.dbId'           // Frames have database IDs
  | 'frames.s3Url'          // Frames have S3 URLs
  | 'frames.version';       // Frames have commercial version field

/**
 * Processor IO declaration
 */
export interface ProcessorIO {
  /** Data paths this processor requires as input */
  requires: DataPath[];
  /** Data paths this processor produces as output */
  produces: DataPath[];
}

/**
 * Unified frame metadata - progressively enriched through the pipeline
 *
 * Frame data progression:
 *   extract-frames: Creates base fields (frameId, path, timestamp, index)
 *   score-frames: Adds sharpness, motion, score; REMOVES low-scoring frames
 *   gemini-classify: Adds productId, variantId, etc.; REMOVES rejected frames
 *   save-frame-records: Adds dbId
 *   bg-remove/fill/center: Updates path to processed image
 *   generate-commercial: Creates 4x frames with version field
 *   upload-frames: Adds s3Url
 */
export interface FrameMetadata {
  // Base fields (from extract-frames)
  frameId: string;
  filename: string;
  path: string;
  timestamp: number;
  index: number;

  // Score fields (added by score-frames) - optional
  sharpness?: number;
  motion?: number;
  score?: number;
  isBestPerSecond?: boolean;

  // Classification fields (added by gemini-classify/gemini-video-analysis) - optional
  productId?: string;
  variantId?: string;
  angleEstimate?: string;
  recommendedType?: string;
  variantDescription?: string;
  geminiScore?: number;
  rotationAngleDeg?: number;
  allFrameIds?: string[];
  obstructions?: FrameObstructions;
  backgroundRecommendations?: BackgroundRecommendations;
  scores?: FrameScores;
  isFinalSelection?: boolean;

  // Commercial version (added by generate-commercial) - optional
  version?: 'transparent' | 'solid' | 'real' | 'creative';
  sourceFrameId?: string;    // Original frameId before commercial split

  // Upload/DB fields (added by save-frame-records, upload-frames) - optional
  s3Url?: string;
  dbId?: string;
}

/**
 * Video metadata within pipeline metadata
 */
export interface PipelineVideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  filename?: string;
}

/**
 * Pipeline metadata - persistent container that is enriched by each processor
 *
 * This is NOT an IO type. It always exists from pipeline start and is progressively
 * enriched by each processor. Processors declare their metadata requirements via
 * metadataRequires/metadataProduces in their IO declaration.
 */
export interface PipelineMetadata {
  /** Video metadata (added by extract-frames/gemini-video-analysis) */
  video?: PipelineVideoMetadata;

  /** Frames - current images being processed, progressively enriched and filtered */
  frames?: FrameMetadata[];

  /** Analysis results from Gemini (raw response) */
  analysisResult?: unknown;

  /** Products detected in video */
  products?: unknown[];

  /** Number of frames analyzed */
  framesAnalyzed?: number;

  /** Variants discovered count */
  variantsDiscovered?: number;

  /** Product type/category detected (e.g., "electronics", "clothing") */
  productType?: string;

  /** Product description for background removal targeting (e.g., "AirPods case", "wireless earbuds") */
  productDescription?: string;

  /** Frame record count saved to DB */
  frameRecordCount?: number;

  /** Commercial image URLs organized by variant */
  commercialImageUrls?: Record<string, Record<string, string>>;

  /** Commercial generation statistics */
  commercialGenerationStats?: {
    totalFrames: number;
    successfulFrames: number;
    totalErrors: number;
    totalImagesGenerated: number;
  };

  /** Final job result */
  result?: unknown;

  // ============================================================================
  // Audio & E-commerce Metadata (added by audio analysis pipeline)
  // ============================================================================

  /** Transcribed text from audio track */
  transcript?: string;

  /** Audio duration in seconds (if audio was extracted) */
  audioDuration?: number;

  /** Structured product metadata for e-commerce platforms */
  productMetadata?: ProductMetadataOutput;

  /** Flag indicating audio analysis failed but pipeline continued */
  audioAnalysisFailed?: boolean;

  /** Custom extension data - use this instead of adding arbitrary keys */
  extensions?: Record<string, unknown>;
}

/**
 * Product metadata output from audio/video analysis
 * Defined here to avoid circular imports - full type in product-metadata.types.ts
 */
export interface ProductMetadataOutput {
  /** Product title */
  title: string;
  /** Full description */
  description: string;
  /** Short description for previews */
  shortDescription?: string;
  /** Key features as bullet points */
  bulletPoints: string[];
  /** Primary brand */
  brand?: string;
  /** Product category */
  category?: string;
  /** Search keywords */
  keywords?: string[];
  /** Tags */
  tags?: string[];
  /** Primary color */
  color?: string;
  /** Primary materials */
  materials?: string[];
  /** Overall confidence score 0-100 */
  confidence: number;
  /** Whether metadata was extracted from audio */
  extractedFromAudio: boolean;
  /** Relevant excerpts from transcript */
  transcriptExcerpts?: string[];
}

/**
 * Data validation result
 */
export interface DataValidationResult {
  valid: boolean;
  missing: DataPath[];
}

/**
 * Validate that required data paths are present
 *
 * @param data - Pipeline data to validate
 * @param requirements - Array of data paths to check
 * @returns Validation result with missing paths
 */
export function validateDataRequirements(
  data: PipelineData | undefined,
  requirements: DataPath[] | undefined
): DataValidationResult {
  if (!requirements || requirements.length === 0) {
    return { valid: true, missing: [] };
  }

  if (!data) {
    return { valid: false, missing: requirements };
  }

  const missing: DataPath[] = [];

  for (const path of requirements) {
    let satisfied = false;

    switch (path) {
      // Core data types
      case 'video':
        satisfied = !!(data.video?.path || data.video?.sourceUrl);
        break;

      case 'images':
        satisfied = !!(data.images && data.images.length > 0);
        break;

      case 'text':
        satisfied = typeof data.text === 'string' && data.text.length > 0;
        break;

      // Audio data types
      case 'audio':
        satisfied = !!(data.audio?.path && data.audio?.hasAudio);
        break;

      case 'transcript':
        satisfied = typeof data.metadata?.transcript === 'string' && data.metadata.transcript.length > 0;
        break;

      case 'product.metadata':
        satisfied = !!(data.metadata?.productMetadata?.title);
        break;

      // Frame metadata paths
      case 'frames':
        satisfied = !!(data.metadata?.frames && data.metadata.frames.length > 0);
        break;

      case 'frames.scores':
        satisfied = !!(data.metadata?.frames?.some(f => f.sharpness !== undefined));
        break;

      case 'frames.classifications':
        satisfied = !!(data.metadata?.frames?.some(f => f.productId || f.variantId));
        break;

      case 'frames.dbId':
        satisfied = !!(data.metadata?.frames?.some(f => f.dbId));
        break;

      case 'frames.s3Url':
        satisfied = !!(data.metadata?.frames?.some(f => f.s3Url));
        break;

      case 'frames.version':
        satisfied = !!(data.metadata?.frames?.some(f => f.version));
        break;

      default:
        // Unknown path - check if it exists in metadata
        satisfied = path in (data.metadata ?? {}) && data.metadata?.[path] !== undefined;
    }

    if (!satisfied) {
      missing.push(path);
    }
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Check if a frame has score data
 */
export function hasScores(frame: FrameMetadata): boolean {
  return typeof frame.sharpness === 'number' &&
         typeof frame.motion === 'number' &&
         typeof frame.score === 'number';
}

/**
 * Check if a frame has classification data
 */
export function hasClassificationData(frame: FrameMetadata): boolean {
  return typeof frame.productId === 'string' && typeof frame.variantId === 'string';
}

/**
 * Check if any frames in an array have classification data
 *
 * @param frames - Array of frames to check
 * @returns true if at least one frame has classification data
 */
export function hasClassifications(frames: FrameMetadata[] | undefined): boolean {
  if (!frames || frames.length === 0) return false;
  return frames.some(hasClassificationData);
}

/**
 * Sync helper: Update data.images to match metadata.frames paths
 * Call this after modifying metadata.frames to keep them in sync
 */
export function syncImagesWithFrames(metadata: PipelineMetadata | undefined): string[] {
  if (!metadata?.frames || metadata.frames.length === 0) {
    return [];
  }
  return metadata.frames.map(f => f.path);
}

/**
 * Get frameId -> dbId mapping from pipeline data
 * Checks frameRecords field first, then builds from metadata.frames[].dbId
 */
export function getFrameDbIdMap(data: PipelineData): Map<string, string> {
  if (data.frameRecords && data.frameRecords.size > 0) {
    return data.frameRecords;
  }

  const map = new Map<string, string>();
  if (data.metadata?.frames) {
    for (const frame of data.metadata.frames) {
      if (frame.dbId) {
        map.set(frame.frameId, frame.dbId);
      }
    }
  }
  return map;
}

/**
 * Get input frames from pipeline data with fallback to legacy fields.
 *
 * This normalizes the different ways frames can be stored in pipeline data:
 * 1. metadata.frames (preferred, unified format)
 * 2. recommendedFrames (legacy, from classification)
 * 3. frames (legacy, from extraction)
 *
 * @param data - Pipeline data to extract frames from
 * @returns Array of frame metadata, or empty array if no frames found
 *
 * @example
 * const frames = getInputFrames(data);
 * if (frames.length === 0) {
 *   return { success: false, error: 'No frames available' };
 * }
 */
export function getInputFrames(data: PipelineData): FrameMetadata[] {
  // Prefer metadata.frames (unified format)
  if (data.metadata?.frames && data.metadata.frames.length > 0) {
    return data.metadata.frames;
  }

  // Fall back to legacy fields
  if (data.recommendedFrames && data.recommendedFrames.length > 0) {
    return data.recommendedFrames;
  }

  if (data.frames && data.frames.length > 0) {
    return data.frames;
  }

  return [];
}

// ============================================================================
// Core data interfaces
// ============================================================================

/**
 * Video metadata with source info
 *
 * - sourceUrl: URL to download video from (input to download processor)
 * - path: Local file path (output from download processor, input to frame extraction)
 */
export interface VideoData {
  /** Local file path to the video. Set after downloading. */
  path?: string;
  /** Video metadata (duration, dimensions, etc.) */
  metadata?: VideoMetadata;
  /** Database record ID */
  dbId?: string;
  /** Source URL to download from */
  sourceUrl?: string;
}

/**
 * Audio data extracted from video
 */
export interface AudioData {
  /** Local file path to the extracted audio file */
  path: string;
  /** Audio format (e.g., 'mp3', 'wav') */
  format: string;
  /** Duration in seconds */
  duration?: number;
  /** Sample rate in Hz */
  sampleRate?: number;
  /** Number of audio channels (1 = mono, 2 = stereo) */
  channels?: number;
  /** Whether the source video had an audio track */
  hasAudio: boolean;
}

/**
 * Commercial image result
 */
export interface CommercialImageData {
  frameId: string;
  version: string;
  path?: string;
  s3Url?: string;
  success: boolean;
  backgroundColor?: string;
  backgroundPrompt?: string;
  error?: string;
}

/**
 * Product extraction result data
 */
export interface ProductExtractionResultData {
  success: boolean;
  outputPath?: string;
  rotationApplied: number;
  error?: string;
}

/**
 * Unified pipeline data that flows between processors
 *
 * Structure:
 * - video, images, text, audio: Core data types
 * - metadata: Persistent container for frame data and auxiliary info
 */
export interface PipelineData {
  // Core data types
  video?: VideoData;
  images?: string[];
  text?: string;
  audio?: AudioData;

  /** Unified metadata container - enriched by processors */
  metadata: PipelineMetadata;

  // Frame data (also available via metadata.frames)
  frames?: FrameMetadata[];
  scoredFrames?: FrameMetadata[];
  candidateFrames?: FrameMetadata[];
  recommendedFrames?: FrameMetadata[];

  // Commercial images
  commercialImages?: CommercialImageData[];

  // Upload results
  uploadedUrls?: string[];

  // Frame DB records mapping (frameId -> dbId)
  frameRecords?: Map<string, string>;

  // Product extraction results
  extractionResults?: Map<string, ProductExtractionResultData>;

  // Product type detected by Gemini
  productType?: string;

  // Custom extension data
  extensions?: Record<string, unknown>;

  // Allow arbitrary keys for processor flexibility
  [key: string]: unknown;
}

/**
 * Working directories for pipeline execution
 */
export interface WorkDirs {
  root: string;
  video: string;
  frames: string;
  candidates: string;
  extracted: string;
  final: string;
  commercial: string;
}

/**
 * Progress callback type
 */
export type ProgressCallback = (progress: {
  status: JobStatus;
  percentage: number;
  message?: string;
  step?: number;
  totalSteps?: number;
}) => Promise<void>;

/**
 * Context passed to processors during execution
 */
export interface ProcessorContext {
  /** Current job */
  job: Job;
  /** Job ID */
  jobId: string;
  /** Job-level configuration */
  config: JobConfig;
  /** Working directories */
  workDirs: WorkDirs;
  /** Progress callback */
  onProgress?: ProgressCallback;
  /** Performance timer */
  timer: PipelineTimer;
  /** Effective global config */
  effectiveConfig: EffectiveConfig;
  /** Gemini token usage tracker */
  tokenUsage?: TokenUsageTracker;
}

/**
 * Result from processor execution
 */
export interface ProcessorResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Updated pipeline data */
  data?: Partial<PipelineData>;
  /** Error message if failed */
  error?: string;
  /**
   * If true, skip ALL remaining processors in the stack.
   * Use this for early termination (e.g., job completion, fatal conditions).
   * Do NOT use this to indicate "this processor was skipped" - instead return
   * { success: true, data: {} } to continue with the next processor.
   */
  skip?: boolean;
}

/**
 * Processor interface - the core building block
 */
export interface Processor {
  /** Unique identifier for this processor */
  readonly id: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Job status to set during execution */
  readonly statusKey: JobStatus;
  /** IO type declaration */
  readonly io: ProcessorIO;

  /**
   * Execute the processor
   * @param context - Execution context
   * @param data - Current pipeline data
   * @param options - Processor-specific options
   */
  execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult>;
}

/**
 * Stack step definition
 */
export interface StackStep {
  /** Processor ID to execute */
  processor: string;
  /** Processor-specific options */
  options?: Record<string, unknown>;
  /** Condition for execution (optional) */
  condition?: (data: PipelineData, context: ProcessorContext) => boolean;
}

/**
 * Stack template definition
 *
 * Note: requiredInputs and producedOutputs are computed dynamically at runtime
 * from the processor IO declarations. Use stackRunner.getRequiredInputs(stack)
 * and stackRunner.getProducedOutputs(stack) to get the actual values.
 */
export interface StackTemplate {
  /** Unique identifier for this stack */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this stack does */
  description?: string;
  /** Ordered list of processing steps */
  steps: StackStep[];
}

/**
 * Stack validation result
 */
export interface StackValidationResult {
  valid: boolean;
  error?: string;
  /** Data paths available at end of stack */
  availableOutputs?: DataPath[];
}

/**
 * Job-level stack configuration
 */
export interface StackConfig {
  /** Stack template ID to use */
  stackId?: string;
  /** Swap processors (original -> replacement, must have same IO) */
  processorSwaps?: Record<string, string>;
  /** Options for specific processors */
  processorOptions?: Record<string, Record<string, unknown>>;
  /** Insert additional processors */
  insertProcessors?: Array<{
    /** Insert after this processor */
    after: string;
    /** Processor to insert */
    processor: string;
    /** Options for inserted processor */
    options?: Record<string, unknown>;
  }>;
  /**
   * If true, runtime IO validation will throw an error instead of just logging a warning
   * when a processor's required IO types are not available. Default: false
   */
  strictIOValidation?: boolean;
}

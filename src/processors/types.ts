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
  // Frame metadata paths
  | 'frames'                // Base frame metadata exists
  | 'frames.scores'         // Frames have score fields (sharpness, motion, score)
  | 'frames.classifications' // Frames have classification fields (productId, variantId)
  | 'frames.dbId'           // Frames have database IDs
  | 'frames.s3Url'          // Frames have S3 URLs
  | 'frames.version';       // Frames have commercial version field

/**
 * @deprecated Use DataPath instead - IOType has been unified into DataPath
 * Scheduled for removal in v3.0. Migrate to DataPath.
 */
export type IOType = 'video' | 'images' | 'text';

/**
 * @deprecated Use DataPath instead - MetadataPath has been unified into DataPath
 * Scheduled for removal in v3.0. Migrate to DataPath.
 */
export type MetadataPath = DataPath;

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

  /** Product type/category detected */
  productType?: string;

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

  /** Custom extension data - use this instead of adding arbitrary keys */
  extensions?: Record<string, unknown>;
}

/**
 * Data validation result
 */
export interface DataValidationResult {
  valid: boolean;
  missing: DataPath[];
}

/**
 * @deprecated Use DataValidationResult instead
 */
export type MetadataValidationResult = DataValidationResult;

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
 * @deprecated Use validateDataRequirements instead
 */
export function validateMetadataRequirements(
  metadata: PipelineMetadata | undefined,
  requirements: DataPath[] | undefined
): DataValidationResult {
  // Create a minimal PipelineData wrapper for the new function
  const data = metadata ? { metadata } as PipelineData : undefined;
  return validateDataRequirements(data, requirements);
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

// ============================================================================
// Legacy type guards - kept for backwards compatibility
// ============================================================================

/**
 * Base frame metadata from extraction
 * @deprecated Use FrameMetadata directly - all fields are optional
 */
export interface BaseFrameMetadata {
  frameId: string;
  filename: string;
  path: string;
  timestamp: number;
  index: number;
}

/**
 * Frame metadata with quality scores
 * @deprecated Use FrameMetadata with hasScores() check
 */
export interface ScoredFrameMetadata extends BaseFrameMetadata {
  sharpness: number;
  motion: number;
  score: number;
  isBestPerSecond?: boolean;
}

/**
 * Frame metadata with AI classification
 * @deprecated Use FrameMetadata with hasClassificationData() check
 */
export interface ClassifiedFrameMetadata extends BaseFrameMetadata {
  productId: string;
  variantId: string;
  angleEstimate?: string;
  recommendedType?: string;
  variantDescription?: string;
  geminiScore?: number;
  rotationAngleDeg?: number;
  allFrameIds?: string[];
  obstructions?: FrameObstructions;
  backgroundRecommendations?: BackgroundRecommendations;
  isFinalSelection?: boolean;
}

/**
 * Type guard to check if frame has score data
 * @deprecated Use hasScores() instead
 */
export function isScored(frame: FrameMetadata): frame is FrameMetadata & ScoredFrameMetadata {
  return hasScores(frame);
}

/**
 * Type guard to check if frame has AI classification data
 * @deprecated Use hasClassificationData() instead
 */
export function isClassified(frame: FrameMetadata): frame is FrameMetadata & ClassifiedFrameMetadata {
  return hasClassificationData(frame);
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
 * The simplified structure:
 * - video, images, text: Core IO types
 * - metadata: Persistent container for all frame data and auxiliary info
 *
 * Legacy fields (frames, scoredFrames, etc.) are maintained for backwards
 * compatibility but should be migrated to use metadata.frames
 */
export interface PipelineData {
  // Core data by type
  video?: VideoData;
  images?: string[];
  text?: string;

  /**
   * Unified metadata container - always present, enriched by processors
   * This is the primary location for frame data and auxiliary information
   */
  metadata: PipelineMetadata;

  // ============================================================================
  // Legacy fields - maintained for backwards compatibility during migration
  // New code should use metadata.frames instead
  // ============================================================================

  /** @deprecated Use metadata.frames */
  frames?: FrameMetadata[];
  /** @deprecated Use metadata.frames with hasScores() filter */
  scoredFrames?: FrameMetadata[];
  /** @deprecated Use metadata.frames */
  candidateFrames?: FrameMetadata[];
  /** @deprecated Use metadata.frames */
  recommendedFrames?: FrameMetadata[];

  // Commercial images
  commercialImages?: CommercialImageData[];

  // Upload results
  uploadedUrls?: string[];

  // Frame DB records mapping (frameId -> dbId)
  /** @deprecated Frame dbIds are now stored in metadata.frames[].dbId */
  frameRecords?: Map<string, string>;

  // Product extraction results
  extractionResults?: Map<string, ProductExtractionResultData>;

  // Product type detected by Gemini
  productType?: string;

  // Custom extension data - preferred for new code
  extensions?: Record<string, unknown>;

  // Allow arbitrary keys for backwards compatibility and processor flexibility
  // Note: Prefer using 'extensions' field for new custom data
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

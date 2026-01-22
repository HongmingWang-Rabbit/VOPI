/**
 * Processor Types
 *
 * Core type definitions for the composable process stack architecture.
 * Processors are modular units that can be composed into stacks/pipelines.
 *
 * This module exports:
 * - IOType: Union type for processor input/output types
 * - FrameMetadata interfaces: BaseFrameMetadata, ScoredFrameMetadata, ClassifiedFrameMetadata
 * - Type guards: isScored(), isClassified() for runtime type checking
 * - Array helpers: hasClassifications() to check if frames have AI data
 * - Processor interfaces: Processor, ProcessorIO, ProcessorResult, ProcessorContext
 * - Stack interfaces: StackTemplate, StackStep, StackConfig, StackValidationResult
 * - Data interfaces: PipelineData, VideoData, WorkDirs
 */

import type { Job } from '../db/schema.js';
import type { JobConfig, JobStatus, FrameScores, FrameObstructions, BackgroundRecommendations } from '../types/job.types.js';
import type { VideoMetadata } from '../types/job.types.js';
import type { EffectiveConfig } from '../types/config.types.js';
import type { PipelineTimer } from '../utils/timer.js';

/**
 * IO types that processors can require and produce
 *
 * Core types:
 * - video: Video file data (path, metadata, sourceUrl)
 * - images: Array of image file paths
 * - text: Text/string data
 *
 * Frame data types (progressively enriched):
 * - frames: Basic frame metadata (frameId, path, timestamp)
 * - scores: Frames with quality scores (sharpness, motion, combined score)
 * - classifications: Frames with AI classification (productId, variantId, etc.)
 *
 * Database types:
 * - frame-records: Database record IDs for frames
 *
 * Typical IO progression through classic pipeline:
 * ```
 * download:            video(url) → video(path)
 * extract-frames:      video → images, frames
 * score-frames:        images, frames → images, scores
 * gemini-classify:     images → classifications
 * filter-by-score:     images, scores → images
 * save-frame-records:  frames → frame-records
 * upload-frames:       images → text
 * complete-job:        (any) → (saves to DB)
 * ```
 *
 * Gemini video pipeline:
 * ```
 * download:              video(url) → video(path)
 * gemini-video-analysis: video → images, frames, classifications
 * save-frame-records:    frames → frame-records
 * upload-frames:         images → text
 * complete-job:          (any) → (saves to DB)
 * ```
 */
export type IOType =
  | 'video'           // Video file data
  | 'images'          // Array of image file paths
  | 'text'            // Text/string data
  | 'frames'          // Basic frame metadata (from extraction)
  | 'scores'          // Frames with quality scores (from scoring)
  | 'classifications' // Frames with AI classifications (from Gemini)
  | 'frame-records';  // Database record IDs for frames

/**
 * Processor IO declaration
 */
export interface ProcessorIO {
  /** What this processor needs as input */
  requires: IOType[];
  /** What this processor produces as output */
  produces: IOType[];
}

/**
 * Base frame metadata from extraction (IOType: 'frames')
 */
export interface BaseFrameMetadata {
  frameId: string;
  filename: string;
  path: string;
  timestamp: number;
  index: number;
}

/**
 * Frame metadata with quality scores (IOType: 'scores')
 * Produced by score-frames processor
 */
export interface ScoredFrameMetadata extends BaseFrameMetadata {
  sharpness: number;
  motion: number;
  score: number;
  isBestPerSecond?: boolean;
}

/**
 * Frame metadata with AI classification (IOType: 'classifications')
 * Produced by gemini-classify or gemini-video-analysis processors
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
 * Full frame metadata - union of all enrichment stages
 * This is the primary type used in PipelineData for flexibility.
 *
 * Frame data progression through the pipeline:
 *   extract-frames: produces BaseFrameMetadata (basic metadata)
 *   score-frames: adds sharpness, motion, score → ScoredFrameMetadata
 *   gemini-classify: adds productId, variantId → ClassifiedFrameMetadata
 */
export interface FrameMetadata {
  frameId: string;
  filename: string;
  path: string;
  timestamp: number;
  index: number;
  // Score fields (from score-frames)
  sharpness?: number;
  motion?: number;
  score?: number;
  // Classification fields (from gemini-classify/gemini-video-analysis)
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
  // Selection markers
  isBestPerSecond?: boolean;
  isFinalSelection?: boolean;
  // Upload/DB fields
  s3Url?: string;
  dbId?: string;
}

/**
 * Type guard to check if frame has score data
 */
export function isScored(frame: FrameMetadata): frame is FrameMetadata & ScoredFrameMetadata {
  return typeof frame.sharpness === 'number' &&
         typeof frame.motion === 'number' &&
         typeof frame.score === 'number';
}

/**
 * Type guard to check if frame has AI classification data
 */
export function isClassified(frame: FrameMetadata): frame is FrameMetadata & ClassifiedFrameMetadata {
  return typeof frame.productId === 'string' && typeof frame.variantId === 'string';
}

/**
 * Check if any frames in an array have AI classification data
 *
 * Useful for determining if classification processor has run on frame data.
 *
 * @param frames - Array of frames to check
 * @returns true if at least one frame has classification data
 */
export function hasClassifications(frames: FrameMetadata[] | undefined): boolean {
  if (!frames || frames.length === 0) return false;
  return frames.some(isClassified);
}

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
 */
export interface PipelineData {
  // Core data by type
  video?: VideoData;
  images?: string[];
  text?: string;

  /**
   * Auxiliary metadata not tracked in IO validation.
   * Used for passing context between processors that doesn't fit into typed fields:
   * - videoMetadata: Raw video metadata from FFmpeg
   * - analysisResult: Raw Gemini analysis response
   * - products: Product information from video analysis
   * - commercialImageUrls: Generated commercial image URLs
   *
   * Prefer using typed fields (frames, scoredFrames, etc.) for data that
   * affects IO validation and processor connectivity.
   */
  metadata?: Record<string, unknown>;

  // Extended frame data
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

  // Extended data (processors can add custom fields)
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
  /** Skip remaining processors */
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
  /** IO types available at end of stack */
  availableOutputs?: IOType[];
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

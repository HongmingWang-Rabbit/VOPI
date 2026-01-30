/**
 * Unified Video Analyzer Provider Interface
 *
 * Combines audio analysis and video frame selection in a single API call.
 * Uses Gemini's ability to process both audio and visual streams simultaneously.
 */

import type {
  FrameObstructions,
  BackgroundRecommendations,
} from '../../types/job.types.js';
import type { ProductMetadata } from '../../types/product-metadata.types.js';
import type { TokenUsageTracker } from '../../utils/token-usage.js';

/**
 * Frame selection from unified video analysis
 */
export interface UnifiedAnalysisFrame {
  /** Timestamp in seconds where this frame should be extracted */
  timestamp: number;
  /** Reason why this frame was selected */
  selectionReason: string;
  /** Product identified in this frame */
  productId: string;
  /** Variant of the product (e.g., color, angle) */
  variantId: string;
  /** Estimated camera angle */
  angleEstimate: string;
  /** Quality score 0-100 (combines visual quality and audio context relevance) */
  qualityScore: number;
  /** Estimated rotation angle for straightening */
  rotationAngleDeg: number;
  /** Description of the variant */
  variantDescription?: string;
  /** Obstruction information */
  obstructions: FrameObstructions;
  /** Background recommendations for commercial images */
  backgroundRecommendations: BackgroundRecommendations;
  /** Timestamp in audio where this product/variant is mentioned (if applicable) */
  audioMentionTimestamp?: number;
}

/**
 * Audio analysis result from unified analysis
 */
export interface UnifiedAudioAnalysis {
  /** Full transcript of audio */
  transcript: string;
  /** Detected language */
  language: string;
  /** Audio quality score 0-100 */
  audioQuality: number;
  /** Whether the video has usable audio */
  hasAudio: boolean;
  /** Structured product metadata extracted from audio */
  productMetadata?: ProductMetadata;
  /** Confidence scores for extracted metadata */
  confidence?: {
    overall: number;
    title: number;
    description: number;
    price?: number;
    attributes?: number;
  };
  /** Relevant excerpts from transcript */
  relevantExcerpts?: string[];
}

/**
 * Unified video analysis result
 */
export interface UnifiedVideoAnalysisResult {
  /** Products detected in the video (from both visual and audio analysis) */
  products: Array<{
    productId: string;
    description: string;
    category?: string;
    /** Whether this product was mentioned in audio */
    mentionedInAudio?: boolean;
  }>;
  /** Selected frames with timestamps */
  selectedFrames: UnifiedAnalysisFrame[];
  /** Total video duration analyzed */
  videoDuration: number;
  /** Number of frames analyzed by AI */
  framesAnalyzed: number;
  /** Audio analysis results */
  audioAnalysis: UnifiedAudioAnalysis;
  /** Raw response from provider (for debugging) */
  rawResponse?: unknown;
}

/**
 * Unified video analysis options
 */
export interface UnifiedVideoAnalysisOptions {
  /** Model to use for video analysis */
  model?: string;
  /** Maximum number of frames to select */
  maxFrames?: number;
  /** Maximum retries on failure */
  maxRetries?: number;
  /** Delay between retries in ms */
  retryDelay?: number;
  /** Temperature for AI model (0-1) */
  temperature?: number;
  /** Top-p sampling for AI model */
  topP?: number;
  /** Maximum bullet points to extract from audio */
  maxBulletPoints?: number;
  /** Focus areas for audio analysis (e.g., ['materials', 'dimensions']) */
  focusAreas?: string[];
  /** Skip audio analysis even if audio is present */
  skipAudioAnalysis?: boolean;
}

/**
 * UnifiedVideoAnalyzerProvider Interface
 *
 * This provider handles combined audio + video analysis in a single API call.
 * It leverages Gemini's ability to process both audio and visual streams
 * simultaneously, providing:
 * 1. Audio transcription and product metadata extraction
 * 2. Video frame analysis and selection
 * 3. Cross-modal context (audio mentions enhance frame selection)
 */
export interface UnifiedVideoAnalyzerProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Analyze video with combined audio + visual analysis
   * @param videoPath - Path to video file
   * @param options - Analysis options
   */
  analyzeVideo(
    videoPath: string,
    options?: UnifiedVideoAnalysisOptions,
    tokenUsage?: TokenUsageTracker
  ): Promise<UnifiedVideoAnalysisResult>;

  /**
   * Upload video to provider (if required)
   * @param videoPath - Path to video file
   * @returns URI or identifier for the uploaded video
   */
  uploadVideo?(videoPath: string): Promise<string>;

  /**
   * Delete uploaded video (cleanup)
   * @param videoUri - URI from uploadVideo
   */
  deleteVideo?(videoUri: string): Promise<void>;

  /**
   * Check if provider is available/configured
   */
  isAvailable(): boolean;
}

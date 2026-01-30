import type {
  FrameObstructions,
  BackgroundRecommendations,
} from '../../types/job.types.js';
import type { TokenUsageTracker } from '../../utils/token-usage.js';

/**
 * Frame selection from video analysis
 */
export interface VideoAnalysisFrame {
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
  /** Quality score 0-100 */
  qualityScore: number;
  /** Estimated rotation angle for straightening */
  rotationAngleDeg: number;
  /** Description of the variant */
  variantDescription?: string;
  /** Obstruction information */
  obstructions: FrameObstructions;
  /** Background recommendations for commercial images */
  backgroundRecommendations: BackgroundRecommendations;
}

/**
 * Video analysis result
 */
export interface VideoAnalysisResult {
  /** Products detected in the video */
  products: Array<{
    productId: string;
    description: string;
    category?: string;
  }>;
  /** Selected frames with timestamps */
  selectedFrames: VideoAnalysisFrame[];
  /** Total video duration analyzed */
  videoDuration: number;
  /** Number of frames analyzed by AI */
  framesAnalyzed: number;
  /** Raw response from provider (for debugging) */
  rawResponse?: unknown;
}

/**
 * Video analysis options
 */
export interface VideoAnalysisOptions {
  /** Model to use for video analysis */
  model?: string;
  /** Maximum number of frames to select */
  maxFrames?: number;
  /** FPS to sample for analysis (1 recommended for Gemini) */
  analysisFps?: number;
  /** Maximum retries on failure */
  maxRetries?: number;
  /** Delay between retries in ms */
  retryDelay?: number;
  /** Temperature for AI model (0-1) */
  temperature?: number;
  /** Top-p sampling for AI model */
  topP?: number;
}

/**
 * VideoAnalysisProvider Interface
 *
 * Implementations: GeminiVideoProvider, etc.
 *
 * This provider handles AI-based video analysis for frame selection.
 * Instead of extracting all frames and scoring them, it analyzes the
 * video directly and returns timestamps of the best frames.
 */
export interface VideoAnalysisProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Analyze video and select best frames
   * @param videoPath - Path to video file
   * @param options - Analysis options
   */
  analyzeVideo(
    videoPath: string,
    options?: VideoAnalysisOptions,
    tokenUsage?: TokenUsageTracker
  ): Promise<VideoAnalysisResult>;

  /**
   * Upload video to provider (if required)
   * Some providers require video to be uploaded before analysis
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

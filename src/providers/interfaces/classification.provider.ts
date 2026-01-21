import type {
  FrameObstructions,
  BackgroundRecommendations,
  VideoMetadata,
} from '../../types/job.types.js';

/**
 * Frame data for classification
 */
export interface ClassificationFrame {
  frameId: string;
  path: string;
  timestamp: number;
}

/**
 * Frame metadata for classification context
 */
export interface ClassificationFrameMetadata {
  frame_id: string;
  timestamp_sec: number;
  sequence_position: number;
  total_candidates: number;
}

/**
 * Classified frame result
 */
export interface ClassifiedFrame {
  frameId: string;
  productId: string;
  variantId: string;
  angleEstimate: string;
  qualityScore: number;
  rotationAngleDeg: number;
  obstructions: FrameObstructions;
  backgroundRecommendations: BackgroundRecommendations;
  variantDescription?: string;
  allFrameIds: string[];
}

/**
 * Classification result
 */
export interface ClassificationResult {
  /** Products detected in the video */
  products: Array<{
    productId: string;
    description: string;
    category?: string;
  }>;
  /** Classified frames grouped by variant */
  classifiedFrames: ClassifiedFrame[];
  /** Raw response from provider (for debugging) */
  rawResponse?: unknown;
}

/**
 * Classification options
 */
export interface ClassificationOptions {
  /** Model to use (provider-specific) */
  model?: string;
  /** Maximum retries on failure */
  maxRetries?: number;
  /** Delay between retries in ms */
  retryDelay?: number;
}

/**
 * ClassificationProvider Interface
 *
 * Implementations: GeminiProvider, OpenAIVisionProvider, ClaudeProvider, etc.
 *
 * This provider handles AI-based frame classification,
 * including product detection, variant discovery, and rotation detection.
 */
export interface ClassificationProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Classify frames using AI vision
   * @param frames - Frames to classify
   * @param metadata - Frame metadata for context
   * @param videoMetadata - Video metadata for context
   * @param options - Classification options
   */
  classifyFrames(
    frames: ClassificationFrame[],
    metadata: ClassificationFrameMetadata[],
    videoMetadata: VideoMetadata,
    options?: ClassificationOptions
  ): Promise<ClassificationResult>;

  /**
   * Check if provider is available/configured
   */
  isAvailable(): boolean;
}

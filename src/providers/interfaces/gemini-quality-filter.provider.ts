/**
 * Gemini Quality Filter Provider Interface
 *
 * Uses Gemini's vision capabilities to evaluate commercial image quality
 * and filter out unprofessional or duplicate images.
 */

import type { TokenUsageTracker } from '../../utils/token-usage.js';

/**
 * Quality evaluation result for a single image
 */
export interface ImageQualityEvaluation {
  /** Image identifier */
  imageId: string;
  /** Path to the image */
  imagePath: string;
  /** Overall quality score 0-100 */
  qualityScore: number;
  /** Whether the image should be kept */
  keep: boolean;
  /** Reason for the decision */
  reason: string;
  /** Detected issues */
  issues: ImageQualityIssue[];
  /** Image category for deduplication (e.g., "front-white", "back-lifestyle") */
  category: string;
  /** Angle/view type */
  angleType: string;
  /** Background type */
  backgroundType: 'white-studio' | 'lifestyle' | 'other';
}

/**
 * Types of quality issues that can be detected
 */
export type ImageQualityIssueType =
  | 'human_hand'           // Hand visible in image
  | 'human_body'           // Other body parts visible
  | 'blurry'               // Image is not sharp
  | 'poor_lighting'        // Bad lighting
  | 'awkward_angle'        // Unprofessional angle
  | 'product_modified'     // Product appears significantly different
  | 'background_artifacts' // Issues with generated background
  | 'duplicate'            // Similar to another image
  | 'low_quality'          // General low quality
  | 'text_illegible'       // Product text not readable
  | 'cropped_product';     // Product partially cut off

/**
 * Detailed quality issue
 */
export interface ImageQualityIssue {
  type: ImageQualityIssueType;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

/**
 * Options for quality filtering
 */
export interface QualityFilterOptions {
  /** Minimum quality score to keep (0-100, default: 60) */
  minQualityScore?: number;
  /** Maximum images to keep per angle type (default: 2) */
  maxPerAngle?: number;
  /** Maximum total images to keep (default: 6) */
  maxTotal?: number;
  /** Whether to allow images with hands (default: false) */
  allowHands?: boolean;
  /** Reference images (original frames) for comparison */
  referenceImages?: string[];
}

/**
 * Result of filtering a batch of images
 */
export interface QualityFilterResult {
  /** Images that passed the filter */
  kept: ImageQualityEvaluation[];
  /** Images that were filtered out */
  filtered: ImageQualityEvaluation[];
  /** Summary statistics */
  stats: {
    totalInput: number;
    totalKept: number;
    totalFiltered: number;
    filterReasons: Record<string, number>;
  };
}

/**
 * GeminiQualityFilterProvider Interface
 *
 * Uses Gemini's vision capabilities to:
 * 1. Evaluate image quality and professionalism
 * 2. Detect unwanted elements (hands, body parts)
 * 3. Identify and deduplicate similar images
 * 4. Score and rank images
 */
export interface GeminiQualityFilterProvider {
  /** Provider identifier */
  readonly providerId: string;

  /**
   * Evaluate a single image's quality
   * @param imagePath - Path to the image
   * @param options - Evaluation options
   */
  evaluateImage(
    imagePath: string,
    options?: Partial<QualityFilterOptions>
  ): Promise<ImageQualityEvaluation>;

  /**
   * Filter a batch of images, removing low quality and duplicates
   * @param imagePaths - Array of image paths with IDs
   * @param options - Filter options
   */
  filterImages(
    images: Array<{ id: string; path: string; variant: string }>,
    options?: QualityFilterOptions,
    tokenUsage?: TokenUsageTracker
  ): Promise<QualityFilterResult>;

  /**
   * Check if provider is available
   */
  isAvailable(): boolean;
}

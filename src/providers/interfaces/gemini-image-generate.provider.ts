/**
 * Gemini Image Generation Provider Interface
 *
 * Defines the contract for generating product images using Gemini's image generation capabilities.
 * This provider generates variants (white studio, lifestyle) from raw video frames.
 */

import type { TokenUsageTracker } from '../../utils/token-usage.js';

/**
 * Variant types for Gemini image generation
 */
export type GeminiImageVariant = 'white-studio' | 'lifestyle';

/**
 * Result of Gemini image generation
 */
export interface GeminiImageGenerateResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  variant?: GeminiImageVariant;
  error?: string;
}

/**
 * Options for generating a single image variant
 */
export interface GeminiImageGenerateOptions {
  /** The variant type to generate */
  variant: GeminiImageVariant;
  /** Product title from audio analysis (used for context) */
  productTitle?: string;
  /** Product description from audio analysis (used for lifestyle context) */
  productDescription?: string;
  /** Product category for better scene generation */
  productCategory?: string;
  /** Seed for reproducibility */
  seed?: number;
  /** Reference frames showing the product from different angles (for context) */
  referenceFramePaths?: string[];
}

/**
 * Options for generating all variants for a frame
 */
export interface GeminiImageGenerateAllOptions {
  /** Product title from audio analysis */
  productTitle?: string;
  /** Product description from audio analysis */
  productDescription?: string;
  /** Product category for better scene generation */
  productCategory?: string;
  /** Which variants to generate (default: both) */
  variants?: GeminiImageVariant[];
  /** Reference frames showing the product from different angles (for context) */
  referenceFramePaths?: string[];
}

/**
 * Result of generating all variants for a frame
 */
export interface GeminiImageGenerateAllResult {
  frameId: string;
  variants: Record<GeminiImageVariant, GeminiImageGenerateResult>;
  successCount: number;
  errorCount: number;
}

/**
 * GeminiImageGenerateProvider Interface
 *
 * This provider uses Gemini's native image generation to create
 * commercial-ready product images directly from raw video frames.
 *
 * Unlike traditional pipelines that require:
 * - Background removal (Claid/Stability)
 * - Hole filling (Stability)
 * - Centering (Sharp)
 * - Commercial generation (Stability)
 *
 * This provider handles everything in a single Gemini call,
 * generating both white studio and lifestyle variants.
 */
export interface GeminiImageGenerateProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Generate a single variant for an image
   * @param imagePath - Path to raw input image (no preprocessing needed)
   * @param outputPath - Path for output image
   * @param options - Generation options including variant type and product context
   */
  generateVariant(
    imagePath: string,
    outputPath: string,
    options: GeminiImageGenerateOptions,
    tokenUsage?: TokenUsageTracker
  ): Promise<GeminiImageGenerateResult>;

  /**
   * Generate all variants for a single frame
   * @param imagePath - Path to raw input image
   * @param outputDir - Directory for output files
   * @param frameId - Frame identifier for naming
   * @param options - Generation options
   */
  generateAllVariants(
    imagePath: string,
    outputDir: string,
    frameId: string,
    options?: GeminiImageGenerateAllOptions,
    tokenUsage?: TokenUsageTracker
  ): Promise<GeminiImageGenerateAllResult>;

  /**
   * Check if provider is available/configured
   */
  isAvailable(): boolean;
}

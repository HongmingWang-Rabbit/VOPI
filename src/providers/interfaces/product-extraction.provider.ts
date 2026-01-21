import type { FrameObstructions } from '../../types/job.types.js';
import type { BoundingBox, ImageDimensions } from './image-transform.provider.js';

/**
 * Frame data for product extraction
 */
export interface ExtractionFrame {
  frameId: string;
  path: string;
  rotationAngleDeg: number;
  obstructions?: FrameObstructions;
  recommendedType: string;
}

/**
 * Result of product extraction
 */
export interface ProductExtractionResult {
  success: boolean;
  outputPath?: string;
  rotationApplied: number;
  boundingBox?: BoundingBox;
  originalSize?: ImageDimensions;
  finalSize?: ImageDimensions;
  error?: string;
}

/**
 * Options for product extraction
 */
export interface ProductExtractionOptions {
  /** Use AI edit to remove obstructions */
  useAIEdit?: boolean;
  /** Padding percentage (0-1) */
  padding?: number;
  /** Minimum output size */
  minOutputSize?: number;
  /** Alpha threshold for detecting non-transparent pixels (0-255). Default: 10 */
  alphaThreshold?: number;
  /** Progress callback */
  onProgress?: (current: number, total: number) => Promise<void>;
}

/**
 * ProductExtractionProvider Interface
 *
 * Implementations: DefaultProductExtractionProvider, CVProductExtractionProvider, etc.
 *
 * This provider handles the complete product extraction pipeline:
 * 1. Remove background
 * 2. Rotate to straighten
 * 3. Find product bounds
 * 4. Crop and center
 *
 * Different implementations can use different detection methods:
 * - AI-based (current default using Photoroom + Gemini rotation)
 * - Computer Vision based (edge detection, contour analysis)
 * - Hybrid approaches
 */
export interface ProductExtractionProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Extract a single product from a frame
   * @param frame - Frame to extract product from
   * @param outputDir - Directory for output files
   * @param options - Extraction options
   */
  extractProduct(
    frame: ExtractionFrame,
    outputDir: string,
    options?: ProductExtractionOptions
  ): Promise<ProductExtractionResult>;

  /**
   * Extract products from multiple frames
   * @param frames - Frames to extract products from
   * @param outputDir - Directory for output files
   * @param options - Extraction options
   */
  extractProducts(
    frames: ExtractionFrame[],
    outputDir: string,
    options?: ProductExtractionOptions
  ): Promise<Map<string, ProductExtractionResult>>;

  /**
   * Check if provider is available/configured
   */
  isAvailable(): boolean;
}

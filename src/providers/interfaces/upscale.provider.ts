/**
 * Upscale Provider Interface
 *
 * Defines the contract for AI-powered image upscaling providers.
 * Used to increase image resolution while maintaining or enhancing quality.
 */

/**
 * Options for upscaling an image
 */
export interface UpscaleOptions {
  /** Output format (default: png) */
  outputFormat?: 'png' | 'jpeg' | 'webp';
  /** Target width - if set, scales to this width (height auto-calculated) */
  targetWidth?: number;
  /** Target height - if set, scales to this height (width auto-calculated) */
  targetHeight?: number;
  /** Creativity level 0-1 (default: 0.35). Controls additional detail generation. */
  creativity?: number;
  /** Prompt describing the image for better upscaling results */
  prompt?: string;
  /** Negative prompt to avoid certain artifacts */
  negativePrompt?: string;
  /** Seed for reproducible results (default: 0 = random) */
  seed?: number;
}

/**
 * Result of upscaling operation
 */
export interface UpscaleResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  /** Final image width */
  width?: number;
  /** Final image height */
  height?: number;
  /** Output file size in bytes */
  size?: number;
  /** Upscale method used */
  method?: string;
}

/**
 * UpscaleProvider Interface
 *
 * Implementations: StabilityUpscaleProvider, etc.
 */
export interface UpscaleProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Upscale an image to higher resolution
   *
   * @param imagePath - Path to input image
   * @param outputPath - Path for output image
   * @param options - Upscale options
   */
  upscale(
    imagePath: string,
    outputPath: string,
    options?: UpscaleOptions
  ): Promise<UpscaleResult>;

  /**
   * Check if provider is available (API key configured, etc.)
   */
  isAvailable(): boolean;
}

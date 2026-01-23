/**
 * Processor Concurrency Defaults
 *
 * Centralized concurrency configuration for parallel processing.
 * Values are tuned based on the type of work each processor does.
 *
 * Environment variable overrides:
 * - VOPI_CONCURRENCY_CLAID_BG_REMOVE
 * - VOPI_CONCURRENCY_STABILITY_INPAINT
 * - VOPI_CONCURRENCY_STABILITY_BG_REMOVE
 * - VOPI_CONCURRENCY_STABILITY_UPSCALE
 * - VOPI_CONCURRENCY_STABILITY_COMMERCIAL
 * - VOPI_CONCURRENCY_SHARP_TRANSFORM
 * - VOPI_CONCURRENCY_PHOTOROOM_GENERATE
 * - VOPI_CONCURRENCY_FFMPEG_EXTRACT
 * - VOPI_CONCURRENCY_GEMINI_CLASSIFY
 * - VOPI_CONCURRENCY_GEMINI_IMAGE_GENERATE
 * - VOPI_CONCURRENCY_S3_UPLOAD
 */

/**
 * Parse environment variable as positive integer, with fallback
 * @internal Exported for testing
 */
export function getEnvConcurrency(key: string, defaultValue: number): number {
  const envKey = `VOPI_CONCURRENCY_${key}`;
  const envValue = process.env[envKey];
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return defaultValue;
}

/**
 * Concurrency limits for different processor types
 * Values can be overridden via VOPI_CONCURRENCY_* environment variables
 */
export const PROCESSOR_CONCURRENCY = {
  /**
   * Claid.ai background removal API
   * - External API with rate limits
   * - Each request takes 2-5 seconds
   */
  CLAID_BG_REMOVE: getEnvConcurrency('CLAID_BG_REMOVE', 5),

  /**
   * Stability AI inpainting API
   * - External API with rate limits
   * - Each request takes 3-8 seconds
   */
  STABILITY_INPAINT: getEnvConcurrency('STABILITY_INPAINT', 4),

  /**
   * Stability AI background removal API
   * - External API with rate limits
   * - Each request takes 2-5 seconds
   */
  STABILITY_BG_REMOVE: getEnvConcurrency('STABILITY_BG_REMOVE', 4),

  /**
   * Stability AI upscale API
   * - External API with rate limits
   * - Each request takes 3-10 seconds
   * - Lower concurrency due to higher resource usage
   */
  STABILITY_UPSCALE: getEnvConcurrency('STABILITY_UPSCALE', 2),

  /**
   * Stability AI commercial image generation (Replace Background and Relight)
   * - External API with rate limits
   * - Each request takes 5-15 seconds (more complex than other operations)
   * - Lower concurrency due to heavy processing
   */
  STABILITY_COMMERCIAL: getEnvConcurrency('STABILITY_COMMERCIAL', 2),

  /**
   * Sharp image transformations (centering, cropping)
   * - CPU-bound local processing
   * - Very fast per-image (~50-200ms)
   * - Higher concurrency for throughput
   */
  SHARP_TRANSFORM: getEnvConcurrency('SHARP_TRANSFORM', 8),

  /**
   * Photoroom commercial image generation
   * - External API with rate limits
   * - Each request takes 2-4 seconds
   */
  PHOTOROOM_GENERATE: getEnvConcurrency('PHOTOROOM_GENERATE', 3),

  /**
   * FFmpeg parallel frame extraction
   * - I/O bound (disk reads/writes)
   * - Multiple FFmpeg processes
   * - Balanced for disk throughput
   */
  FFMPEG_EXTRACT: getEnvConcurrency('FFMPEG_EXTRACT', 4),

  /**
   * Gemini API batch classification
   * - External API with rate limits
   * - Each batch takes 30-180 seconds
   * - Low concurrency to avoid quota exhaustion
   */
  GEMINI_CLASSIFY: getEnvConcurrency('GEMINI_CLASSIFY', 2),

  /**
   * Gemini API image generation
   * - External API with rate limits
   * - Each image generation takes 10-30 seconds
   * - Conservative concurrency for API limits
   */
  GEMINI_IMAGE_GENERATE: getEnvConcurrency('GEMINI_IMAGE_GENERATE', 2),

  /**
   * S3 file uploads
   * - Network I/O bound
   * - Connection reuse via keep-alive
   * - Higher concurrency for throughput
   */
  S3_UPLOAD: getEnvConcurrency('S3_UPLOAD', 6),
};

export type ProcessorConcurrencyKey = keyof typeof PROCESSOR_CONCURRENCY;

/** Maximum allowed concurrency to prevent resource exhaustion */
export const MAX_CONCURRENCY = 50;

/**
 * Get concurrency value with optional override from processor options.
 *
 * @param key - The processor concurrency key (e.g., 'CLAID_BG_REMOVE')
 * @param options - Optional processor options that may contain a `concurrency` override
 * @returns The concurrency value: override if valid (positive number <= MAX_CONCURRENCY),
 *          otherwise the default for the given key
 *
 * @example
 * // Use default concurrency
 * const concurrency = getConcurrency('CLAID_BG_REMOVE');
 *
 * @example
 * // Override via options
 * const concurrency = getConcurrency('CLAID_BG_REMOVE', { concurrency: 10 });
 */
export function getConcurrency(
  key: ProcessorConcurrencyKey,
  options?: Record<string, unknown>
): number {
  const override = options?.concurrency;
  if (typeof override === 'number' && override > 0) {
    const value = Math.floor(override);
    // Cap at MAX_CONCURRENCY to prevent resource exhaustion
    return Math.min(value, MAX_CONCURRENCY);
  }
  return PROCESSOR_CONCURRENCY[key];
}

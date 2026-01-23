/**
 * Processor Concurrency Defaults
 *
 * Centralized concurrency configuration for parallel processing.
 * Values are tuned based on the type of work each processor does.
 */

/**
 * Concurrency limits for different processor types
 */
export const PROCESSOR_CONCURRENCY = {
  /**
   * Claid.ai background removal API
   * - External API with rate limits
   * - Each request takes 2-5 seconds
   */
  CLAID_BG_REMOVE: 5,

  /**
   * Stability AI inpainting API
   * - External API with rate limits
   * - Each request takes 3-8 seconds
   * - Lower concurrency to avoid rate limiting
   */
  STABILITY_INPAINT: 3,

  /**
   * Sharp image transformations (centering, cropping)
   * - CPU-bound local processing
   * - Very fast per-image (~50-200ms)
   * - Higher concurrency for throughput
   */
  SHARP_TRANSFORM: 8,

  /**
   * Photoroom commercial image generation
   * - External API with rate limits
   * - Each request takes 2-4 seconds
   */
  PHOTOROOM_GENERATE: 3,

  /**
   * FFmpeg parallel frame extraction
   * - I/O bound (disk reads/writes)
   * - Multiple FFmpeg processes
   * - Balanced for disk throughput
   */
  FFMPEG_EXTRACT: 4,
} as const;

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

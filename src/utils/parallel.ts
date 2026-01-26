/**
 * Parallel Processing Utilities
 *
 * Provides helpers for running async operations in parallel with concurrency limits.
 */

export interface ParallelOptions {
  /** Maximum number of concurrent operations (default: 5) */
  concurrency?: number;
  /** Whether to stop on first error (default: false - collect all results) */
  stopOnError?: boolean;
}

export interface ParallelResult<T> {
  /** Results in same order as input items */
  results: (T | Error)[];
  /** Number of successful operations */
  successCount: number;
  /** Number of failed operations */
  errorCount: number;
}

/**
 * Run async operations in parallel with concurrency limit
 *
 * @param items - Array of items to process
 * @param fn - Async function to apply to each item
 * @param options - Concurrency and error handling options
 * @returns Results array in same order as input, with errors captured
 *
 * @example
 * const results = await parallelMap(frames, async (frame, index) => {
 *   return await processFrame(frame);
 * }, { concurrency: 5 });
 */
export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: ParallelOptions = {}
): Promise<ParallelResult<R>> {
  const { concurrency = 5, stopOnError = false } = options;

  const results: (R | Error)[] = new Array(items.length);
  let successCount = 0;
  let errorCount = 0;
  let stopped = false;

  // Create a queue of work
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      // Capture index atomically before any async work
      const index = nextIndex;
      if (index >= items.length) {
        break;
      }
      nextIndex++;

      const item = items[index];

      try {
        results[index] = await fn(item, index);
        successCount++;
      } catch (error) {
        results[index] = error instanceof Error ? error : new Error(String(error));
        errorCount++;

        if (stopOnError) {
          stopped = true;
        }
      }
    }
  };

  // Start workers up to concurrency limit
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);

  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return { results, successCount, errorCount };
}

/**
 * Check if a result from parallelMap is an error
 */
export function isParallelError<T>(result: T | Error): result is Error {
  return result instanceof Error;
}

/**
 * Split an array into chunks of specified size
 *
 * @param items - Array to chunk
 * @param size - Maximum size of each chunk
 * @returns Array of chunks
 *
 * @example
 * chunk([1, 2, 3, 4, 5], 2) // [[1, 2], [3, 4], [5]]
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error('Chunk size must be positive');
  }

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

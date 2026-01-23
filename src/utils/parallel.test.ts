/**
 * Parallel Processing Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { parallelMap, isParallelError } from './parallel.js';

describe('parallelMap', () => {
  describe('basic functionality', () => {
    it('should process all items and return results in order', async () => {
      const items = [1, 2, 3, 4, 5];
      const result = await parallelMap(items, async (item) => item * 2);

      expect(result.results).toEqual([2, 4, 6, 8, 10]);
      expect(result.successCount).toBe(5);
      expect(result.errorCount).toBe(0);
    });

    it('should handle empty array', async () => {
      const result = await parallelMap([], async (item: number) => item * 2);

      expect(result.results).toEqual([]);
      expect(result.successCount).toBe(0);
      expect(result.errorCount).toBe(0);
    });

    it('should pass index to the callback function', async () => {
      const items = ['a', 'b', 'c'];
      const result = await parallelMap(items, async (item, index) => `${item}-${index}`);

      expect(result.results).toEqual(['a-0', 'b-1', 'c-2']);
    });

    it('should handle single item', async () => {
      const result = await parallelMap([42], async (item) => item + 1);

      expect(result.results).toEqual([43]);
      expect(result.successCount).toBe(1);
      expect(result.errorCount).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('should respect concurrency limit', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      await parallelMap(
        items,
        async (item) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

          await new Promise((resolve) => setTimeout(resolve, 10));

          currentConcurrent--;
          return item;
        },
        { concurrency: 3 }
      );

      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it('should use default concurrency of 5', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const items = Array.from({ length: 20 }, (_, i) => i);

      await parallelMap(items, async (item) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

        await new Promise((resolve) => setTimeout(resolve, 5));

        currentConcurrent--;
        return item;
      });

      expect(maxConcurrent).toBeLessThanOrEqual(5);
    });

    it('should handle concurrency greater than item count', async () => {
      const items = [1, 2, 3];
      const result = await parallelMap(
        items,
        async (item) => item * 2,
        { concurrency: 10 }
      );

      expect(result.results).toEqual([2, 4, 6]);
      expect(result.successCount).toBe(3);
    });

    it('should handle concurrency of 1 (sequential)', async () => {
      const order: number[] = [];
      const items = [1, 2, 3, 4, 5];

      await parallelMap(
        items,
        async (item) => {
          order.push(item);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return item;
        },
        { concurrency: 1 }
      );

      // With concurrency 1, items should be processed in order
      expect(order).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('error handling', () => {
    it('should capture errors and continue processing by default', async () => {
      const items = [1, 2, 3, 4, 5];
      const result = await parallelMap(items, async (item) => {
        if (item === 3) {
          throw new Error('Item 3 failed');
        }
        return item * 2;
      });

      expect(result.successCount).toBe(4);
      expect(result.errorCount).toBe(1);
      expect(result.results[0]).toBe(2);
      expect(result.results[1]).toBe(4);
      expect(result.results[2]).toBeInstanceOf(Error);
      expect((result.results[2] as Error).message).toBe('Item 3 failed');
      expect(result.results[3]).toBe(8);
      expect(result.results[4]).toBe(10);
    });

    it('should stop on first error when stopOnError is true', async () => {
      const processedItems: number[] = [];
      const items = [1, 2, 3, 4, 5];

      const result = await parallelMap(
        items,
        async (item) => {
          processedItems.push(item);
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (item === 2) {
            throw new Error('Stop here');
          }
          return item;
        },
        { concurrency: 1, stopOnError: true }
      );

      expect(result.errorCount).toBe(1);
      // With concurrency 1 and stopOnError, should process 1, then fail on 2
      expect(processedItems).toEqual([1, 2]);
    });

    it('should convert non-Error throws to Error objects', async () => {
      const items = [1];
      const result = await parallelMap(items, async () => {
        throw 'string error';
      });

      expect(result.results[0]).toBeInstanceOf(Error);
      expect((result.results[0] as Error).message).toBe('string error');
    });

    it('should handle multiple errors', async () => {
      const items = [1, 2, 3, 4, 5];
      const result = await parallelMap(items, async (item) => {
        if (item % 2 === 0) {
          throw new Error(`Error for ${item}`);
        }
        return item;
      });

      expect(result.successCount).toBe(3);
      expect(result.errorCount).toBe(2);
      expect(result.results[0]).toBe(1);
      expect(result.results[1]).toBeInstanceOf(Error);
      expect(result.results[2]).toBe(3);
      expect(result.results[3]).toBeInstanceOf(Error);
      expect(result.results[4]).toBe(5);
    });
  });

  describe('async behavior', () => {
    it('should handle varying async durations', async () => {
      const items = [100, 50, 150, 25, 75];
      const startTime = Date.now();

      const result = await parallelMap(
        items,
        async (delay) => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return delay;
        },
        { concurrency: 5 }
      );

      const elapsed = Date.now() - startTime;

      // With concurrency 5, all should run in parallel
      // Total time should be close to max delay (150ms), not sum (400ms)
      expect(elapsed).toBeLessThan(300); // Give some buffer
      expect(result.results).toEqual([100, 50, 150, 25, 75]);
    });

    it('should maintain result order despite different completion times', async () => {
      const items = [3, 1, 2]; // Items with different "delays"

      const result = await parallelMap(
        items,
        async (item) => {
          await new Promise((resolve) => setTimeout(resolve, item * 10));
          return item;
        },
        { concurrency: 3 }
      );

      // Results should be in original order, not completion order
      expect(result.results).toEqual([3, 1, 2]);
    });
  });
});

describe('isParallelError', () => {
  it('should return true for Error instances', () => {
    expect(isParallelError(new Error('test'))).toBe(true);
    expect(isParallelError(new TypeError('test'))).toBe(true);
    expect(isParallelError(new RangeError('test'))).toBe(true);
  });

  it('should return false for non-Error values', () => {
    expect(isParallelError('string')).toBe(false);
    expect(isParallelError(42)).toBe(false);
    expect(isParallelError(null)).toBe(false);
    expect(isParallelError(undefined)).toBe(false);
    expect(isParallelError({ message: 'fake error' })).toBe(false);
    expect(isParallelError([1, 2, 3])).toBe(false);
  });

  it('should work with parallelMap results', async () => {
    const result = await parallelMap([1, 2, 3], async (item) => {
      if (item === 2) throw new Error('fail');
      return item;
    });

    const errors = result.results.filter(isParallelError);
    const successes = result.results.filter((r) => !isParallelError(r));

    expect(errors).toHaveLength(1);
    expect(successes).toHaveLength(2);
  });
});

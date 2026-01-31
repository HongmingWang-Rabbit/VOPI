import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenUsageTracker, estimateCost } from './token-usage.js';

// Mock logger
vi.mock('./logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('TokenUsageTracker', () => {
  let tracker: TokenUsageTracker;

  beforeEach(() => {
    tracker = new TokenUsageTracker();
  });

  describe('record', () => {
    it('should create a new entry for a new processor+model combination', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        model: 'gemini-2.0-flash',
        processor: 'gemini-classify',
        promptTokens: 100,
        candidatesTokens: 50,
        totalTokens: 150,
        callCount: 1,
      });
    });

    it('should accumulate tokens for the same processor+model', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
      tracker.record('gemini-2.0-flash', 'gemini-classify', 200, 80);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        model: 'gemini-2.0-flash',
        processor: 'gemini-classify',
        promptTokens: 300,
        candidatesTokens: 130,
        totalTokens: 430,
        callCount: 2,
      });
    });

    it('should track different processor+model combinations separately', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
      tracker.record('gemini-2.5-flash', 'gemini-image-generate', 200, 80);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(2);
    });

    it('should track same processor with different models separately', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
      tracker.record('gemini-2.5-flash', 'gemini-classify', 200, 80);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(2);
    });
  });

  describe('getSummary', () => {
    it('should return empty summary when no records', () => {
      const summary = tracker.getSummary();
      expect(summary.entries).toHaveLength(0);
      expect(summary.totals).toEqual({
        promptTokens: 0,
        candidatesTokens: 0,
        totalTokens: 0,
      });
    });

    it('should compute correct totals across multiple entries', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
      tracker.record('gemini-2.5-flash', 'gemini-image-generate', 200, 80);
      tracker.record('gemini-2.0-flash', 'gemini-audio-analysis', 300, 120);

      const { totals } = tracker.getSummary();
      expect(totals).toEqual({
        promptTokens: 600,
        candidatesTokens: 250,
        totalTokens: 850,
      });
    });
  });

  describe('logSummary', () => {
    it('should not log when no entries exist', () => {
      // Should not throw
      tracker.logSummary();
    });

    it('should not throw when called with entries', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
      expect(() => tracker.logSummary()).not.toThrow();
    });

    it('should accept optional jobId', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
      expect(() => tracker.logSummary('job-123')).not.toThrow();
    });
  });

  describe('reset', () => {
    it('should clear all entries', () => {
      tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
      tracker.record('gemini-2.5-flash', 'gemini-image-generate', 200, 80);

      tracker.reset();

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(0);
    });
  });
});

describe('estimateCost', () => {
  it('should calculate cost for known model', () => {
    const usage: import('./token-usage.js').TokenUsage = {
      model: 'gemini-2.0-flash',
      processor: 'test',
      promptTokens: 1_000_000, // 1M tokens
      candidatesTokens: 1_000_000, // 1M tokens
      totalTokens: 2_000_000,
      callCount: 1,
    };

    const cost = estimateCost(usage);
    expect(cost).not.toBeNull();

    // gemini-2.0-flash: prompt=$0.00001875/1M, candidates=$0.000075/1M
    const expectedCost = 0.00001875 + 0.000075;
    expect(cost).toBeCloseTo(expectedCost, 8);
  });

  it('should return null for unknown model', () => {
    const usage: import('./token-usage.js').TokenUsage = {
      model: 'unknown-model',
      processor: 'test',
      promptTokens: 1000,
      candidatesTokens: 500,
      totalTokens: 1500,
      callCount: 1,
    };

    const cost = estimateCost(usage);
    expect(cost).toBeNull();
  });

  it('should handle zero tokens', () => {
    const usage: import('./token-usage.js').TokenUsage = {
      model: 'gemini-2.0-flash',
      processor: 'test',
      promptTokens: 0,
      candidatesTokens: 0,
      totalTokens: 0,
      callCount: 1,
    };

    const cost = estimateCost(usage);
    expect(cost).toBe(0);
  });

  it('should handle free models', () => {
    const usage: import('./token-usage.js').TokenUsage = {
      model: 'gemini-2.0-flash-exp',
      processor: 'test',
      promptTokens: 1_000_000,
      candidatesTokens: 1_000_000,
      totalTokens: 2_000_000,
      callCount: 1,
    };

    const cost = estimateCost(usage);
    expect(cost).toBe(0);
  });

  it('should handle very large token counts', () => {
    const usage: import('./token-usage.js').TokenUsage = {
      model: 'gemini-2.0-flash',
      processor: 'test',
      promptTokens: 1_000_000_000, // 1 billion tokens
      candidatesTokens: 1_000_000_000,
      totalTokens: 2_000_000_000,
      callCount: 1,
    };

    const cost = estimateCost(usage);
    expect(cost).not.toBeNull();
    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('should calculate cost accurately for different models', () => {
    const usage1_5Pro: import('./token-usage.js').TokenUsage = {
      model: 'gemini-1.5-pro',
      processor: 'test',
      promptTokens: 1_000_000,
      candidatesTokens: 1_000_000,
      totalTokens: 2_000_000,
      callCount: 1,
    };

    const cost = estimateCost(usage1_5Pro);
    expect(cost).not.toBeNull();
    // gemini-1.5-pro: prompt=$0.00125/1M, candidates=$0.005/1M
    const expectedCost = 0.00125 + 0.005;
    expect(cost).toBeCloseTo(expectedCost, 8);
  });

  it('should handle model names with different casing', () => {
    // Should not match - model names are case-sensitive
    const usage: import('./token-usage.js').TokenUsage = {
      model: 'GEMINI-2.0-FLASH',
      processor: 'test',
      promptTokens: 1_000_000,
      candidatesTokens: 1_000_000,
      totalTokens: 2_000_000,
      callCount: 1,
    };

    const cost = estimateCost(usage);
    expect(cost).toBeNull(); // Case-sensitive, so no match
  });
});

describe('TokenUsageTracker - Edge Cases', () => {
  let tracker: TokenUsageTracker;

  beforeEach(() => {
    tracker = new TokenUsageTracker();
  });

  describe('large numbers and overflow', () => {
    it('should handle very large token counts without overflow', () => {
      const largeNumber = Number.MAX_SAFE_INTEGER - 1000;
      tracker.record('gemini-2.0-flash', 'test', largeNumber, 500);

      const { entries } = tracker.getSummary();
      expect(entries[0].promptTokens).toBe(largeNumber);
      expect(entries[0].totalTokens).toBe(largeNumber + 500);
    });

    it('should accumulate large numbers correctly', () => {
      const billion = 1_000_000_000;
      tracker.record('gemini-2.0-flash', 'test', billion, billion);
      tracker.record('gemini-2.0-flash', 'test', billion, billion);

      const { entries, totals } = tracker.getSummary();
      expect(entries[0].promptTokens).toBe(2 * billion);
      expect(totals.totalTokens).toBe(4 * billion);
    });

    it('should handle many small accumulations', () => {
      for (let i = 0; i < 10000; i++) {
        tracker.record('gemini-2.0-flash', 'test', 10, 5);
      }

      const { entries } = tracker.getSummary();
      expect(entries[0].promptTokens).toBe(100000);
      expect(entries[0].candidatesTokens).toBe(50000);
      expect(entries[0].callCount).toBe(10000);
    });
  });

  describe('negative and invalid values', () => {
    it('should accept negative token counts (API may return corrections)', () => {
      // Some APIs might return negative values for corrections/adjustments
      tracker.record('gemini-2.0-flash', 'test', -100, 200);

      const { entries } = tracker.getSummary();
      expect(entries[0].promptTokens).toBe(-100);
      expect(entries[0].totalTokens).toBe(100);
    });

    it('should handle zero values', () => {
      tracker.record('gemini-2.0-flash', 'test', 0, 0);

      const { entries } = tracker.getSummary();
      expect(entries[0].promptTokens).toBe(0);
      expect(entries[0].candidatesTokens).toBe(0);
      expect(entries[0].totalTokens).toBe(0);
      expect(entries[0].callCount).toBe(1);
    });
  });

  describe('string edge cases', () => {
    it('should handle empty processor name', () => {
      tracker.record('gemini-2.0-flash', '', 100, 50);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(1);
      expect(entries[0].processor).toBe('');
    });

    it('should handle empty model name', () => {
      tracker.record('', 'test-processor', 100, 50);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(1);
      expect(entries[0].model).toBe('');
    });

    it('should handle very long processor names', () => {
      const longName = 'a'.repeat(1000);
      tracker.record('gemini-2.0-flash', longName, 100, 50);

      const { entries } = tracker.getSummary();
      expect(entries[0].processor).toBe(longName);
    });

    it('should handle special characters in names', () => {
      const specialChars = 'test-processor@v2.0 (beta) [experimental]';
      tracker.record('gemini-2.0-flash', specialChars, 100, 50);

      const { entries } = tracker.getSummary();
      expect(entries[0].processor).toBe(specialChars);
    });

    it('should handle unicode characters in names', () => {
      tracker.record('gemini-2.0-flash', '测试处理器-🚀', 100, 50);

      const { entries } = tracker.getSummary();
      expect(entries[0].processor).toBe('测试处理器-🚀');
    });

    it('should treat different processor names as separate entries', () => {
      tracker.record('gemini-2.0-flash', 'processor-1', 100, 50);
      tracker.record('gemini-2.0-flash', 'processor-2', 200, 80);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(2);
    });

    it('should treat whitespace-different names as different', () => {
      tracker.record('gemini-2.0-flash', 'processor', 100, 50);
      tracker.record('gemini-2.0-flash', 'processor ', 200, 80); // trailing space

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(2);
    });
  });

  describe('concurrent operations simulation', () => {
    it('should handle rapid sequential calls', () => {
      const iterations = 1000;
      for (let i = 0; i < iterations; i++) {
        tracker.record('gemini-2.0-flash', 'test', 1, 1);
      }

      const { entries } = tracker.getSummary();
      expect(entries[0].callCount).toBe(iterations);
      expect(entries[0].promptTokens).toBe(iterations);
    });

    it('should handle interleaved calls to different processors', () => {
      for (let i = 0; i < 100; i++) {
        tracker.record('gemini-2.0-flash', 'processor-a', 10, 5);
        tracker.record('gemini-2.0-flash', 'processor-b', 20, 10);
        tracker.record('gemini-2.5-flash', 'processor-a', 15, 7);
      }

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(3);

      const procA_v2 = entries.find(e => e.processor === 'processor-a' && e.model === 'gemini-2.0-flash');
      const procB_v2 = entries.find(e => e.processor === 'processor-b' && e.model === 'gemini-2.0-flash');
      const procA_v25 = entries.find(e => e.processor === 'processor-a' && e.model === 'gemini-2.5-flash');

      expect(procA_v2?.callCount).toBe(100);
      expect(procB_v2?.callCount).toBe(100);
      expect(procA_v25?.callCount).toBe(100);
    });
  });

  describe('getSummary edge cases', () => {
    it('should return consistent results on multiple calls', () => {
      tracker.record('gemini-2.0-flash', 'test', 100, 50);

      const summary1 = tracker.getSummary();
      const summary2 = tracker.getSummary();

      expect(summary1.totals).toEqual(summary2.totals);
      expect(summary1.entries.length).toBe(summary2.entries.length);
    });

    it('should handle getSummary during active recording', () => {
      tracker.record('gemini-2.0-flash', 'test-1', 100, 50);

      const summary1 = tracker.getSummary();
      expect(summary1.entries).toHaveLength(1);

      tracker.record('gemini-2.0-flash', 'test-2', 200, 80);

      const summary2 = tracker.getSummary();
      expect(summary2.entries).toHaveLength(2);
    });

    it('should return live references to entries (documented behavior)', () => {
      // Note: The current implementation returns live references, not copies.
      // This is documented in JSDoc and acceptable for internal state management.
      tracker.record('gemini-2.0-flash', 'test', 100, 50);

      const summary1 = tracker.getSummary();
      const summary2 = tracker.getSummary();

      // Entries are live references - same objects
      expect(summary1.entries[0]).toBe(summary2.entries[0]);
    });
  });

  describe('reset edge cases', () => {
    it('should handle reset when already empty', () => {
      tracker.reset();
      tracker.reset();

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(0);
    });

    it('should allow recording after reset', () => {
      tracker.record('gemini-2.0-flash', 'test', 100, 50);
      tracker.reset();
      tracker.record('gemini-2.0-flash', 'test', 200, 80);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(1);
      expect(entries[0].promptTokens).toBe(200);
    });

    it('should handle multiple record-reset cycles', () => {
      for (let i = 0; i < 10; i++) {
        tracker.record('gemini-2.0-flash', 'test', 100 * i, 50 * i);
        const summary = tracker.getSummary();
        expect(summary.entries).toHaveLength(1);
        tracker.reset();
      }

      const finalSummary = tracker.getSummary();
      expect(finalSummary.entries).toHaveLength(0);
    });
  });

  describe('logSummary edge cases', () => {
    it('should handle undefined jobId', () => {
      tracker.record('gemini-2.0-flash', 'test', 100, 50);
      expect(() => tracker.logSummary(undefined)).not.toThrow();
    });

    it('should handle empty string jobId', () => {
      tracker.record('gemini-2.0-flash', 'test', 100, 50);
      expect(() => tracker.logSummary('')).not.toThrow();
    });

    it('should handle very long jobId', () => {
      tracker.record('gemini-2.0-flash', 'test', 100, 50);
      const longJobId = 'a'.repeat(10000);
      expect(() => tracker.logSummary(longJobId)).not.toThrow();
    });

    it('should handle special characters in jobId', () => {
      tracker.record('gemini-2.0-flash', 'test', 100, 50);
      expect(() => tracker.logSummary('job-123-αβγ-🚀')).not.toThrow();
    });

    it('should not throw when logging with models that have no pricing', () => {
      tracker.record('unknown-future-model', 'test', 100, 50);
      expect(() => tracker.logSummary('test-job')).not.toThrow();
    });
  });

  describe('totals calculation edge cases', () => {
    it('should calculate totals correctly with mixed positive and negative values', () => {
      tracker.record('gemini-2.0-flash', 'test-1', 100, 50);
      tracker.record('gemini-2.0-flash', 'test-2', -20, 30);

      const { totals } = tracker.getSummary();
      expect(totals.promptTokens).toBe(80);
      expect(totals.candidatesTokens).toBe(80);
      expect(totals.totalTokens).toBe(160);
    });

    it('should handle totals when all entries are zero', () => {
      tracker.record('gemini-2.0-flash', 'test-1', 0, 0);
      tracker.record('gemini-2.5-flash', 'test-2', 0, 0);

      const { totals } = tracker.getSummary();
      expect(totals.promptTokens).toBe(0);
      expect(totals.candidatesTokens).toBe(0);
      expect(totals.totalTokens).toBe(0);
    });

    it('should accumulate totals across many different processor+model combinations', () => {
      const models = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-pro'];
      const processors = ['classify', 'audio', 'video', 'image', 'quality'];

      models.forEach(model => {
        processors.forEach(processor => {
          tracker.record(model, processor, 100, 50);
        });
      });

      const { entries, totals } = tracker.getSummary();
      expect(entries).toHaveLength(15); // 3 models × 5 processors
      expect(totals.promptTokens).toBe(1500); // 15 × 100
      expect(totals.candidatesTokens).toBe(750); // 15 × 50
      expect(totals.totalTokens).toBe(2250); // 15 × 150
    });
  });

  describe('key generation edge cases', () => {
    it('should create unique keys for processor:model combinations', () => {
      tracker.record('model-a', 'processor-a', 100, 50);
      tracker.record('model-b', 'processor-a', 200, 80);
      tracker.record('model-a', 'processor-b', 300, 120);

      const { entries } = tracker.getSummary();
      expect(entries).toHaveLength(3);
    });

    it('should handle colons in processor or model names', () => {
      // Edge case: what if processor/model name contains ':'?
      tracker.record('model:v2', 'processor:beta', 100, 50);
      tracker.record('model', 'v2:processor:beta', 200, 80);

      const { entries } = tracker.getSummary();
      // Should create separate entries even with confusing naming
      expect(entries).toHaveLength(2);
    });
  });
});

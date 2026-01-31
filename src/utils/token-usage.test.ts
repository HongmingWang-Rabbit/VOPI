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
});

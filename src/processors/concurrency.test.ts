/**
 * Processor Concurrency Tests
 */

import { describe, it, expect } from 'vitest';
import { PROCESSOR_CONCURRENCY, getConcurrency, MAX_CONCURRENCY } from './concurrency.js';

describe('PROCESSOR_CONCURRENCY', () => {
  it('should have all expected keys', () => {
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('CLAID_BG_REMOVE');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('STABILITY_INPAINT');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('SHARP_TRANSFORM');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('PHOTOROOM_GENERATE');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('FFMPEG_EXTRACT');
  });

  it('should have positive integer values', () => {
    for (const [key, value] of Object.entries(PROCESSOR_CONCURRENCY)) {
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
      expect(Number.isInteger(value), `${key} should be integer`).toBe(true);
    }
  });

  it('should have expected default values', () => {
    expect(PROCESSOR_CONCURRENCY.CLAID_BG_REMOVE).toBe(5);
    expect(PROCESSOR_CONCURRENCY.STABILITY_INPAINT).toBe(3);
    expect(PROCESSOR_CONCURRENCY.SHARP_TRANSFORM).toBe(8);
    expect(PROCESSOR_CONCURRENCY.PHOTOROOM_GENERATE).toBe(3);
    expect(PROCESSOR_CONCURRENCY.FFMPEG_EXTRACT).toBe(4);
  });
});

describe('getConcurrency', () => {
  it('should return default value when no options provided', () => {
    expect(getConcurrency('CLAID_BG_REMOVE')).toBe(5);
    expect(getConcurrency('STABILITY_INPAINT')).toBe(3);
    expect(getConcurrency('SHARP_TRANSFORM')).toBe(8);
  });

  it('should return default value when options is empty', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', {})).toBe(5);
  });

  it('should return default value when concurrency is not in options', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', { other: 'value' })).toBe(5);
  });

  it('should use override value when valid number provided', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: 10 })).toBe(10);
    expect(getConcurrency('STABILITY_INPAINT', { concurrency: 1 })).toBe(1);
  });

  it('should floor decimal concurrency values', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: 3.7 })).toBe(3);
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: 5.9 })).toBe(5);
  });

  it('should ignore non-positive concurrency values', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: 0 })).toBe(5);
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: -1 })).toBe(5);
  });

  it('should ignore non-number concurrency values', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: 'high' })).toBe(5);
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: null })).toBe(5);
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: undefined })).toBe(5);
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: {} })).toBe(5);
  });

  it('should cap concurrency at MAX_CONCURRENCY', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: 100 })).toBe(MAX_CONCURRENCY);
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: 1000 })).toBe(MAX_CONCURRENCY);
  });

  it('should allow values up to MAX_CONCURRENCY', () => {
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: MAX_CONCURRENCY })).toBe(MAX_CONCURRENCY);
    expect(getConcurrency('CLAID_BG_REMOVE', { concurrency: MAX_CONCURRENCY - 1 })).toBe(MAX_CONCURRENCY - 1);
  });
});

describe('MAX_CONCURRENCY', () => {
  it('should be a reasonable upper bound', () => {
    expect(MAX_CONCURRENCY).toBe(50);
    expect(MAX_CONCURRENCY).toBeGreaterThan(PROCESSOR_CONCURRENCY.SHARP_TRANSFORM);
  });
});

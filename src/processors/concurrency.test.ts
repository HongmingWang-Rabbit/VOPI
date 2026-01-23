/**
 * Processor Concurrency Tests
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PROCESSOR_CONCURRENCY, getConcurrency, MAX_CONCURRENCY, getEnvConcurrency } from './concurrency.js';

describe('PROCESSOR_CONCURRENCY', () => {
  it('should have all expected keys', () => {
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('CLAID_BG_REMOVE');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('STABILITY_INPAINT');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('SHARP_TRANSFORM');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('PHOTOROOM_GENERATE');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('FFMPEG_EXTRACT');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('GEMINI_CLASSIFY');
    expect(PROCESSOR_CONCURRENCY).toHaveProperty('S3_UPLOAD');
  });

  it('should have positive integer values', () => {
    for (const [key, value] of Object.entries(PROCESSOR_CONCURRENCY)) {
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
      expect(Number.isInteger(value), `${key} should be integer`).toBe(true);
    }
  });

  it('should have expected default values', () => {
    expect(PROCESSOR_CONCURRENCY.CLAID_BG_REMOVE).toBe(5);
    expect(PROCESSOR_CONCURRENCY.STABILITY_INPAINT).toBe(4);
    expect(PROCESSOR_CONCURRENCY.SHARP_TRANSFORM).toBe(8);
    expect(PROCESSOR_CONCURRENCY.PHOTOROOM_GENERATE).toBe(3);
    expect(PROCESSOR_CONCURRENCY.FFMPEG_EXTRACT).toBe(4);
    expect(PROCESSOR_CONCURRENCY.GEMINI_CLASSIFY).toBe(2);
    expect(PROCESSOR_CONCURRENCY.S3_UPLOAD).toBe(6);
  });
});

describe('getConcurrency', () => {
  it('should return default value when no options provided', () => {
    expect(getConcurrency('CLAID_BG_REMOVE')).toBe(5);
    expect(getConcurrency('STABILITY_INPAINT')).toBe(4);
    expect(getConcurrency('SHARP_TRANSFORM')).toBe(8);
    expect(getConcurrency('GEMINI_CLASSIFY')).toBe(2);
    expect(getConcurrency('S3_UPLOAD')).toBe(6);
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

describe('getEnvConcurrency', () => {
  const testKey = 'TEST_KEY';
  const envKey = `VOPI_CONCURRENCY_${testKey}`;

  afterEach(() => {
    delete process.env[envKey];
  });

  it('should return default value when env var is not set', () => {
    expect(getEnvConcurrency(testKey, 10)).toBe(10);
  });

  it('should return env var value when set to valid positive integer', () => {
    process.env[envKey] = '15';
    expect(getEnvConcurrency(testKey, 10)).toBe(15);
  });

  it('should return default value when env var is not a number', () => {
    process.env[envKey] = 'invalid';
    expect(getEnvConcurrency(testKey, 10)).toBe(10);
  });

  it('should return default value when env var is zero', () => {
    process.env[envKey] = '0';
    expect(getEnvConcurrency(testKey, 10)).toBe(10);
  });

  it('should return default value when env var is negative', () => {
    process.env[envKey] = '-5';
    expect(getEnvConcurrency(testKey, 10)).toBe(10);
  });

  it('should return default value when env var is empty string', () => {
    process.env[envKey] = '';
    expect(getEnvConcurrency(testKey, 10)).toBe(10);
  });

  it('should parse integer from decimal string', () => {
    process.env[envKey] = '7.9';
    // parseInt stops at decimal point
    expect(getEnvConcurrency(testKey, 10)).toBe(7);
  });
});

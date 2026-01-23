/**
 * Tests for Stability AI API utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before importing stability-api
vi.mock('../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  parseHexColor,
  isWithinSizeLimit,
  getFileSizeError,
  STABILITY_API_CONSTANTS,
  delay,
} from './stability-api.js';

describe('stability-api utilities', () => {
  describe('parseHexColor', () => {
    it('parses valid 6-digit hex with hash', () => {
      const result = parseHexColor('#FF5500');
      expect(result).toEqual({ r: 255, g: 85, b: 0, alpha: 1 });
    });

    it('parses valid 6-digit hex without hash', () => {
      const result = parseHexColor('00FF00');
      expect(result).toEqual({ r: 0, g: 255, b: 0, alpha: 1 });
    });

    it('parses lowercase hex', () => {
      const result = parseHexColor('#aabbcc');
      expect(result).toEqual({ r: 170, g: 187, b: 204, alpha: 1 });
    });

    it('parses white correctly', () => {
      const result = parseHexColor('#FFFFFF');
      expect(result).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    });

    it('parses black correctly', () => {
      const result = parseHexColor('#000000');
      expect(result).toEqual({ r: 0, g: 0, b: 0, alpha: 1 });
    });

    it('returns default white for empty string', () => {
      const result = parseHexColor('');
      expect(result).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    });

    it('returns default white for null/undefined', () => {
      const result1 = parseHexColor(null as unknown as string);
      const result2 = parseHexColor(undefined as unknown as string);
      expect(result1).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
      expect(result2).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    });

    it('returns default white for too short hex', () => {
      const result = parseHexColor('#FFF');
      expect(result).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    });

    it('returns default white for too long hex', () => {
      const result = parseHexColor('#FFFFFFFF');
      expect(result).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    });

    it('returns default white for invalid characters', () => {
      const result = parseHexColor('#GGGGGG');
      expect(result).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    });

    it('handles extra whitespace', () => {
      const result = parseHexColor('  #FF0000  ');
      expect(result).toEqual({ r: 255, g: 0, b: 0, alpha: 1 });
    });
  });

  describe('isWithinSizeLimit', () => {
    it('returns true for small files', () => {
      expect(isWithinSizeLimit(1024)).toBe(true);
      expect(isWithinSizeLimit(1024 * 1024)).toBe(true);
    });

    it('returns true for files at exactly the limit', () => {
      expect(isWithinSizeLimit(STABILITY_API_CONSTANTS.MAX_INPUT_SIZE_BYTES)).toBe(true);
    });

    it('returns false for files over the limit', () => {
      expect(isWithinSizeLimit(STABILITY_API_CONSTANTS.MAX_INPUT_SIZE_BYTES + 1)).toBe(false);
      expect(isWithinSizeLimit(20 * 1024 * 1024)).toBe(false);
    });

    it('returns true for zero bytes', () => {
      expect(isWithinSizeLimit(0)).toBe(true);
    });
  });

  describe('getFileSizeError', () => {
    it('returns formatted error message', () => {
      const error = getFileSizeError(15 * 1024 * 1024);
      expect(error).toContain('15.00MB');
      expect(error).toContain('10MB limit');
    });

    it('formats decimal sizes correctly', () => {
      const error = getFileSizeError(12.5 * 1024 * 1024);
      expect(error).toContain('12.50MB');
    });
  });

  describe('delay', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('delays for specified milliseconds', async () => {
      const promise = delay(1000);
      vi.advanceTimersByTime(999);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
      await promise;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('STABILITY_API_CONSTANTS', () => {
    it('has expected default values', () => {
      expect(STABILITY_API_CONSTANTS.MAX_RETRIES).toBe(3);
      expect(STABILITY_API_CONSTANTS.RETRY_DELAY_MS).toBe(2000);
      expect(STABILITY_API_CONSTANTS.POLLING_INTERVAL_MS).toBe(3000);
      expect(STABILITY_API_CONSTANTS.MAX_POLLING_ATTEMPTS).toBe(60);
      expect(STABILITY_API_CONSTANTS.MAX_INPUT_SIZE_BYTES).toBe(10 * 1024 * 1024);
    });
  });
});

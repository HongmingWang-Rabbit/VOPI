/**
 * Processor Constants Tests
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FRAME_OBSTRUCTIONS,
  DEFAULT_BACKGROUND_RECOMMENDATIONS,
  PROGRESS,
  DEFAULT_VIDEO_FILENAME,
  calculateProgress,
} from './constants.js';

describe('Processor Constants', () => {
  describe('DEFAULT_FRAME_OBSTRUCTIONS', () => {
    it('should have expected structure', () => {
      expect(DEFAULT_FRAME_OBSTRUCTIONS).toEqual({
        has_obstruction: false,
        obstruction_types: [],
        obstruction_description: null,
        removable_by_ai: true,
      });
    });

    it('should be immutable by convention', () => {
      // While not enforced at runtime, ensure structure is consistent
      expect(DEFAULT_FRAME_OBSTRUCTIONS.has_obstruction).toBe(false);
      expect(DEFAULT_FRAME_OBSTRUCTIONS.obstruction_types).toHaveLength(0);
    });
  });

  describe('DEFAULT_BACKGROUND_RECOMMENDATIONS', () => {
    it('should have expected structure', () => {
      expect(DEFAULT_BACKGROUND_RECOMMENDATIONS).toEqual({
        solid_color: '#FFFFFF',
        solid_color_name: 'white',
        real_life_setting: 'on a clean white surface',
        creative_shot: 'floating with soft shadow',
      });
    });

    it('should have valid hex color', () => {
      expect(DEFAULT_BACKGROUND_RECOMMENDATIONS.solid_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });

  describe('PROGRESS', () => {
    it('should have all expected stages', () => {
      expect(PROGRESS).toHaveProperty('DOWNLOAD');
      expect(PROGRESS).toHaveProperty('EXTRACT_FRAMES');
      expect(PROGRESS).toHaveProperty('SCORE_FRAMES');
      expect(PROGRESS).toHaveProperty('CLASSIFY');
      expect(PROGRESS).toHaveProperty('EXTRACT_PRODUCTS');
      expect(PROGRESS).toHaveProperty('UPLOAD_FRAMES');
      expect(PROGRESS).toHaveProperty('GENERATE_COMMERCIAL');
      expect(PROGRESS).toHaveProperty('COMPLETE');
    });

    it('should have START and END for most stages', () => {
      expect(PROGRESS.DOWNLOAD.START).toBeDefined();
      expect(PROGRESS.DOWNLOAD.END).toBeDefined();
      expect(PROGRESS.EXTRACT_FRAMES.START).toBeDefined();
      expect(PROGRESS.EXTRACT_FRAMES.END).toBeDefined();
      expect(PROGRESS.SCORE_FRAMES.START).toBeDefined();
      expect(PROGRESS.SCORE_FRAMES.END).toBeDefined();
    });

    it('should have progress values in increasing order', () => {
      expect(PROGRESS.DOWNLOAD.START).toBeLessThan(PROGRESS.DOWNLOAD.END);
      expect(PROGRESS.DOWNLOAD.END).toBeLessThanOrEqual(PROGRESS.EXTRACT_FRAMES.START);
      expect(PROGRESS.EXTRACT_FRAMES.END).toBeLessThanOrEqual(PROGRESS.SCORE_FRAMES.START);
      expect(PROGRESS.SCORE_FRAMES.END).toBeLessThanOrEqual(PROGRESS.CLASSIFY.START);
    });

    it('should end at 100', () => {
      expect(PROGRESS.COMPLETE.END).toBe(100);
    });

    it('should start above 0', () => {
      expect(PROGRESS.DOWNLOAD.START).toBeGreaterThan(0);
    });

    it('should have valid ranges (END > START)', () => {
      expect(PROGRESS.DOWNLOAD.END).toBeGreaterThan(PROGRESS.DOWNLOAD.START);
      expect(PROGRESS.EXTRACT_FRAMES.END).toBeGreaterThan(PROGRESS.EXTRACT_FRAMES.START);
      expect(PROGRESS.SCORE_FRAMES.END).toBeGreaterThan(PROGRESS.SCORE_FRAMES.START);
      expect(PROGRESS.CLASSIFY.END).toBeGreaterThan(PROGRESS.CLASSIFY.START);
    });
  });

  describe('DEFAULT_VIDEO_FILENAME', () => {
    it('should be a valid filename', () => {
      expect(DEFAULT_VIDEO_FILENAME).toBe('input.mp4');
    });

    it('should have mp4 extension', () => {
      expect(DEFAULT_VIDEO_FILENAME).toMatch(/\.mp4$/);
    });
  });

  describe('calculateProgress', () => {
    it('should calculate progress within range', () => {
      // At item 0 of 10 (first item), with range 0-100
      expect(calculateProgress(0, 10, 0, 100)).toBe(10); // (0+1)/10 * 100 = 10

      // At item 4 of 10 (5th item), with range 0-100
      expect(calculateProgress(4, 10, 0, 100)).toBe(50); // (4+1)/10 * 100 = 50

      // At item 9 of 10 (last item), with range 0-100
      expect(calculateProgress(9, 10, 0, 100)).toBe(100); // (9+1)/10 * 100 = 100
    });

    it('should handle custom start and end percentages', () => {
      // Range 30-45, at item 0 of 5
      expect(calculateProgress(0, 5, 30, 45)).toBe(33); // 30 + (1/5 * 15) = 33

      // Range 30-45, at item 4 of 5 (last)
      expect(calculateProgress(4, 5, 30, 45)).toBe(45); // 30 + (5/5 * 15) = 45
    });

    it('should return startPercent when total is 0', () => {
      expect(calculateProgress(0, 0, 30, 45)).toBe(30);
      expect(calculateProgress(5, 0, 50, 75)).toBe(50);
    });

    it('should handle single item', () => {
      expect(calculateProgress(0, 1, 0, 100)).toBe(100);
      expect(calculateProgress(0, 1, 30, 45)).toBe(45);
    });

    it('should round to nearest integer', () => {
      // 3 items, range 0-100: (1/3) * 100 = 33.33... → 33
      expect(calculateProgress(0, 3, 0, 100)).toBe(33);

      // 3 items, range 0-100: (2/3) * 100 = 66.66... → 67
      expect(calculateProgress(1, 3, 0, 100)).toBe(67);
    });

    it('should work with realistic pipeline progress values', () => {
      // Simulating SCORE_FRAMES progress (30-45 range)
      const start = PROGRESS.SCORE_FRAMES.START;
      const end = PROGRESS.SCORE_FRAMES.END;

      // First of 10 frames
      const first = calculateProgress(0, 10, start, end);
      expect(first).toBeGreaterThanOrEqual(start);
      expect(first).toBeLessThanOrEqual(end);

      // Last of 10 frames
      const last = calculateProgress(9, 10, start, end);
      expect(last).toBe(end);
    });
  });
});

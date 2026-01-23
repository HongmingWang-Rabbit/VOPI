/**
 * Frame Selection Tests
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('./logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import type { FrameMetadata } from '../processors/types.js';
import {
  selectBestAngles,
  getFrameScore,
  groupFramesByAngle,
  getUniqueAngles,
} from './frame-selection.js';

// Helper to create mock frame metadata
function createFrame(
  frameId: string,
  options: {
    score?: number;
    geminiScore?: number;
    angleEstimate?: string;
  } = {}
): FrameMetadata {
  return {
    frameId,
    filename: `${frameId}.jpg`,
    path: `/frames/${frameId}.jpg`,
    timestamp: 0,
    index: 0,
    score: options.score,
    geminiScore: options.geminiScore,
    angleEstimate: options.angleEstimate,
  };
}

describe('frame-selection', () => {
  describe('getFrameScore', () => {
    it('should prefer geminiScore over score', () => {
      const frame = createFrame('f1', { score: 50, geminiScore: 80 });
      expect(getFrameScore(frame)).toBe(80);
    });

    it('should fallback to score if geminiScore is undefined', () => {
      const frame = createFrame('f1', { score: 50 });
      expect(getFrameScore(frame)).toBe(50);
    });

    it('should return 0 if both scores are undefined', () => {
      const frame = createFrame('f1');
      expect(getFrameScore(frame)).toBe(0);
    });

    it('should handle zero scores correctly', () => {
      const frame = createFrame('f1', { score: 0, geminiScore: 0 });
      expect(getFrameScore(frame)).toBe(0);
    });
  });

  describe('groupFramesByAngle', () => {
    it('should group frames by angle estimate', () => {
      const frames = [
        createFrame('f1', { angleEstimate: 'front' }),
        createFrame('f2', { angleEstimate: 'back' }),
        createFrame('f3', { angleEstimate: 'front' }),
      ];

      const groups = groupFramesByAngle(frames);

      expect(groups.size).toBe(2);
      expect(groups.get('front')).toHaveLength(2);
      expect(groups.get('back')).toHaveLength(1);
    });

    it('should use "unknown" for frames without angle estimate', () => {
      const frames = [
        createFrame('f1', { angleEstimate: 'front' }),
        createFrame('f2'),
        createFrame('f3'),
      ];

      const groups = groupFramesByAngle(frames);

      expect(groups.size).toBe(2);
      expect(groups.get('front')).toHaveLength(1);
      expect(groups.get('unknown')).toHaveLength(2);
    });

    it('should return empty map for empty input', () => {
      const groups = groupFramesByAngle([]);
      expect(groups.size).toBe(0);
    });
  });

  describe('getUniqueAngles', () => {
    it('should return unique angles', () => {
      const frames = [
        createFrame('f1', { angleEstimate: 'front' }),
        createFrame('f2', { angleEstimate: 'back' }),
        createFrame('f3', { angleEstimate: 'front' }),
        createFrame('f4', { angleEstimate: 'side' }),
      ];

      const angles = getUniqueAngles(frames);

      expect(angles).toHaveLength(3);
      expect(angles).toContain('front');
      expect(angles).toContain('back');
      expect(angles).toContain('side');
    });

    it('should include "unknown" for frames without angle', () => {
      const frames = [
        createFrame('f1', { angleEstimate: 'front' }),
        createFrame('f2'),
      ];

      const angles = getUniqueAngles(frames);

      expect(angles).toHaveLength(2);
      expect(angles).toContain('front');
      expect(angles).toContain('unknown');
    });

    it('should return empty array for empty input', () => {
      expect(getUniqueAngles([])).toEqual([]);
    });
  });

  describe('selectBestAngles', () => {
    it('should return all frames if count is at or below maxAngles', () => {
      const frames = [
        createFrame('f1', { score: 80 }),
        createFrame('f2', { score: 60 }),
      ];

      const result = selectBestAngles(frames, 3);

      expect(result).toHaveLength(2);
    });

    it('should select best frame from each angle', () => {
      const frames = [
        createFrame('f1', { score: 90, angleEstimate: 'front' }),
        createFrame('f2', { score: 70, angleEstimate: 'front' }),
        createFrame('f3', { score: 80, angleEstimate: 'back' }),
        createFrame('f4', { score: 60, angleEstimate: 'back' }),
      ];

      const result = selectBestAngles(frames, 2);

      expect(result).toHaveLength(2);
      // Should select f1 (best front) and f3 (best back)
      expect(result.map(f => f.frameId)).toContain('f1');
      expect(result.map(f => f.frameId)).toContain('f3');
    });

    it('should prioritize angle diversity', () => {
      const frames = [
        createFrame('f1', { score: 100, angleEstimate: 'front' }),
        createFrame('f2', { score: 90, angleEstimate: 'back' }),
        createFrame('f3', { score: 80, angleEstimate: 'side' }),
        createFrame('f4', { score: 70, angleEstimate: 'front' }),
      ];

      const result = selectBestAngles(frames, 3);

      expect(result).toHaveLength(3);
      // Should have one from each angle
      const angles = result.map(f => f.angleEstimate);
      expect(angles).toContain('front');
      expect(angles).toContain('back');
      expect(angles).toContain('side');
    });

    it('should fill remaining slots with high-quality frames', () => {
      const frames = [
        createFrame('f1', { score: 100, angleEstimate: 'front' }),
        createFrame('f2', { score: 90, angleEstimate: 'front' }),
        createFrame('f3', { score: 80, angleEstimate: 'front' }),
      ];

      const result = selectBestAngles(frames, 2);

      expect(result).toHaveLength(2);
      // Should get f1 (first pick for angle) and f2 (highest remaining)
      expect(result.map(f => f.frameId)).toContain('f1');
      expect(result.map(f => f.frameId)).toContain('f2');
    });

    it('should prefer geminiScore over score when selecting', () => {
      const frames = [
        createFrame('f1', { score: 100, geminiScore: 50, angleEstimate: 'front' }),
        createFrame('f2', { score: 50, geminiScore: 100, angleEstimate: 'front' }),
      ];

      const result = selectBestAngles(frames, 1);

      expect(result).toHaveLength(1);
      // f2 has higher geminiScore, so should be selected
      expect(result[0].frameId).toBe('f2');
    });

    it('should handle all unknown angles', () => {
      const frames = [
        createFrame('f1', { score: 80 }),
        createFrame('f2', { score: 90 }),
        createFrame('f3', { score: 70 }),
      ];

      const result = selectBestAngles(frames, 2);

      expect(result).toHaveLength(2);
      // Should get f2 (highest) and f1 (second highest)
      expect(result.map(f => f.frameId)).toContain('f2');
      expect(result.map(f => f.frameId)).toContain('f1');
    });

    it('should handle empty input', () => {
      const result = selectBestAngles([], 4);
      expect(result).toEqual([]);
    });

    it('should handle maxAngles of 0', () => {
      const frames = [
        createFrame('f1', { score: 80 }),
        createFrame('f2', { score: 90 }),
      ];

      const result = selectBestAngles(frames, 0);
      expect(result).toHaveLength(0);
    });
  });
});

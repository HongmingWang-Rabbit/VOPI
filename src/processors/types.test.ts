/**
 * Types Tests
 *
 * Tests for type guards and frame metadata utilities.
 */

import { describe, it, expect } from 'vitest';
import { hasScores, hasClassificationData, hasClassifications } from './types.js';
import type { FrameMetadata } from './types.js';

describe('Type Guards', () => {
  describe('hasScores', () => {
    it('should return true for frames with complete score data', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        sharpness: 150.5,
        motion: 0.02,
        score: 145.5,
      };

      expect(hasScores(frame)).toBe(true);
    });

    it('should return false for frames missing sharpness', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        motion: 0.02,
        score: 145.5,
      };

      expect(hasScores(frame)).toBe(false);
    });

    it('should return false for frames missing motion', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        sharpness: 150.5,
        score: 145.5,
      };

      expect(hasScores(frame)).toBe(false);
    });

    it('should return false for frames missing score', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        sharpness: 150.5,
        motion: 0.02,
      };

      expect(hasScores(frame)).toBe(false);
    });

    it('should return false for base frames without any score data', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
      };

      expect(hasScores(frame)).toBe(false);
    });

    it('should handle zero values correctly', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 0,
        index: 0,
        sharpness: 0,
        motion: 0,
        score: 0,
      };

      expect(hasScores(frame)).toBe(true);
    });
  });

  describe('hasClassificationData', () => {
    it('should return true for frames with complete classification data', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        productId: 'product-123',
        variantId: 'variant-456',
      };

      expect(hasClassificationData(frame)).toBe(true);
    });

    it('should return true for frames with full classification data', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        productId: 'product-123',
        variantId: 'variant-456',
        angleEstimate: 'front',
        recommendedType: 'hero',
        variantDescription: 'Red variant',
        geminiScore: 0.95,
      };

      expect(hasClassificationData(frame)).toBe(true);
    });

    it('should return false for frames missing productId', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        variantId: 'variant-456',
      };

      expect(hasClassificationData(frame)).toBe(false);
    });

    it('should return false for frames missing variantId', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        productId: 'product-123',
      };

      expect(hasClassificationData(frame)).toBe(false);
    });

    it('should return false for base frames without classification data', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
      };

      expect(hasClassificationData(frame)).toBe(false);
    });

    it('should handle empty string values correctly', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        productId: '',
        variantId: '',
      };

      // Empty strings are still strings, so this should be true
      expect(hasClassificationData(frame)).toBe(true);
    });
  });

  describe('combined checks', () => {
    it('should identify frames with both scores and classifications', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        sharpness: 150.5,
        motion: 0.02,
        score: 145.5,
        productId: 'product-123',
        variantId: 'variant-456',
      };

      expect(hasScores(frame)).toBe(true);
      expect(hasClassificationData(frame)).toBe(true);
    });

    it('should correctly identify scored but not classified frames', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        sharpness: 150.5,
        motion: 0.02,
        score: 145.5,
      };

      expect(hasScores(frame)).toBe(true);
      expect(hasClassificationData(frame)).toBe(false);
    });

    it('should correctly identify classified but not scored frames', () => {
      const frame: FrameMetadata = {
        frameId: 'frame-1',
        filename: 'frame-001.jpg',
        path: '/tmp/frame-001.jpg',
        timestamp: 1.5,
        index: 0,
        productId: 'product-123',
        variantId: 'variant-456',
      };

      expect(hasScores(frame)).toBe(false);
      expect(hasClassificationData(frame)).toBe(true);
    });
  });

  describe('hasClassifications', () => {
    const baseFrame = (id: number): FrameMetadata => ({
      frameId: `frame-${id}`,
      filename: `frame-${id}.jpg`,
      path: `/tmp/frame-${id}.jpg`,
      timestamp: id,
      index: id - 1,
    });

    const classifiedFrame = (id: number): FrameMetadata => ({
      ...baseFrame(id),
      productId: `product-${id}`,
      variantId: `variant-${id}`,
    });

    it('should return true when at least one frame has classifications', () => {
      const frames = [baseFrame(1), classifiedFrame(2), baseFrame(3)];
      expect(hasClassifications(frames)).toBe(true);
    });

    it('should return true when all frames have classifications', () => {
      const frames = [classifiedFrame(1), classifiedFrame(2), classifiedFrame(3)];
      expect(hasClassifications(frames)).toBe(true);
    });

    it('should return false when no frames have classifications', () => {
      const frames = [baseFrame(1), baseFrame(2), baseFrame(3)];
      expect(hasClassifications(frames)).toBe(false);
    });

    it('should return false for empty array', () => {
      expect(hasClassifications([])).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(hasClassifications(undefined)).toBe(false);
    });

    it('should return true for single classified frame', () => {
      expect(hasClassifications([classifiedFrame(1)])).toBe(true);
    });

    it('should return false for single unclassified frame', () => {
      expect(hasClassifications([baseFrame(1)])).toBe(false);
    });

    it('should work with frames that have partial classification data', () => {
      const partialFrame: FrameMetadata = {
        ...baseFrame(1),
        productId: 'product-1',
        // missing variantId
      };
      expect(hasClassifications([partialFrame])).toBe(false);
    });
  });
});

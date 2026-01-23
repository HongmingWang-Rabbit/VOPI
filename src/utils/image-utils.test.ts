/**
 * Image Utils Tests
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

import { getImageMimeType, limitReferenceFrames, MAX_REFERENCE_FRAMES } from './image-utils.js';

describe('image-utils', () => {
  describe('getImageMimeType', () => {
    it('should return image/png for .png files', () => {
      expect(getImageMimeType('/path/to/image.png')).toBe('image/png');
      expect(getImageMimeType('/path/to/image.PNG')).toBe('image/png');
    });

    it('should return image/jpeg for .jpg files', () => {
      expect(getImageMimeType('/path/to/image.jpg')).toBe('image/jpeg');
      expect(getImageMimeType('/path/to/image.JPG')).toBe('image/jpeg');
    });

    it('should return image/jpeg for .jpeg files', () => {
      expect(getImageMimeType('/path/to/image.jpeg')).toBe('image/jpeg');
      expect(getImageMimeType('/path/to/image.JPEG')).toBe('image/jpeg');
    });

    it('should return image/webp for .webp files', () => {
      expect(getImageMimeType('/path/to/image.webp')).toBe('image/webp');
      expect(getImageMimeType('/path/to/image.WEBP')).toBe('image/webp');
    });

    it('should return image/jpeg for unknown extensions with warning', () => {
      expect(getImageMimeType('/path/to/image.gif')).toBe('image/jpeg');
      expect(getImageMimeType('/path/to/image.bmp')).toBe('image/jpeg');
      expect(getImageMimeType('/path/to/image.tiff')).toBe('image/jpeg');
    });

    it('should handle files without extensions', () => {
      expect(getImageMimeType('/path/to/image')).toBe('image/jpeg');
    });

    it('should handle paths with multiple dots', () => {
      expect(getImageMimeType('/path/to/my.image.file.png')).toBe('image/png');
      expect(getImageMimeType('/path.with.dots/image.jpg')).toBe('image/jpeg');
    });
  });

  describe('limitReferenceFrames', () => {
    it('should return all frames if count is at or below max', () => {
      const paths = ['/a.jpg', '/b.jpg', '/c.jpg'];
      expect(limitReferenceFrames(paths, 4)).toEqual(paths);
      expect(limitReferenceFrames(paths, 3)).toEqual(paths);
    });

    it('should limit frames to specified max', () => {
      const paths = ['/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg', '/5.jpg', '/6.jpg'];
      const result = limitReferenceFrames(paths, 3);
      expect(result).toHaveLength(3);
    });

    it('should select evenly distributed frames', () => {
      const paths = ['/0.jpg', '/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg', '/5.jpg'];
      const result = limitReferenceFrames(paths, 2);
      // With 6 items and max 2, step is 3
      // i=0: index 0 -> '/0.jpg'
      // i=1: index 3 -> '/3.jpg'
      expect(result).toEqual(['/0.jpg', '/3.jpg']);
    });

    it('should use MAX_REFERENCE_FRAMES as default', () => {
      const paths = Array.from({ length: 10 }, (_, i) => `/${i}.jpg`);
      const result = limitReferenceFrames(paths);
      expect(result).toHaveLength(MAX_REFERENCE_FRAMES);
    });

    it('should handle empty array', () => {
      expect(limitReferenceFrames([])).toEqual([]);
      expect(limitReferenceFrames([], 4)).toEqual([]);
    });

    it('should handle single element array', () => {
      const paths = ['/only.jpg'];
      expect(limitReferenceFrames(paths, 4)).toEqual(paths);
    });
  });

  describe('MAX_REFERENCE_FRAMES', () => {
    it('should be 4', () => {
      expect(MAX_REFERENCE_FRAMES).toBe(4);
    });
  });
});

/**
 * Center Product Processor Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('../../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock the Sharp provider
vi.mock('../../../providers/implementations/index.js', () => ({
  sharpImageTransformProvider: {
    findContentBounds: vi.fn(),
    crop: vi.fn(),
    centerOnCanvas: vi.fn(),
  },
}));

import { centerProductProcessor } from './center-product.js';
import { sharpImageTransformProvider } from '../../../providers/implementations/index.js';
import type { ProcessorContext, PipelineData, FrameMetadata } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';

describe('centerProductProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(centerProductProcessor.id).toBe('center-product');
    });

    it('should have correct displayName', () => {
      expect(centerProductProcessor.displayName).toBe('Center Product');
    });

    it('should require images and frames input', () => {
      expect(centerProductProcessor.io.requires).toContain('images');
      expect(centerProductProcessor.io.requires).toContain('frames');
    });

    it('should produce images output', () => {
      expect(centerProductProcessor.io.produces).toContain('images');
    });
  });

  describe('execute', () => {
    let mockContext: ProcessorContext;
    let mockTimer: PipelineTimer;

    beforeEach(() => {
      mockTimer = {
        timeOperation: vi.fn().mockImplementation(async (_name, fn) => fn()),
        getMetrics: vi.fn(),
        reset: vi.fn(),
      } as unknown as PipelineTimer;

      mockContext = {
        job: { id: 'test-job-123' } as ProcessorContext['job'],
        jobId: 'test-job-123',
        config: {} as ProcessorContext['config'],
        workDirs: {
          root: '/tmp/test-job',
          video: '/tmp/test-job/video',
          frames: '/tmp/test-job/frames',
          candidates: '/tmp/test-job/candidates',
          extracted: '/tmp/test-job/extracted',
          final: '/tmp/test-job/final',
          commercial: '/tmp/test-job/commercial',
        },
        onProgress: vi.fn(),
        effectiveConfig: {} as ProcessorContext['effectiveConfig'],
        timer: mockTimer,
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return error when no frames provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames to center');
    });

    it('should return error when frames array is empty', async () => {
      const data: PipelineData = {
        metadata: { frames: [] },
      };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames to center');
    });

    it('should keep original frame when no content bounds found', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockResolvedValue(null);

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/frame1.png');
    });

    it('should center frame successfully', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockResolvedValue({
        x: 100,
        y: 100,
        width: 500,
        height: 400,
      });
      vi.mocked(sharpImageTransformProvider.crop).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('cropped'),
      });
      vi.mocked(sharpImageTransformProvider.centerOnCanvas).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('centered'),
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/test-job/extracted/frame_001_centered.png');
    });

    it('should keep original frame when crop fails', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockResolvedValue({
        x: 100,
        y: 100,
        width: 500,
        height: 400,
      });
      vi.mocked(sharpImageTransformProvider.crop).mockResolvedValue({
        success: false,
        error: 'Crop failed',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/frame1.png');
    });

    it('should keep original frame when centerOnCanvas fails', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockResolvedValue({
        x: 100,
        y: 100,
        width: 500,
        height: 400,
      });
      vi.mocked(sharpImageTransformProvider.crop).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('cropped'),
      });
      vi.mocked(sharpImageTransformProvider.centerOnCanvas).mockResolvedValue({
        success: false,
        error: 'Center failed',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/frame1.png');
    });

    it('should process multiple frames in parallel', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockResolvedValue({
        x: 100,
        y: 100,
        width: 500,
        height: 400,
      });
      vi.mocked(sharpImageTransformProvider.crop).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('cropped'),
      });
      vi.mocked(sharpImageTransformProvider.centerOnCanvas).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('centered'),
      });

      const frames: FrameMetadata[] = Array.from({ length: 5 }, (_, i) => ({
        frameId: `frame_${String(i + 1).padStart(3, '0')}`,
        path: `/tmp/frame${i + 1}.png`,
        index: i + 1,
        timestamp: i,
        filename: `frame${i + 1}.png`,
      }));

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames).toHaveLength(5);
      expect(sharpImageTransformProvider.findContentBounds).toHaveBeenCalledTimes(5);
    });

    it('should use custom padding option', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockResolvedValue({
        x: 100,
        y: 100,
        width: 500,
        height: 400,
      });
      vi.mocked(sharpImageTransformProvider.crop).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('cropped'),
      });
      vi.mocked(sharpImageTransformProvider.centerOnCanvas).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('centered'),
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await centerProductProcessor.execute(mockContext, data, { padding: 0.1 });

      expect(sharpImageTransformProvider.centerOnCanvas).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ padding: 0.1 })
      );
    });

    it('should handle errors gracefully and keep original frame', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockRejectedValue(new Error('Sharp error'));

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await centerProductProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/frame1.png');
    });

    it('should call onProgress during processing', async () => {
      vi.mocked(sharpImageTransformProvider.findContentBounds).mockResolvedValue(null);

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await centerProductProcessor.execute(mockContext, data);

      expect(mockContext.onProgress).toHaveBeenCalled();
    });
  });
});

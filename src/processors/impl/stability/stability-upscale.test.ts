/**
 * Stability Upscale Processor Tests
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

// Mock the Stability provider
vi.mock('../../../providers/implementations/index.js', () => ({
  stabilityUpscaleProvider: {
    isAvailable: vi.fn(),
    upscale: vi.fn(),
  },
}));

// Mock parallel utility
vi.mock('../../../utils/parallel.js', () => ({
  parallelMap: vi.fn().mockImplementation(async (items, fn) => ({
    results: await Promise.all(items.map(fn)),
  })),
  isParallelError: vi.fn().mockReturnValue(false),
}));

// Mock concurrency
vi.mock('../../concurrency.js', () => ({
  getConcurrency: vi.fn().mockReturnValue(2),
}));

import { stabilityUpscaleProcessor } from './stability-upscale.js';
import { stabilityUpscaleProvider } from '../../../providers/implementations/index.js';
import type { ProcessorContext, PipelineData, FrameMetadata } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';

describe('stabilityUpscaleProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(stabilityUpscaleProcessor.id).toBe('stability-upscale');
    });

    it('should have correct displayName', () => {
      expect(stabilityUpscaleProcessor.displayName).toBe('Upscale Image');
    });

    it('should require images and frames input', () => {
      expect(stabilityUpscaleProcessor.io.requires).toContain('images');
      expect(stabilityUpscaleProcessor.io.requires).toContain('frames');
    });

    it('should produce images output', () => {
      expect(stabilityUpscaleProcessor.io.produces).toContain('images');
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

      vi.mocked(stabilityUpscaleProvider.isAvailable).mockReturnValue(true);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return error when no frames provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await stabilityUpscaleProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames to upscale');
    });

    it('should return error when frames array is empty', async () => {
      const data: PipelineData = {
        metadata: { frames: [] },
      };

      const result = await stabilityUpscaleProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames to upscale');
    });

    it('should skip upscale when provider not available', async () => {
      vi.mocked(stabilityUpscaleProvider.isAvailable).mockReturnValue(false);

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityUpscaleProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/frame1.png');
      expect(stabilityUpscaleProvider.upscale).not.toHaveBeenCalled();
    });

    it('should upscale frames successfully', async () => {
      vi.mocked(stabilityUpscaleProvider.upscale).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_001_upscaled.png',
        size: 1024,
        method: 'stability-conservative-upscale',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityUpscaleProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/test-job/extracted/frame_001_upscaled.png');
    });

    it('should keep original frame when upscale fails', async () => {
      vi.mocked(stabilityUpscaleProvider.upscale).mockResolvedValue({
        success: false,
        error: 'Upscale failed',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityUpscaleProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/frame1.png');
    });

    it('should handle exceptions and keep original frame', async () => {
      vi.mocked(stabilityUpscaleProvider.upscale).mockRejectedValue(new Error('API error'));

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityUpscaleProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/frame1.png');
    });

    it('should pass creativity option to provider', async () => {
      vi.mocked(stabilityUpscaleProvider.upscale).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_001_upscaled.png',
        size: 1024,
        method: 'stability-creative-upscale',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await stabilityUpscaleProcessor.execute(mockContext, data, { creativity: 0.7 });

      expect(stabilityUpscaleProvider.upscale).toHaveBeenCalledWith(
        '/tmp/frame1.png',
        expect.any(String),
        expect.objectContaining({ creativity: 0.7 })
      );
    });

    it('should call onProgress during processing', async () => {
      vi.mocked(stabilityUpscaleProvider.upscale).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_001_upscaled.png',
        size: 1024,
        method: 'stability-conservative-upscale',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await stabilityUpscaleProcessor.execute(mockContext, data);

      expect(mockContext.onProgress).toHaveBeenCalled();
    });
  });
});

/**
 * Stability AI Background Removal Processor Tests
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
vi.mock('../../../providers/implementations/stability-background-removal.provider.js', () => ({
  stabilityBackgroundRemovalProvider: {
    isAvailable: vi.fn(),
    removeBackground: vi.fn(),
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

import { stabilityBgRemoveProcessor } from './stability-bg-remove.js';
import { stabilityBackgroundRemovalProvider } from '../../../providers/implementations/stability-background-removal.provider.js';
import type { ProcessorContext, PipelineData, FrameMetadata } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';

describe('stabilityBgRemoveProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(stabilityBgRemoveProcessor.id).toBe('stability-bg-remove');
    });

    it('should have correct displayName', () => {
      expect(stabilityBgRemoveProcessor.displayName).toBe('Remove Background (Stability AI)');
    });

    it('should require images and frames input', () => {
      expect(stabilityBgRemoveProcessor.io.requires).toContain('images');
      expect(stabilityBgRemoveProcessor.io.requires).toContain('frames');
    });

    it('should produce images output', () => {
      expect(stabilityBgRemoveProcessor.io.produces).toContain('images');
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

      vi.mocked(stabilityBackgroundRemovalProvider.isAvailable).mockReturnValue(true);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return error when no frames provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for background removal');
    });

    it('should return error when frames array is empty', async () => {
      const data: PipelineData = {
        metadata: { frames: [] },
      };

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for background removal');
    });

    it('should skip processing when provider not available', async () => {
      vi.mocked(stabilityBackgroundRemovalProvider.isAvailable).mockReturnValue(false);

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
      expect(stabilityBackgroundRemovalProvider.removeBackground).not.toHaveBeenCalled();
    });

    it('should remove background successfully', async () => {
      vi.mocked(stabilityBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_001_transparent.png',
        size: 1024,
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/test-job/extracted/frame_001_transparent.png');
    });

    it('should keep original frame when removal fails but return success', async () => {
      vi.mocked(stabilityBackgroundRemovalProvider.removeBackground)
        .mockResolvedValueOnce({
          success: true,
          outputPath: '/tmp/test-job/extracted/frame_001_transparent.png',
          size: 1024,
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'API error',
        });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
        { frameId: 'frame_002', path: '/tmp/frame2.png', index: 2, timestamp: 1, filename: 'frame2.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/test-job/extracted/frame_001_transparent.png');
      expect(result.data?.metadata?.frames?.[1].path).toBe('/tmp/frame2.png'); // Original path kept
    });

    it('should return error when all frames fail', async () => {
      vi.mocked(stabilityBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Stability background removal failed');
    });

    it('should process multiple frames in parallel', async () => {
      vi.mocked(stabilityBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_transparent.png',
        size: 1024,
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

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames).toHaveLength(5);
      expect(stabilityBackgroundRemovalProvider.removeBackground).toHaveBeenCalledTimes(5);
    });

    it('should call onProgress during processing', async () => {
      vi.mocked(stabilityBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_001_transparent.png',
        size: 1024,
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(mockContext.onProgress).toHaveBeenCalled();
    });

    it('should include extraction results in output', async () => {
      vi.mocked(stabilityBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_001_transparent.png',
        size: 1024,
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.extractionResults).toBeDefined();
      expect(result.data?.extractionResults?.get('frame_001')).toBeDefined();
    });
  });
});

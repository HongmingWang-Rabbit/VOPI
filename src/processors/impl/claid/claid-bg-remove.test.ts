/**
 * Claid Background Removal Processor Tests
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

// Mock the Claid provider
vi.mock('../../../providers/implementations/index.js', () => ({
  claidBackgroundRemovalProvider: {
    isAvailable: vi.fn(),
    removeBackground: vi.fn(),
  },
}));

import { claidBgRemoveProcessor } from './claid-bg-remove.js';
import { claidBackgroundRemovalProvider } from '../../../providers/implementations/index.js';
import type { ProcessorContext, PipelineData, FrameMetadata } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';

describe('claidBgRemoveProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(claidBgRemoveProcessor.id).toBe('claid-bg-remove');
    });

    it('should have correct displayName', () => {
      expect(claidBgRemoveProcessor.displayName).toBe('Remove Background (Claid)');
    });

    it('should require images and frames input', () => {
      expect(claidBgRemoveProcessor.io.requires).toContain('images');
      expect(claidBgRemoveProcessor.io.requires).toContain('frames');
    });

    it('should produce images output', () => {
      expect(claidBgRemoveProcessor.io.produces).toContain('images');
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

      const result = await claidBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for background removal');
    });

    it('should return error when frames array is empty', async () => {
      const data: PipelineData = {
        metadata: { frames: [] },
      };

      const result = await claidBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for background removal');
    });

    it('should skip processing when Claid provider is not available', async () => {
      vi.mocked(claidBackgroundRemovalProvider.isAvailable).mockReturnValue(false);

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await claidBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
      expect(claidBackgroundRemovalProvider.removeBackground).not.toHaveBeenCalled();
    });

    it('should process frames successfully', async () => {
      vi.mocked(claidBackgroundRemovalProvider.isAvailable).mockReturnValue(true);
      vi.mocked(claidBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/extracted/frame_001_transparent.png',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await claidBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.frames).toHaveLength(1);
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/test-job/extracted/frame_001_transparent.png');
    });

    it('should handle partial failures gracefully', async () => {
      vi.mocked(claidBackgroundRemovalProvider.isAvailable).mockReturnValue(true);
      vi.mocked(claidBackgroundRemovalProvider.removeBackground)
        .mockResolvedValueOnce({ success: true, outputPath: '/tmp/test-job/extracted/frame_001_transparent.png' })
        .mockResolvedValueOnce({ success: false, error: 'API error' });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
        { frameId: 'frame_002', path: '/tmp/frame2.png', index: 2, timestamp: 1, filename: 'frame2.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await claidBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      // First frame should have new path, second should keep original
      expect(result.data?.metadata?.frames?.[0].path).toBe('/tmp/test-job/extracted/frame_001_transparent.png');
      expect(result.data?.metadata?.frames?.[1].path).toBe('/tmp/frame2.png');
    });

    it('should fail when all frames fail', async () => {
      vi.mocked(claidBackgroundRemovalProvider.isAvailable).mockReturnValue(true);
      vi.mocked(claidBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await claidBgRemoveProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Claid background removal failed');
    });

    it('should use custom prompt from options', async () => {
      vi.mocked(claidBackgroundRemovalProvider.isAvailable).mockReturnValue(true);
      vi.mocked(claidBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/extracted/frame_001_transparent.png',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await claidBgRemoveProcessor.execute(mockContext, data, { customPrompt: 'shoes' });

      expect(claidBackgroundRemovalProvider.removeBackground).toHaveBeenCalledWith(
        '/tmp/frame1.png',
        expect.any(String),
        { customPrompt: 'shoes' }
      );
    });

    it('should respect custom concurrency option', async () => {
      vi.mocked(claidBackgroundRemovalProvider.isAvailable).mockReturnValue(true);
      vi.mocked(claidBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/extracted/frame_001_transparent.png',
      });

      const frames: FrameMetadata[] = Array.from({ length: 10 }, (_, i) => ({
        frameId: `frame_${String(i + 1).padStart(3, '0')}`,
        path: `/tmp/frame${i + 1}.png`,
        index: i + 1,
        timestamp: i,
        filename: `frame${i + 1}.png`,
      }));

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await claidBgRemoveProcessor.execute(mockContext, data, { concurrency: 2 });

      expect(result.success).toBe(true);
      expect(claidBackgroundRemovalProvider.removeBackground).toHaveBeenCalledTimes(10);
    });

    it('should call onProgress during processing', async () => {
      vi.mocked(claidBackgroundRemovalProvider.isAvailable).mockReturnValue(true);
      vi.mocked(claidBackgroundRemovalProvider.removeBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/extracted/frame_001_transparent.png',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await claidBgRemoveProcessor.execute(mockContext, data);

      expect(mockContext.onProgress).toHaveBeenCalled();
    });
  });
});

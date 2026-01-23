/**
 * Stability Commercial Image Processor Tests
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
vi.mock('../../../providers/implementations/stability-commercial.provider.js', () => ({
  stabilityCommercialProvider: {
    isAvailable: vi.fn(),
    generateWithAIBackground: vi.fn(),
    generateWithSolidBackground: vi.fn(),
  },
}));

// Mock storage service
vi.mock('../../../services/storage.service.js', () => ({
  storageService: {
    getJobKey: vi.fn().mockReturnValue('jobs/test-job/commercial/test.png'),
    uploadFile: vi.fn().mockResolvedValue({ url: 'https://s3.example.com/test.png' }),
  },
}));

// Mock database
vi.mock('../../../db/index.js', () => ({
  getDatabase: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  schema: {
    commercialImages: {},
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

import { stabilityCommercialProcessor, ALL_COMMERCIAL_VERSIONS } from './stability-commercial.js';
import { stabilityCommercialProvider } from '../../../providers/implementations/stability-commercial.provider.js';
import type { ProcessorContext, PipelineData, FrameMetadata } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';

describe('stabilityCommercialProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(stabilityCommercialProcessor.id).toBe('stability-commercial');
    });

    it('should have correct displayName', () => {
      expect(stabilityCommercialProcessor.displayName).toBe('Generate Commercial Images (Stability)');
    });

    it('should require images and frames input', () => {
      expect(stabilityCommercialProcessor.io.requires).toContain('images');
      expect(stabilityCommercialProcessor.io.requires).toContain('frames');
    });

    it('should produce images output', () => {
      expect(stabilityCommercialProcessor.io.produces).toContain('images');
    });
  });

  describe('ALL_COMMERCIAL_VERSIONS', () => {
    it('should contain all expected versions', () => {
      expect(ALL_COMMERCIAL_VERSIONS).toContain('transparent');
      expect(ALL_COMMERCIAL_VERSIONS).toContain('solid');
      expect(ALL_COMMERCIAL_VERSIONS).toContain('real');
      expect(ALL_COMMERCIAL_VERSIONS).toContain('creative');
      expect(ALL_COMMERCIAL_VERSIONS).toHaveLength(4);
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
        config: {
          commercialVersions: ['transparent'],
        } as ProcessorContext['config'],
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

      vi.mocked(stabilityCommercialProvider.isAvailable).mockReturnValue(true);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return error when no frames provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await stabilityCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for commercial generation');
    });

    it('should return error when frames array is empty', async () => {
      const data: PipelineData = {
        metadata: { frames: [] },
      };

      const result = await stabilityCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for commercial generation');
    });

    it('should skip generation when provider not available', async () => {
      vi.mocked(stabilityCommercialProvider.isAvailable).mockReturnValue(false);

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(stabilityCommercialProvider.generateWithAIBackground).not.toHaveBeenCalled();
    });

    it('should generate transparent version by uploading existing image', async () => {
      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityCommercialProcessor.execute(mockContext, data, { versions: ['transparent'] });

      expect(result.success).toBe(true);
      expect(result.data?.commercialImages).toBeDefined();
      expect(result.data?.commercialImages?.some((c: { version: string }) => c.version === 'transparent')).toBe(true);
    });

    it('should generate solid background using provider', async () => {
      vi.mocked(stabilityCommercialProvider.generateWithSolidBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/commercial/frame_001_solid.png',
        size: 1024,
        method: 'solid-background',
        bgColor: '#FFFFFF',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityCommercialProcessor.execute(mockContext, data, { versions: ['solid'] });

      expect(result.success).toBe(true);
      expect(stabilityCommercialProvider.generateWithSolidBackground).toHaveBeenCalled();
    });

    it('should generate real background using AI provider', async () => {
      vi.mocked(stabilityCommercialProvider.generateWithAIBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/commercial/frame_001_real.png',
        size: 1024,
        method: 'stability-replace-bg-relight',
        bgPrompt: 'on a clean white surface',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityCommercialProcessor.execute(mockContext, data, { versions: ['real'] });

      expect(result.success).toBe(true);
      expect(stabilityCommercialProvider.generateWithAIBackground).toHaveBeenCalled();
    });

    it('should handle generation failures gracefully', async () => {
      vi.mocked(stabilityCommercialProvider.generateWithAIBackground).mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await stabilityCommercialProcessor.execute(mockContext, data, { versions: ['real'] });

      expect(result.success).toBe(true);
      expect(result.data?.commercialImages?.some((c: { success: boolean }) => !c.success)).toBe(true);
    });

    it('should call onProgress during processing', async () => {
      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await stabilityCommercialProcessor.execute(mockContext, data, { versions: ['transparent'] });

      expect(mockContext.onProgress).toHaveBeenCalled();
    });

    it('should use versions from config when not specified in options', async () => {
      mockContext.config.commercialVersions = ['transparent', 'solid'];

      const frames: FrameMetadata[] = [
        { frameId: 'frame_001', path: '/tmp/frame1.png', index: 1, timestamp: 0, filename: 'frame1.png' },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      vi.mocked(stabilityCommercialProvider.generateWithSolidBackground).mockResolvedValue({
        success: true,
        outputPath: '/tmp/test-job/commercial/frame_001_solid.png',
        size: 1024,
        method: 'solid-background',
        bgColor: '#FFFFFF',
      });

      const result = await stabilityCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      // Should process both transparent and solid
      expect(stabilityCommercialProvider.generateWithSolidBackground).toHaveBeenCalled();
    });
  });
});

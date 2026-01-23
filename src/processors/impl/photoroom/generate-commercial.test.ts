/**
 * Generate Commercial Processor Tests
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

// Mock photoroom service
vi.mock('../../../services/photoroom.service.js', () => ({
  photoroomService: {
    generateAllVersions: vi.fn(),
  },
}));

// Mock storage service
vi.mock('../../../services/storage.service.js', () => ({
  storageService: {
    getJobKey: vi.fn().mockReturnValue('jobs/test-job/commercial/image.png'),
    uploadFile: vi.fn().mockResolvedValue({ url: 'https://s3.example.com/image.png' }),
  },
}));

// Mock database
vi.mock('../../../db/index.js', () => ({
  getDatabase: vi.fn(() => ({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  })),
  schema: {
    commercialImages: {},
  },
}));

import { generateCommercialProcessor } from './generate-commercial.js';
import { photoroomService } from '../../../services/photoroom.service.js';
import type { ProcessorContext, PipelineData, FrameMetadata } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';

describe('generateCommercialProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(generateCommercialProcessor.id).toBe('generate-commercial');
    });

    it('should have correct displayName', () => {
      expect(generateCommercialProcessor.displayName).toBe('Generate Commercial Images');
    });

    it('should require images and frames input', () => {
      expect(generateCommercialProcessor.io.requires).toContain('images');
      expect(generateCommercialProcessor.io.requires).toContain('frames');
    });

    it('should produce images output', () => {
      expect(generateCommercialProcessor.io.produces).toContain('images');
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
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return error when no frames provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await generateCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for commercial generation');
    });

    it('should return error when frames array is empty', async () => {
      const data: PipelineData = {
        metadata: { frames: [] },
      };

      const result = await generateCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No frames for commercial generation');
    });

    it('should generate commercial images successfully', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'front',
        versions: {
          transparent: {
            success: true,
            outputPath: '/tmp/commercial/frame_001_transparent.png',
          },
        },
      });

      const frames: FrameMetadata[] = [
        {
          frameId: 'frame_001',
          path: '/tmp/frame1.png',
          index: 1,
          timestamp: 0,
          filename: 'frame1.png',
          recommendedType: 'front',
        },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await generateCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.commercialImages).toBeDefined();
      expect(result.data?.metadata?.commercialGenerationStats).toBeDefined();
    });

    it('should handle generation failures gracefully', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'frame_001',
        versions: {
          transparent: {
            success: false,
            error: 'API error',
          },
        },
      });

      const frames: FrameMetadata[] = [
        {
          frameId: 'frame_001',
          path: '/tmp/frame1.png',
          index: 1,
          timestamp: 0,
          filename: 'frame1.png',
        },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await generateCommercialProcessor.execute(mockContext, data);

      // Should still succeed but report errors in stats
      expect(result.success).toBe(true);
      expect(result.data?.metadata?.commercialGenerationStats?.totalErrors).toBeGreaterThan(0);
    });

    it('should process multiple frames', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'variant_1',
        versions: {
          transparent: {
            success: true,
            outputPath: '/tmp/commercial/frame_transparent.png',
          },
        },
      });

      const frames: FrameMetadata[] = Array.from({ length: 3 }, (_, i) => ({
        frameId: `frame_${String(i + 1).padStart(3, '0')}`,
        path: `/tmp/frame${i + 1}.png`,
        index: i + 1,
        timestamp: i,
        filename: `frame${i + 1}.png`,
        recommendedType: `variant_${i + 1}`,
      }));

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await generateCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(photoroomService.generateAllVersions).toHaveBeenCalledTimes(3);
    });

    it('should use versions from options', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'frame_001',
        versions: {
          solid: {
            success: true,
            outputPath: '/tmp/commercial/frame_solid.png',
            bgColor: '#ffffff',
          },
        },
      });

      const frames: FrameMetadata[] = [
        {
          frameId: 'frame_001',
          path: '/tmp/frame1.png',
          index: 1,
          timestamp: 0,
          filename: 'frame1.png',
        },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await generateCommercialProcessor.execute(mockContext, data, { versions: ['solid'] });

      expect(photoroomService.generateAllVersions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({ versions: ['solid'] })
      );
    });

    it('should call onProgress during processing', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'frame_001',
        versions: {},
      });

      const frames: FrameMetadata[] = [
        {
          frameId: 'frame_001',
          path: '/tmp/frame1.png',
          index: 1,
          timestamp: 0,
          filename: 'frame1.png',
        },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      await generateCommercialProcessor.execute(mockContext, data);

      expect(mockContext.onProgress).toHaveBeenCalled();
    });

    it('should handle thrown errors gracefully', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockRejectedValue(new Error('Network error'));

      const frames: FrameMetadata[] = [
        {
          frameId: 'frame_001',
          path: '/tmp/frame1.png',
          index: 1,
          timestamp: 0,
          filename: 'frame1.png',
        },
      ];

      const data: PipelineData = {
        metadata: { frames },
      };

      const result = await generateCommercialProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.commercialImages?.[0]?.success).toBe(false);
      expect(result.data?.commercialImages?.[0]?.error).toBe('Network error');
    });

    it('should use pre-extracted transparent source when available', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'frame_001',
        versions: {},
      });

      const frames: FrameMetadata[] = [
        {
          frameId: 'frame_001',
          path: '/tmp/frame1.png',
          index: 1,
          timestamp: 0,
          filename: 'frame1.png',
        },
      ];

      const extractionResults = new Map([
        ['frame_001', { success: true, outputPath: '/tmp/extracted/frame_001_transparent.png', rotationApplied: 0 }],
      ]);

      const data: PipelineData = {
        metadata: { frames },
        extractionResults,
      };

      await generateCommercialProcessor.execute(mockContext, data);

      expect(photoroomService.generateAllVersions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({
          transparentSource: '/tmp/extracted/frame_001_transparent.png',
          skipTransparent: true,
        })
      );
    });
  });
});

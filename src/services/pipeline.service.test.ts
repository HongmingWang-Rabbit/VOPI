import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineService } from './pipeline.service.js';
import type { Job } from '../db/schema.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// Mock database
const mockDb = {
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn(),
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn(() => mockDb),
  schema: {
    jobs: { id: 'id', status: 'status' },
    videos: { id: 'id' },
    frames: { id: 'id' },
    commercialImages: { id: 'id' },
  },
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    worker: {
      tempDirName: 'vopi-test',
    },
    storage: {
      bucket: 'test-bucket',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
    },
  })),
}));

// Mock storageService
vi.mock('./storage.service.js', () => ({
  storageService: {
    downloadFromUrl: vi.fn().mockResolvedValue(undefined),
    getJobKey: vi.fn().mockReturnValue('jobs/job-123/frames/frame.png'),
    uploadFile: vi.fn().mockResolvedValue({
      url: 'https://s3.example.com/jobs/job-123/frames/frame.png',
      bucket: 'test-bucket',
      key: 'jobs/job-123/frames/frame.png',
    }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Default effective config for tests
const defaultEffectiveConfig = {
  pipelineStrategy: 'classic' as const,
  fps: 10,
  batchSize: 30,
  geminiModel: 'gemini-2.0-flash',
  geminiVideoModel: 'gemini-2.0-flash',
  temperature: 0.2,
  topP: 0.8,
  motionAlpha: 0.3,
  minTemporalGap: 1.0,
  topKPercent: 0.3,
  commercialVersions: ['transparent', 'solid', 'real', 'creative'],
  aiCleanup: true,
  geminiVideoFps: 1,
  geminiVideoMaxFrames: 10,
  debugEnabled: false,
};

// Mock globalConfigService
const { mockGetEffectiveConfig } = vi.hoisted(() => ({
  mockGetEffectiveConfig: vi.fn(),
}));

vi.mock('./global-config.service.js', () => ({
  globalConfigService: {
    getEffectiveConfig: mockGetEffectiveConfig,
    getAllConfig: vi.fn().mockResolvedValue(new Map()),
    getValue: vi.fn(),
    setValue: vi.fn(),
    invalidateCache: vi.fn(),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock s3-url util
vi.mock('../utils/s3-url.js', () => ({
  extractS3KeyFromUrl: vi.fn((url: string) => {
    if (url.includes('uploads/')) {
      return 'uploads/video.mp4';
    }
    return null;
  }),
}));

// Mock stack runner and templates
const { mockStackRunnerExecute } = vi.hoisted(() => ({
  mockStackRunnerExecute: vi.fn(),
}));

vi.mock('../processors/index.js', () => ({
  stackRunner: {
    execute: mockStackRunnerExecute,
  },
  getStackTemplate: vi.fn(() => ({
    id: 'classic',
    name: 'Classic Pipeline',
    steps: [{ processor: 'download' }],
  })),
  getDefaultStackId: vi.fn(() => 'classic'),
}));

import { storageService } from './storage.service.js';
import { mkdir, rm } from 'fs/promises';

describe('PipelineService', () => {
  let service: PipelineService;
  const mockJob = {
    id: 'job-123',
    videoUrl: 'https://example.com/video.mp4',
    config: {},
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    callbackUrl: null,
    progress: null,
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
  } as Job;

  beforeEach(() => {
    service = new PipelineService();
    vi.clearAllMocks();

    // Reset mock chains
    mockDb.insert.mockReturnThis();
    mockDb.values.mockReturnThis();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
    mockDb.returning.mockResolvedValue([{ id: 'video-1' }]);
    mockDb.where.mockResolvedValue(undefined);

    // Reset effective config to default
    mockGetEffectiveConfig.mockResolvedValue(defaultEffectiveConfig);

    // Default stack runner response
    mockStackRunnerExecute.mockResolvedValue({
      recommendedFrames: [{ frameId: 'frame-1' }],
      candidateFrames: [{ frameId: 'frame-1' }],
      uploadedUrls: ['https://s3.example.com/frame.png'],
      metadata: {
        commercialImageUrls: { 'product_1_front': { transparent: 'https://s3.example.com/transparent.png' } },
      },
    });
  });

  describe('runPipeline', () => {
    it('should complete the full pipeline successfully', async () => {
      const result = await service.runPipeline(mockJob);

      expect(result.variantsDiscovered).toBe(1);
      expect(result.framesAnalyzed).toBe(1);
      expect(result.finalFrames).toHaveLength(1);
      expect(mockStackRunnerExecute).toHaveBeenCalled();
    });

    it('should create working directories', async () => {
      await service.runPipeline(mockJob);

      expect(mkdir).toHaveBeenCalled();
    });

    it('should cleanup temp directory on completion', async () => {
      await service.runPipeline(mockJob);

      expect(rm).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        force: true,
      });
    });

    it('should call progress callback if provided', async () => {
      const progressCallback = vi.fn().mockResolvedValue(undefined);

      await service.runPipeline(mockJob, progressCallback);

      // Progress is called by processors through context.onProgress
      // The callback is passed to the stack runner context
      expect(mockStackRunnerExecute).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          onProgress: progressCallback,
        }),
        expect.any(Object),
        // initialData is prepared with job.videoUrl injected into video.sourceUrl
        expect.objectContaining({
          video: expect.objectContaining({
            sourceUrl: mockJob.videoUrl,
          }),
        })
      );
    });

    it('should handle pipeline error and update job status', async () => {
      mockStackRunnerExecute.mockRejectedValueOnce(new Error('Pipeline failed'));

      await expect(service.runPipeline(mockJob)).rejects.toThrow('Pipeline failed');

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error: 'Pipeline failed',
        })
      );
    });

    it('should cleanup temp directory even on error', async () => {
      mockStackRunnerExecute.mockRejectedValueOnce(new Error('Pipeline failed'));

      await expect(service.runPipeline(mockJob)).rejects.toThrow();

      expect(rm).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        force: true,
      });
    });

    it('should use stack config from job', async () => {
      const jobWithConfig = {
        ...mockJob,
        config: {
          fps: 10,
          batchSize: 12,
          stack: {
            stackId: 'minimal',
          },
        },
      } as Job;

      await service.runPipeline(jobWithConfig);

      expect(mockStackRunnerExecute).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          config: expect.objectContaining({
            fps: 10,
            batchSize: 12,
          }),
        }),
        expect.objectContaining({
          stackId: 'minimal',
        }),
        // initialData is prepared with job.videoUrl injected into video.sourceUrl
        expect.objectContaining({
          video: expect.objectContaining({
            sourceUrl: mockJob.videoUrl,
          }),
        })
      );
    });

    it('should pass initialData to stack runner when provided', async () => {
      const initialData = {
        video: { path: '/local/video.mp4' },
      };

      await service.runPipeline(mockJob, undefined, undefined, initialData);

      // When initialData has video.path but no video.sourceUrl, job.videoUrl is merged in
      expect(mockStackRunnerExecute).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          video: expect.objectContaining({
            path: '/local/video.mp4',
            sourceUrl: mockJob.videoUrl,
          }),
        })
      );
    });

    it('should not override initialData video.sourceUrl if already provided', async () => {
      const initialData = {
        video: { sourceUrl: 'https://custom.url/video.mp4', path: '/local/video.mp4' },
      };

      await service.runPipeline(mockJob, undefined, undefined, initialData);

      // When initialData already has video.sourceUrl, it should not be overridden
      expect(mockStackRunnerExecute).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          video: expect.objectContaining({
            sourceUrl: 'https://custom.url/video.mp4',
            path: '/local/video.mp4',
          }),
        })
      );
    });
  });

  describe('debug mode', () => {
    it('should preserve temp directory when debug mode is enabled', async () => {
      mockGetEffectiveConfig.mockResolvedValue({
        ...defaultEffectiveConfig,
        debugEnabled: true,
      });

      await service.runPipeline(mockJob);

      // rm should NOT be called when debug mode is enabled
      expect(rm).not.toHaveBeenCalled();
    });

    it('should skip S3 video cleanup when debug mode is enabled', async () => {
      const jobWithS3Url = {
        ...mockJob,
        videoUrl: 'https://s3.example.com/uploads/video.mp4',
      } as Job;

      mockGetEffectiveConfig.mockResolvedValue({
        ...defaultEffectiveConfig,
        debugEnabled: true,
      });

      await service.runPipeline(jobWithS3Url);

      // deleteFile should NOT be called when debug mode is enabled
      expect(storageService.deleteFile).not.toHaveBeenCalled();
    });

    it('should cleanup temp directory when debug mode is disabled', async () => {
      mockGetEffectiveConfig.mockResolvedValue({
        ...defaultEffectiveConfig,
        debugEnabled: false,
      });

      await service.runPipeline(mockJob);

      // rm should be called when debug mode is disabled
      expect(rm).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        force: true,
      });
    });

    it('should preserve temp directory on error when debug mode is enabled', async () => {
      mockGetEffectiveConfig.mockResolvedValue({
        ...defaultEffectiveConfig,
        debugEnabled: true,
      });

      mockStackRunnerExecute.mockRejectedValueOnce(new Error('Pipeline failed'));

      await expect(service.runPipeline(mockJob)).rejects.toThrow('Pipeline failed');

      // rm should NOT be called even on error when debug mode is enabled
      expect(rm).not.toHaveBeenCalled();
    });
  });

  describe('S3 video cleanup', () => {
    it('should cleanup uploaded video from S3 on success', async () => {
      const jobWithS3Url = {
        ...mockJob,
        videoUrl: 'https://s3.example.com/uploads/video.mp4',
      } as Job;

      await service.runPipeline(jobWithS3Url);

      expect(storageService.deleteFile).toHaveBeenCalledWith('uploads/video.mp4');
    });

    it('should not cleanup non-upload S3 URLs', async () => {
      const jobWithNonUploadUrl = {
        ...mockJob,
        videoUrl: 'https://example.com/video.mp4',
      } as Job;

      await service.runPipeline(jobWithNonUploadUrl);

      expect(storageService.deleteFile).not.toHaveBeenCalled();
    });
  });
});

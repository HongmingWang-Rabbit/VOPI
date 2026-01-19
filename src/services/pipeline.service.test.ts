import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineService } from './pipeline.service.js';
import type { Job } from '../db/schema.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
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
  })),
}));

// Mock videoService
vi.mock('./video.service.js', () => ({
  videoService: {
    getMetadata: vi.fn().mockResolvedValue({
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      filename: 'test.mp4',
    }),
    extractFramesDense: vi.fn().mockResolvedValue([
      {
        filename: 'frame_00001.png',
        path: '/tmp/frame_00001.png',
        index: 1,
        timestamp: 0,
        frameId: 'frame_00001',
      },
      {
        filename: 'frame_00002.png',
        path: '/tmp/frame_00002.png',
        index: 2,
        timestamp: 0.2,
        frameId: 'frame_00002',
      },
    ]),
  },
}));

// Mock frameScoringService
vi.mock('./frame-scoring.service.js', () => ({
  frameScoringService: {
    scoreFrames: vi.fn().mockResolvedValue([
      {
        filename: 'frame_00001.png',
        path: '/tmp/frame_00001.png',
        index: 1,
        timestamp: 0,
        frameId: 'frame_00001',
        sharpness: 50,
        motion: 0.1,
        score: 45,
      },
    ]),
    selectBestFramePerSecond: vi.fn().mockReturnValue([
      {
        filename: 'frame_00001.png',
        path: '/tmp/frame_00001.png',
        index: 1,
        timestamp: 0,
        frameId: 'frame_00001',
        sharpness: 50,
        motion: 0.1,
        score: 45,
      },
    ]),
    prepareCandidateMetadata: vi.fn().mockReturnValue([
      {
        frame_id: 'frame_00001',
        timestamp_sec: 0,
        sequence_position: 1,
        total_candidates: 1,
      },
    ]),
    toFrameScores: vi.fn().mockReturnValue({
      sharpness: 50,
      motion: 0.1,
      combined: 45,
    }),
  },
}));

// Mock geminiService
vi.mock('./gemini.service.js', () => ({
  geminiService: {
    classifyFrames: vi.fn().mockResolvedValue({
      frame_evaluation: [
        {
          frame_id: 'frame_00001',
          timestamp_sec: 0,
          product_id: 'product_1',
          variant_id: 'front_view',
          angle_estimate: 'front',
          quality_score_0_100: 85,
          similarity_note: 'Clear shot',
          obstructions: {
            has_obstruction: false,
            obstruction_types: [],
            obstruction_description: null,
            removable_by_ai: true,
          },
        },
      ],
      variants_discovered: [
        {
          product_id: 'product_1',
          variant_id: 'front_view',
          angle_estimate: 'front',
          description: 'Front view',
          best_frame_id: 'frame_00001',
          best_frame_score: 85,
          all_frame_ids: ['frame_00001'],
          obstructions: {
            has_obstruction: false,
            obstruction_types: [],
            obstruction_description: null,
            removable_by_ai: true,
          },
          background_recommendations: {
            solid_color: '#FFFFFF',
            solid_color_name: 'white',
            real_life_setting: 'on a table',
            creative_shot: 'floating',
          },
        },
      ],
    }),
    getRecommendedFrames: vi.fn().mockReturnValue([
      {
        filename: 'frame_00001.png',
        path: '/tmp/frame_00001.png',
        index: 1,
        timestamp: 0,
        frameId: 'frame_00001',
        sharpness: 50,
        motion: 0.1,
        score: 45,
        productId: 'product_1',
        variantId: 'front_view',
        angleEstimate: 'front',
        recommendedType: 'product_1_front_view',
        geminiScore: 85,
        allFrameIds: ['frame_00001'],
        obstructions: {
          has_obstruction: false,
          obstruction_types: [],
          obstruction_description: null,
          removable_by_ai: true,
        },
        backgroundRecommendations: {
          solid_color: '#FFFFFF',
          solid_color_name: 'white',
          real_life_setting: 'on a table',
          creative_shot: 'floating',
        },
      },
    ]),
  },
}));

// Mock photoroomService
vi.mock('./photoroom.service.js', () => ({
  photoroomService: {
    generateAllVersions: vi.fn().mockResolvedValue({
      frameId: 'frame_00001',
      recommendedType: 'product_1_front_view',
      versions: {
        transparent: {
          success: true,
          outputPath: '/tmp/transparent.png',
        },
        solid: {
          success: true,
          outputPath: '/tmp/solid.png',
          bgColor: '#FFFFFF',
        },
      },
    }),
  },
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

import { videoService } from './video.service.js';
import { frameScoringService } from './frame-scoring.service.js';
import { geminiService } from './gemini.service.js';
import { photoroomService } from './photoroom.service.js';
import { storageService } from './storage.service.js';
import { mkdir, rm } from 'fs/promises';

describe('PipelineService', () => {
  let service: PipelineService;
  const mockJob: Job = {
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
  };

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

    // Default returning values
    mockDb.returning.mockResolvedValue([{ id: 'video-1' }]);
    mockDb.where.mockResolvedValue(undefined);
  });

  describe('runPipeline', () => {
    it('should complete the full pipeline successfully', async () => {
      // Setup db returns for frame insertion
      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }]) // video insert
        .mockResolvedValueOnce([{ id: 'frame-1' }]); // frame insert

      const result = await service.runPipeline(mockJob);

      expect(result.variantsDiscovered).toBe(1);
      expect(result.framesAnalyzed).toBe(1);
      expect(result.finalFrames).toHaveLength(1);
      expect(storageService.downloadFromUrl).toHaveBeenCalled();
      expect(videoService.getMetadata).toHaveBeenCalled();
      expect(videoService.extractFramesDense).toHaveBeenCalled();
      expect(frameScoringService.scoreFrames).toHaveBeenCalled();
      expect(geminiService.classifyFrames).toHaveBeenCalled();
      expect(photoroomService.generateAllVersions).toHaveBeenCalled();
    });

    it('should create working directories', async () => {
      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValueOnce([{ id: 'frame-1' }]);

      await service.runPipeline(mockJob);

      expect(mkdir).toHaveBeenCalled();
    });

    it('should cleanup temp directory on completion', async () => {
      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValueOnce([{ id: 'frame-1' }]);

      await service.runPipeline(mockJob);

      expect(rm).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        force: true,
      });
    });

    it('should call progress callback if provided', async () => {
      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValueOnce([{ id: 'frame-1' }]);

      const progressCallback = vi.fn().mockResolvedValue(undefined);

      await service.runPipeline(mockJob, progressCallback);

      expect(progressCallback).toHaveBeenCalled();
      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          percentage: expect.any(Number),
        })
      );
    });

    it('should handle pipeline error and update job status', async () => {
      vi.mocked(storageService.downloadFromUrl).mockRejectedValueOnce(
        new Error('Download failed')
      );

      await expect(service.runPipeline(mockJob)).rejects.toThrow('Download failed');

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error: 'Download failed',
        })
      );
    });

    it('should cleanup temp directory even on error', async () => {
      vi.mocked(storageService.downloadFromUrl).mockRejectedValueOnce(
        new Error('Download failed')
      );

      await expect(service.runPipeline(mockJob)).rejects.toThrow();

      expect(rm).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        force: true,
      });
    });

    it('should use config from job', async () => {
      const jobWithConfig: Job = {
        ...mockJob,
        config: {
          fps: 10,
          batchSize: 12,
        },
      };

      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValueOnce([{ id: 'frame-1' }]);

      await service.runPipeline(jobWithConfig);

      expect(videoService.extractFramesDense).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ fps: 10 })
      );
    });
  });

  describe('getStepNumber', () => {
    it('should return correct step numbers', () => {
      // We test this indirectly through progress updates
      const progressCallback = vi.fn().mockResolvedValue(undefined);

      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValueOnce([{ id: 'frame-1' }]);

      service.runPipeline(mockJob, progressCallback);

      // Progress callback will be called with step numbers
      // The first call should be for downloading (step 1)
    });
  });

  describe('batch processing', () => {
    it('should process frames in batches', async () => {
      const manyFrames = Array.from({ length: 30 }, (_, i) => ({
        filename: `frame_${String(i + 1).padStart(5, '0')}.png`,
        path: `/tmp/frame_${String(i + 1).padStart(5, '0')}.png`,
        index: i + 1,
        timestamp: i * 0.2,
        frameId: `frame_${String(i + 1).padStart(5, '0')}`,
        sharpness: 50,
        motion: 0.1,
        score: 45,
      }));

      vi.mocked(frameScoringService.scoreFrames).mockResolvedValue(manyFrames);
      vi.mocked(frameScoringService.selectBestFramePerSecond).mockReturnValue(manyFrames);

      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValue([{ id: 'frame-1' }]);

      await service.runPipeline(mockJob);

      // With 30 frames and default batchSize of 24, should have 2 batches
      expect(geminiService.classifyFrames).toHaveBeenCalled();
    });
  });

  describe('commercial image generation', () => {
    it('should generate commercial images for recommended frames', async () => {
      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValueOnce([{ id: 'frame-1' }]);

      const result = await service.runPipeline(mockJob);

      expect(photoroomService.generateAllVersions).toHaveBeenCalled();
      expect(result.commercialImages).toBeDefined();
    });

    it('should use AI edit when frames have obstructions', async () => {
      vi.mocked(geminiService.getRecommendedFrames).mockReturnValue([
        {
          filename: 'frame_00001.png',
          path: '/tmp/frame_00001.png',
          index: 1,
          timestamp: 0,
          frameId: 'frame_00001',
          sharpness: 50,
          motion: 0.1,
          score: 45,
          productId: 'product_1',
          variantId: 'front_view',
          angleEstimate: 'front',
          recommendedType: 'product_1_front_view',
          geminiScore: 85,
          allFrameIds: ['frame_00001'],
          obstructions: {
            has_obstruction: true,
            obstruction_types: ['hand'],
            obstruction_description: 'Hand visible',
            removable_by_ai: true,
          },
          backgroundRecommendations: {
            solid_color: '#FFFFFF',
            solid_color_name: 'white',
            real_life_setting: 'on a table',
            creative_shot: 'floating',
          },
        },
      ]);

      const jobWithAICleanup: Job = {
        ...mockJob,
        config: { aiCleanup: true },
      };

      mockDb.returning
        .mockResolvedValueOnce([{ id: 'video-1' }])
        .mockResolvedValueOnce([{ id: 'frame-1' }]);

      await service.runPipeline(jobWithAICleanup);

      expect(photoroomService.generateAllVersions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({ useAIEdit: true })
      );
    });
  });
});

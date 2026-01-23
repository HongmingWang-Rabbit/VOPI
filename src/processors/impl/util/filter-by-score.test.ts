/**
 * Filter By Score Processor Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('../../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { filterByScoreProcessor } from './filter-by-score.js';
import type { ProcessorContext, PipelineData, FrameMetadata } from '../../types.js';
import type { Job } from '../../../db/schema.js';
import type { PipelineTimer } from '../../../utils/timer.js';

// Helper to create mock context
function createMockContext(overrides?: Partial<ProcessorContext>): ProcessorContext {
  const mockTimer = {
    startStep: vi.fn(),
    endStep: vi.fn(),
    timeOperation: vi.fn().mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as PipelineTimer;

  return {
    job: { id: 'job-1', videoUrl: 'https://example.com/video.mp4' } as Job,
    jobId: 'job-1',
    config: {
      fps: 10,
      batchSize: 30,
      commercialVersions: ['transparent', 'solid'],
      aiCleanup: true,
      geminiModel: 'gemini-2.0-flash',
    },
    workDirs: {
      root: '/tmp/job-1',
      video: '/tmp/job-1/video',
      frames: '/tmp/job-1/frames',
      candidates: '/tmp/job-1/candidates',
      extracted: '/tmp/job-1/extracted',
      final: '/tmp/job-1/final',
      commercial: '/tmp/job-1/commercial',
    },
    onProgress: vi.fn(),
    timer: mockTimer,
    effectiveConfig: {
      pipelineStrategy: 'classic',
      fps: 10,
      batchSize: 30,
      geminiModel: 'gemini-2.0-flash',
      geminiVideoModel: 'gemini-2.0-flash',
      geminiImageModel: 'gemini-3-pro-image-preview',
      temperature: 0.2,
      topP: 0.8,
      motionAlpha: 0.3,
      minTemporalGap: 1,
      topKPercent: 0.3,
      commercialVersions: ['transparent', 'solid'],
      aiCleanup: true,
      geminiVideoFps: 1,
      geminiVideoMaxFrames: 10,
      debugEnabled: false,
    },
    ...overrides,
  };
}

// Helper to create frame metadata
function createFrame(id: string, score: number): FrameMetadata {
  return {
    frameId: id,
    filename: `${id}.jpg`,
    path: `/frames/${id}.jpg`,
    timestamp: 0,
    index: 0,
    score,
  };
}

describe('filterByScoreProcessor', () => {
  describe('metadata', () => {
    it('should have correct id', () => {
      expect(filterByScoreProcessor.id).toBe('filter-by-score');
    });

    it('should have correct IO declaration', () => {
      // DataPath is the unified type for all data requirements
      expect(filterByScoreProcessor.io.requires).toContain('images');
      expect(filterByScoreProcessor.io.requires).toContain('frames');
      expect(filterByScoreProcessor.io.requires).toContain('frames.scores');
      expect(filterByScoreProcessor.io.produces).toContain('images');
      expect(filterByScoreProcessor.io.produces).toHaveLength(1); // Only images
    });
  });

  describe('execute', () => {
    let context: ProcessorContext;

    beforeEach(() => {
      context = createMockContext();
    });

    it('should return error if no scored frames provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No scored frames to filter. Ensure score-frames processor ran first.');
    });

    it('should return error if scored frames array is empty', async () => {
      const data: PipelineData = { metadata: {}, scoredFrames: [] };

      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No scored frames to filter. Ensure score-frames processor ran first.');
    });

    it('should filter frames by score keeping top percentage', async () => {
      const frames: FrameMetadata[] = [
        createFrame('f1', 100),
        createFrame('f2', 80),
        createFrame('f3', 60),
        createFrame('f4', 40),
        createFrame('f5', 20),
        createFrame('f6', 10),
        createFrame('f7', 5),
        createFrame('f8', 3),
        createFrame('f9', 2),
        createFrame('f10', 1),
      ];

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      // topKPercent is 0.3 by default, so 30% of 10 = 3 frames
      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(true);
      expect(result.data?.recommendedFrames).toHaveLength(3);

      // Should be sorted by score descending
      const recommended = result.data?.recommendedFrames as FrameMetadata[];
      expect(recommended[0].frameId).toBe('f1');
      expect(recommended[1].frameId).toBe('f2');
      expect(recommended[2].frameId).toBe('f3');
    });

    it('should respect minFrames option', async () => {
      const frames: FrameMetadata[] = [
        createFrame('f1', 100),
        createFrame('f2', 80),
      ];

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      // With topKPercent 0.3, we'd get 0.6 frames, but minFrames should ensure at least 1
      const result = await filterByScoreProcessor.execute(context, data, { minFrames: 1 });

      expect(result.success).toBe(true);
      expect(result.data?.recommendedFrames?.length).toBeGreaterThanOrEqual(1);
    });

    it('should respect maxFrames option', async () => {
      const frames: FrameMetadata[] = Array.from({ length: 100 }, (_, i) =>
        createFrame(`f${i}`, 100 - i)
      );

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      // With 100 frames and 30% = 30 frames, but maxFrames limits it
      const result = await filterByScoreProcessor.execute(context, data, { maxFrames: 5 });

      expect(result.success).toBe(true);
      expect(result.data?.recommendedFrames).toHaveLength(5);
    });

    it('should use custom topKPercent from options', async () => {
      const frames: FrameMetadata[] = Array.from({ length: 10 }, (_, i) =>
        createFrame(`f${i}`, 100 - i * 10)
      );

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      // 50% of 10 = 5 frames
      const result = await filterByScoreProcessor.execute(context, data, { topKPercent: 0.5 });

      expect(result.success).toBe(true);
      expect(result.data?.recommendedFrames).toHaveLength(5);
    });

    it('should mark filtered frames as final selection', async () => {
      const frames: FrameMetadata[] = [
        createFrame('f1', 100),
        createFrame('f2', 50),
      ];

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(true);
      const recommended = result.data?.recommendedFrames as FrameMetadata[];
      for (const frame of recommended) {
        expect(frame.isFinalSelection).toBe(true);
      }
    });

    it('should return image paths in data.images', async () => {
      const frames: FrameMetadata[] = [
        createFrame('f1', 100),
        createFrame('f2', 80),
        createFrame('f3', 60),
      ];

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(true);
      expect(result.data?.images).toContain('/frames/f1.jpg');
    });

    it('should prefer candidateFrames over scoredFrames', async () => {
      const scoredFrames: FrameMetadata[] = [createFrame('scored', 50)];
      const candidateFrames: FrameMetadata[] = [createFrame('candidate', 100)];

      const data: PipelineData = { metadata: {}, scoredFrames, candidateFrames };

      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(true);
      const recommended = result.data?.recommendedFrames as FrameMetadata[];
      expect(recommended[0].frameId).toBe('candidate');
    });

    it('should handle frames with undefined scores', async () => {
      const frames: FrameMetadata[] = [
        createFrame('f1', 100),
        { ...createFrame('f2', 0), score: undefined },
        createFrame('f3', 50),
      ];

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(true);
      // Undefined scores should be treated as 0
      const recommended = result.data?.recommendedFrames as FrameMetadata[];
      expect(recommended[0].frameId).toBe('f1');
    });

    it('should handle all frames with same score', async () => {
      const frames: FrameMetadata[] = [
        createFrame('f1', 50),
        createFrame('f2', 50),
        createFrame('f3', 50),
      ];

      const data: PipelineData = { metadata: {}, candidateFrames: frames };

      const result = await filterByScoreProcessor.execute(context, data);

      expect(result.success).toBe(true);
      // Should still return some frames
      expect(result.data?.recommendedFrames?.length).toBeGreaterThan(0);
    });
  });
});

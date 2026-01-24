/**
 * Spend Credits Processor Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessorContext, PipelineData } from '../../types.js';
import type { Job } from '../../../db/schema.js';
import type { CreditError } from '../../../types/credits.types.js';
import type { JobConfig } from '../../../types/job.types.js';

// Mock logger
vi.mock('../../../utils/logger.js', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockLogger.child = vi.fn(() => mockLogger);
  return {
    createChildLogger: vi.fn(() => mockLogger),
    getLogger: vi.fn(() => mockLogger),
  };
});

// Use vi.hoisted to create mock functions that can be used in vi.mock
const { mockCalculateJobCost, mockSpendCredits } = vi.hoisted(() => ({
  mockCalculateJobCost: vi.fn(),
  mockSpendCredits: vi.fn(),
}));

// Mock credits service
vi.mock('../../../services/credits.service.js', () => ({
  creditsService: {
    calculateJobCost: mockCalculateJobCost,
    spendCredits: mockSpendCredits,
  },
}));

// Import after mocks
import { spendCreditsProcessor } from './spend-credits.js';

describe('spendCreditsProcessor', () => {
  const mockJobId = 'job-123';
  const mockUserId = 'user-456';

  const createMockContext = (userId: string | null): ProcessorContext => ({
    job: {
      id: mockJobId,
      userId,
      videoUrl: 'https://example.com/video.mp4',
      status: 'processing',
      config: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Job,
    jobId: mockJobId,
    config: {} as JobConfig,
    workDirs: {
      root: '/tmp/test',
      video: '/tmp/test/video',
      frames: '/tmp/test/frames',
      candidates: '/tmp/test/candidates',
      extracted: '/tmp/test/extracted',
      final: '/tmp/test/final',
      commercial: '/tmp/test/commercial',
    },
    timer: {
      start: vi.fn(),
      stop: vi.fn(),
      logSummary: vi.fn(),
    } as unknown as ProcessorContext['timer'],
    effectiveConfig: {
      pipelineStrategy: 'classic',
      fps: 10,
      batchSize: 30,
      geminiModel: 'test',
      geminiVideoModel: 'test',
      geminiImageModel: 'test',
      temperature: 0.2,
      topP: 0.8,
      motionAlpha: 0.3,
      minTemporalGap: 1.0,
      topKPercent: 0.3,
      commercialVersions: ['transparent'],
      aiCleanup: true,
      geminiVideoFps: 1,
      geminiVideoMaxFrames: 10,
      debugEnabled: false,
    },
  });

  const createMockPipelineData = (videoDuration?: number): PipelineData => ({
    video: videoDuration !== undefined ? {
      path: '/tmp/test/video.mp4',
      metadata: {
        duration: videoDuration,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'h264',
        filename: 'video.mp4',
      },
    } : undefined,
    metadata: {},
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(spendCreditsProcessor.id).toBe('spend-credits');
    });

    it('should have correct display name', () => {
      expect(spendCreditsProcessor.displayName).toBe('Spend Credits');
    });

    it('should require video input', () => {
      expect(spendCreditsProcessor.io.requires).toContain('video');
    });

    it('should not produce any outputs', () => {
      expect(spendCreditsProcessor.io.produces).toHaveLength(0);
    });
  });

  describe('execute', () => {
    it('should skip credit spending for API key jobs (no userId)', async () => {
      const context = createMockContext(null);
      const data = createMockPipelineData(30);

      const result = await spendCreditsProcessor.execute(context, data);

      expect(result.success).toBe(true);
      expect(mockCalculateJobCost).not.toHaveBeenCalled();
      expect(mockSpendCredits).not.toHaveBeenCalled();
    });

    it('should calculate and spend credits for user jobs', async () => {
      const context = createMockContext(mockUserId);
      const data = createMockPipelineData(30);

      mockCalculateJobCost.mockResolvedValue({
        totalCredits: 2.5,
        breakdown: [
          { type: 'base', description: 'Base fee', credits: 1 },
          { type: 'duration', description: '30 seconds', credits: 1.5 },
        ],
      });

      mockSpendCredits.mockResolvedValue({
        success: true,
        newBalance: 7.5,
        transactionId: 'txn-789',
      });

      const result = await spendCreditsProcessor.execute(context, data);

      expect(result.success).toBe(true);
      expect(mockCalculateJobCost).toHaveBeenCalledWith({
        videoDurationSeconds: 30,
        frameCount: undefined,
        addOns: undefined,
      });
      expect(mockSpendCredits).toHaveBeenCalledWith(
        mockUserId,
        3, // Rounded from 2.5
        `job:${mockJobId}:spend`,
        mockJobId,
        'Video processing (30s)'
      );
    });

    it('should fail when insufficient credits with structured error data', async () => {
      const context = createMockContext(mockUserId);
      const data = createMockPipelineData(60);

      mockCalculateJobCost.mockResolvedValue({
        totalCredits: 10,
        breakdown: [{ type: 'base', description: 'Base', credits: 10 }],
      });

      mockSpendCredits.mockResolvedValue({
        success: false,
        newBalance: 5,
        error: 'Insufficient credits',
      });

      const result = await spendCreditsProcessor.execute(context, data);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient credits');
      expect(result.error).toContain('Required: 10');
      expect(result.error).toContain('available: 5');

      // Check structured error data
      const creditError = result.data?.metadata?.extensions?.creditError as CreditError | undefined;
      expect(creditError).toBeDefined();
      expect(creditError?.code).toBe('INSUFFICIENT_CREDITS');
      expect(creditError?.creditsRequired).toBe(10);
      expect(creditError?.creditsAvailable).toBe(5);
      expect(creditError?.breakdown).toHaveLength(1);
      expect(creditError?.videoDurationSeconds).toBe(60);
    });

    it('should use minimum credits (1) when video duration is missing', async () => {
      const context = createMockContext(mockUserId);
      const data: PipelineData = { metadata: {} }; // No video data

      mockCalculateJobCost.mockResolvedValue({
        totalCredits: 0.5,
        breakdown: [],
      });

      mockSpendCredits.mockResolvedValue({
        success: true,
        newBalance: 9,
        transactionId: 'txn-min',
      });

      const result = await spendCreditsProcessor.execute(context, data);

      expect(result.success).toBe(true);
      expect(mockCalculateJobCost).toHaveBeenCalledWith({
        videoDurationSeconds: 0,
        frameCount: undefined,
        addOns: undefined,
      });
      // Should use minimum of 1 credit
      expect(mockSpendCredits).toHaveBeenCalledWith(
        mockUserId,
        1, // Math.max(1, Math.round(0.5))
        expect.any(String),
        mockJobId,
        expect.any(String)
      );
    });

    it('should use idempotency key based on job ID', async () => {
      const context = createMockContext(mockUserId);
      const data = createMockPipelineData(30);

      mockCalculateJobCost.mockResolvedValue({ totalCredits: 2, breakdown: [] });
      mockSpendCredits.mockResolvedValue({ success: true, newBalance: 8, transactionId: 'txn' });

      await spendCreditsProcessor.execute(context, data);

      expect(mockSpendCredits).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
        `job:${mockJobId}:spend`,
        expect.any(String),
        expect.any(String)
      );
    });

    it('should store credit info in metadata on success', async () => {
      const context = createMockContext(mockUserId);
      const data = createMockPipelineData(30);

      mockCalculateJobCost.mockResolvedValue({
        totalCredits: 2.5,
        breakdown: [{ type: 'base', credits: 1 }],
      });

      mockSpendCredits.mockResolvedValue({
        success: true,
        newBalance: 7.5,
        transactionId: 'txn-success',
      });

      const result = await spendCreditsProcessor.execute(context, data);

      expect(result.success).toBe(true);
      expect(result.data?.metadata?.extensions?.credits).toEqual({
        spent: 3, // Rounded
        transactionId: 'txn-success',
        breakdown: [{ type: 'base', credits: 1 }],
        videoDurationSeconds: 30,
      });
    });

    it('should pass frameCount from options', async () => {
      const context = createMockContext(mockUserId);
      const data = createMockPipelineData(30);

      mockCalculateJobCost.mockResolvedValue({ totalCredits: 3, breakdown: [] });
      mockSpendCredits.mockResolvedValue({ success: true, newBalance: 7, transactionId: 'txn' });

      await spendCreditsProcessor.execute(context, data, { frameCount: 8 });

      expect(mockCalculateJobCost).toHaveBeenCalledWith({
        videoDurationSeconds: 30,
        frameCount: 8,
        addOns: undefined,
      });
    });

    it('should get duration from metadata.video when video.metadata is unavailable', async () => {
      const context = createMockContext(mockUserId);
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' }, // No metadata
        metadata: {
          video: { duration: 45, width: 1920, height: 1080, fps: 30, codec: 'h264' },
        },
      };

      mockCalculateJobCost.mockResolvedValue({ totalCredits: 3, breakdown: [] });
      mockSpendCredits.mockResolvedValue({ success: true, newBalance: 7, transactionId: 'txn' });

      await spendCreditsProcessor.execute(context, data);

      expect(mockCalculateJobCost).toHaveBeenCalledWith({
        videoDurationSeconds: 45,
        frameCount: undefined,
        addOns: undefined,
      });
    });
  });
});

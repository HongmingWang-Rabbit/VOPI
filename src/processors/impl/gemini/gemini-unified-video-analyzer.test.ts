/**
 * Gemini Unified Video Analyzer Processor Tests
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

// Mock the provider
vi.mock('../../../providers/implementations/gemini-unified-video-analyzer.provider.js', () => ({
  geminiUnifiedVideoAnalyzerProvider: {
    analyzeVideo: vi.fn(),
  },
}));

// Mock video service
vi.mock('../../../services/video.service.js', () => ({
  videoService: {
    getMetadata: vi.fn(),
    extractSingleFrame: vi.fn(),
  },
}));

// Mock database
const mockInsert = vi.fn();
vi.mock('../../../db/index.js', () => ({
  getDatabase: vi.fn(() => ({
    insert: mockInsert,
  })),
  schema: {
    frames: {},
  },
}));

// Mock parallel utility
vi.mock('../../../utils/parallel.js', () => ({
  parallelMap: vi.fn(async (items: unknown[], fn: (item: unknown) => Promise<unknown>) => {
    const results = await Promise.all(items.map(fn));
    return { results, successCount: results.length, errorCount: 0 };
  }),
  isParallelError: vi.fn((result: unknown) => result instanceof Error),
}));

// Mock saveVideoRecord
vi.mock('../../utils/index.js', () => ({
  saveVideoRecord: vi.fn().mockResolvedValue({ id: 'video-db-id-123' }),
}));

// Mock concurrency
vi.mock('../../concurrency.js', () => ({
  getConcurrency: vi.fn(() => 4),
}));

import { geminiUnifiedVideoAnalyzerProcessor } from './gemini-unified-video-analyzer.js';
import { geminiUnifiedVideoAnalyzerProvider } from '../../../providers/implementations/gemini-unified-video-analyzer.provider.js';
import { videoService } from '../../../services/video.service.js';
import type { ProcessorContext, PipelineData } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';
import type { UnifiedVideoAnalysisResult } from '../../../providers/interfaces/unified-video-analyzer.provider.js';

describe('geminiUnifiedVideoAnalyzerProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(geminiUnifiedVideoAnalyzerProcessor.id).toBe('gemini-unified-video-analyzer');
    });

    it('should have correct displayName', () => {
      expect(geminiUnifiedVideoAnalyzerProcessor.displayName).toBe('Unified Video Analyzer');
    });

    it('should require video input', () => {
      expect(geminiUnifiedVideoAnalyzerProcessor.io.requires).toContain('video');
    });

    it('should produce all expected outputs', () => {
      const { produces } = geminiUnifiedVideoAnalyzerProcessor.io;
      expect(produces).toContain('images');
      expect(produces).toContain('frames');
      expect(produces).toContain('frames.scores');
      expect(produces).toContain('frames.classifications');
      expect(produces).toContain('frames.dbId');
      expect(produces).toContain('transcript');
      expect(produces).toContain('product.metadata');
    });
  });

  describe('execute', () => {
    let mockContext: ProcessorContext;
    let mockTimer: PipelineTimer;

    const mockAnalysisResult: UnifiedVideoAnalysisResult = {
      products: [
        {
          productId: 'product_1',
          description: 'Test product',
          category: 'electronics',
          mentionedInAudio: true,
        },
      ],
      selectedFrames: [
        {
          timestamp: 5.5,
          selectionReason: 'Clear view with audio context',
          productId: 'product_1',
          variantId: 'front_view',
          angleEstimate: 'front',
          qualityScore: 85,
          rotationAngleDeg: 5,
          variantDescription: 'Front view',
          audioMentionTimestamp: 4.2,
          obstructions: {
            has_obstruction: false,
            obstruction_types: [],
            obstruction_description: null,
            removable_by_ai: true,
          },
          backgroundRecommendations: {
            solid_color: '#FFFFFF',
            solid_color_name: 'white',
            real_life_setting: 'on a desk',
            creative_shot: 'floating',
          },
        },
        {
          timestamp: 12.3,
          selectionReason: 'Side angle',
          productId: 'product_1',
          variantId: 'side_view',
          angleEstimate: 'side',
          qualityScore: 80,
          rotationAngleDeg: 0,
          obstructions: {
            has_obstruction: false,
            obstruction_types: [],
            obstruction_description: null,
            removable_by_ai: true,
          },
          backgroundRecommendations: {
            solid_color: '#F5F5F5',
            solid_color_name: 'light gray',
            real_life_setting: 'on a shelf',
            creative_shot: 'with shadow',
          },
        },
      ],
      videoDuration: 30.0,
      framesAnalyzed: 30,
      audioAnalysis: {
        hasAudio: true,
        transcript: 'This is a test product with great features.',
        language: 'en',
        audioQuality: 85,
        productMetadata: {
          title: 'Amazing Test Product',
          description: 'A wonderful test product with many features.',
          shortDescription: 'Great test product',
          bulletPoints: ['Feature 1', 'Feature 2', 'Feature 3'],
          brand: 'TestBrand',
          category: 'electronics',
          materials: ['plastic', 'metal'],
          color: 'black',
          condition: 'new',
          price: 29.99,
          currency: 'USD',
          confidence: { overall: 85, title: 90, description: 85 },
          extractedFromAudio: true,
        },
        confidence: {
          overall: 85,
          title: 90,
          description: 85,
          price: 70,
          attributes: 75,
        },
        relevantExcerpts: ['great features', 'quality product'],
      },
    };

    beforeEach(() => {
      mockTimer = {
        timeOperation: vi.fn().mockImplementation(async (_name, fn) => fn()),
        getMetrics: vi.fn(),
        reset: vi.fn(),
      } as unknown as PipelineTimer;

      mockContext = {
        job: { id: 'test-job-123', videoUrl: 'https://example.com/video.mp4' } as ProcessorContext['job'],
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
        effectiveConfig: {
          geminiVideoModel: 'gemini-2.0-flash',
          geminiVideoMaxFrames: 10,
          temperature: 0.2,
          topP: 0.8,
        } as ProcessorContext['effectiveConfig'],
        timer: mockTimer,
      };

      // Setup default mocks
      vi.mocked(videoService.getMetadata).mockResolvedValue({
        duration: 30,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'h264',
        filename: 'video.mp4',
      });

      vi.mocked(videoService.extractSingleFrame).mockImplementation(
        async (_videoPath: string, _timestamp: number, outputPath: string) => outputPath
      );

      vi.mocked(geminiUnifiedVideoAnalyzerProvider.analyzeVideo).mockResolvedValue(mockAnalysisResult);

      mockInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'frame-db-1', frameId: 'frame_00001' },
            { id: 'frame-db-2', frameId: 'frame_00002' },
          ]),
        }),
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return error when no video path provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No video path provided');
    });

    it('should analyze video and return structured result', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.frames).toHaveLength(2);
      expect(result.data?.images).toHaveLength(2);
      expect(result.data?.metadata?.frames).toHaveLength(2);
      expect(result.data?.metadata?.transcript).toBe('This is a test product with great features.');
      expect(result.data?.metadata?.productMetadata?.title).toBe('Amazing Test Product');
    });

    it('should call provider with correct options', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const options = {
        maxFrames: 5,
        maxBulletPoints: 3,
        skipAudioAnalysis: true,
        model: 'gemini-custom-model',
      };

      await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data, options);

      expect(geminiUnifiedVideoAnalyzerProvider.analyzeVideo).toHaveBeenCalledWith(
        '/tmp/video.mp4',
        expect.objectContaining({
          maxFrames: 5,
          maxBulletPoints: 3,
          skipAudioAnalysis: true,
          model: 'gemini-custom-model',
        })
      );
    });

    it('should extract frames at selected timestamps', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      // Should extract 2 frames (one for each selected frame)
      expect(videoService.extractSingleFrame).toHaveBeenCalledTimes(2);
      expect(videoService.extractSingleFrame).toHaveBeenCalledWith(
        '/tmp/video.mp4',
        5.5,
        expect.stringContaining('frame_00001')
      );
      expect(videoService.extractSingleFrame).toHaveBeenCalledWith(
        '/tmp/video.mp4',
        12.3,
        expect.stringContaining('frame_00002')
      );
    });

    it('should save frame records to database', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      expect(mockInsert).toHaveBeenCalled();
      expect(result.data?.frameRecords).toBeDefined();
      expect(result.data?.frameRecords?.get('frame_00001')).toBe('frame-db-1');
      expect(result.data?.frameRecords?.get('frame_00002')).toBe('frame-db-2');
    });

    it('should handle videos without audio', async () => {
      const noAudioResult: UnifiedVideoAnalysisResult = {
        ...mockAnalysisResult,
        audioAnalysis: {
          hasAudio: false,
          transcript: '',
          language: '',
          audioQuality: 0,
        },
      };

      vi.mocked(geminiUnifiedVideoAnalyzerProvider.analyzeVideo).mockResolvedValue(noAudioResult);

      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.audio?.hasAudio).toBe(false);
      expect(result.data?.metadata?.transcript).toBe('');
      expect(result.data?.metadata?.productMetadata).toBeUndefined();
    });

    it('should include correct frame metadata', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      const firstFrame = result.data?.frames?.[0];
      expect(firstFrame).toBeDefined();
      expect(firstFrame?.frameId).toBe('frame_00001');
      expect(firstFrame?.timestamp).toBe(5.5);
      expect(firstFrame?.productId).toBe('product_1');
      expect(firstFrame?.variantId).toBe('front_view');
      expect(firstFrame?.score).toBe(85);
      expect(firstFrame?.geminiScore).toBe(85);
      expect(firstFrame?.isFinalSelection).toBe(true);
      expect(firstFrame?.isBestPerSecond).toBe(true);
    });

    it('should preserve existing metadata', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {
          existingField: 'preserved',
        } as PipelineData['metadata'],
      };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      expect((result.data?.metadata as Record<string, unknown>)?.existingField).toBe('preserved');
    });

    it('should report progress during execution', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      // Should call onProgress multiple times
      expect(mockContext.onProgress).toHaveBeenCalled();
      const progressCalls = vi.mocked(mockContext.onProgress!).mock.calls;
      expect(progressCalls.length).toBeGreaterThan(0);
    });

    it('should use timer for operations', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      // Should time the unified analysis operation
      expect(mockTimer.timeOperation).toHaveBeenCalledWith(
        'gemini_unified_analyze',
        expect.any(Function),
        expect.any(Object)
      );

      // Should time frame extraction operations
      expect(mockTimer.timeOperation).toHaveBeenCalledWith(
        'ffmpeg_extract_frame',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should include audio analysis extensions in metadata', async () => {
      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      const audioAnalysis = result.data?.metadata?.extensions?.audioAnalysis as {
        language?: string;
        audioQuality?: number;
        relevantExcerpts?: string[];
      };
      expect(audioAnalysis).toBeDefined();
      expect(audioAnalysis?.language).toBe('en');
      expect(audioAnalysis?.audioQuality).toBe(85);
      expect(audioAnalysis?.relevantExcerpts).toEqual([
        'great features',
        'quality product',
      ]);
    });

    it('should handle empty selected frames', async () => {
      const emptyFramesResult: UnifiedVideoAnalysisResult = {
        ...mockAnalysisResult,
        selectedFrames: [],
      };

      vi.mocked(geminiUnifiedVideoAnalyzerProvider.analyzeVideo).mockResolvedValue(emptyFramesResult);

      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const result = await geminiUnifiedVideoAnalyzerProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.frames).toHaveLength(0);
      expect(result.data?.images).toHaveLength(0);
      expect(videoService.extractSingleFrame).not.toHaveBeenCalled();
    });
  });
});

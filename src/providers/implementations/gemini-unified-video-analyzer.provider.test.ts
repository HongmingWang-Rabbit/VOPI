import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock functions defined at module scope
const mockGenerateContent = vi.fn();
const mockUploadFile = vi.fn();
const mockGetFile = vi.fn();
const mockDeleteFile = vi.fn();

// Mock Google Generative AI with proper class-like implementations
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    getGenerativeModel() {
      return {
        generateContent: mockGenerateContent,
      };
    }
  },
}));

vi.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: class MockGoogleAIFileManager {
    uploadFile = mockUploadFile;
    getFile = mockGetFile;
    deleteFile = mockDeleteFile;
  },
  FileState: {
    PROCESSING: 'PROCESSING',
    ACTIVE: 'ACTIVE',
    FAILED: 'FAILED',
  },
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    apis: {
      googleAi: 'test-api-key',
      geminiModel: 'gemini-2.0-flash',
    },
    worker: {
      apiRetryDelayMs: 10,
    },
    audio: {
      processingTimeoutMs: 10000,
      pollingIntervalMs: 100,
    },
    ffmpeg: {
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
  })),
}));

// Mock child_process spawn for codec detection
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Create mock for spawn that returns a mock process
function createMockProcess(codec = 'h264') {
  const mockProcess = {
    stdout: {
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from(codec));
        }
      }),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event, callback) => {
      if (event === 'close') {
        callback(0);
      }
    }),
  };
  return mockProcess;
}

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock errors
vi.mock('../../utils/errors.js', () => ({
  ExternalApiError: class ExternalApiError extends Error {
    constructor(provider: string, message: string) {
      super(`${provider}: ${message}`);
      this.name = 'ExternalApiError';
    }
  },
}));

import { GeminiUnifiedVideoAnalyzerProvider } from './gemini-unified-video-analyzer.provider.js';

describe('GeminiUnifiedVideoAnalyzerProvider', () => {
  let provider: GeminiUnifiedVideoAnalyzerProvider;

  const validResponse = {
    products_detected: [
      {
        product_id: 'product_1',
        description: 'Test product',
        product_category: 'electronics',
        mentioned_in_audio: true,
      },
    ],
    selected_frames: [
      {
        timestamp_sec: 5.5,
        selection_reason: 'Clear view with audio context',
        product_id: 'product_1',
        variant_id: 'front_view',
        angle_estimate: 'front',
        quality_score_0_100: 85,
        rotation_angle_deg: 5,
        variant_description: 'Front view',
        audio_mention_timestamp: 4.2,
        obstructions: {
          has_obstruction: false,
          obstruction_types: [],
          obstruction_description: null,
          removable_by_ai: true,
        },
        background_recommendations: {
          solid_color: '#FFFFFF',
          solid_color_name: 'white',
          real_life_setting: 'on a desk',
          creative_shot: 'floating',
        },
      },
    ],
    video_duration_sec: 30.0,
    frames_analyzed: 30,
    audio_analysis: {
      has_audio: true,
      transcript: 'This is a test product with great features.',
      language: 'en',
      audio_quality_0_100: 85,
      product: {
        title: 'Amazing Test Product',
        description: 'A wonderful test product with many features.',
        short_description: 'Great test product',
        bullet_points: ['Feature 1', 'Feature 2', 'Feature 3'],
        brand: 'TestBrand',
        category: 'electronics',
        materials: ['plastic', 'metal'],
        color: 'black',
        condition: 'new',
        price: {
          value: 29.99,
          currency: 'USD',
        },
        dimensions: {
          length: 10,
          width: 5,
          height: 2,
          unit: 'in',
        },
        weight: {
          value: 1.5,
          unit: 'lb',
        },
      },
      confidence: {
        overall: 85,
        title: 90,
        description: 85,
        price: 70,
        attributes: 75,
      },
      relevant_excerpts: ['great features', 'quality product'],
    },
  };

  const responseWithNoAudio = {
    ...validResponse,
    audio_analysis: {
      has_audio: false,
      transcript: '',
      language: '',
      audio_quality_0_100: 0,
    },
  };

  beforeEach(() => {
    provider = new GeminiUnifiedVideoAnalyzerProvider();
    vi.clearAllMocks();

    // Mock spawn to return h264 codec (no transcoding needed)
    mockSpawn.mockReturnValue(createMockProcess('h264'));

    // Default mock setup
    mockUploadFile.mockResolvedValue({
      file: {
        uri: 'files/test-video-123',
        name: 'test-video-123',
        state: 'ACTIVE',
      },
    });

    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify(validResponse),
      },
    });

    mockDeleteFile.mockResolvedValue(undefined);
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('gemini-unified-video');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is configured', () => {
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('uploadVideo', () => {
    it('should upload video and return file URI', async () => {
      const uri = await provider.uploadVideo('/path/to/video.mp4');

      expect(mockUploadFile).toHaveBeenCalledWith('/path/to/video.mp4', {
        mimeType: 'video/mp4',
        displayName: 'video.mp4',
      });
      expect(uri).toBe('files/test-video-123');
    });

    it('should throw when processing fails', async () => {
      mockUploadFile.mockResolvedValue({
        file: {
          uri: 'files/test-video-123',
          name: 'test-video-123',
          state: 'FAILED',
        },
      });

      await expect(provider.uploadVideo('/path/to/video.mp4')).rejects.toThrow(
        'Video processing failed'
      );
    });

    it('should detect correct MIME type for different extensions', async () => {
      await provider.uploadVideo('/path/to/video.mov');
      expect(mockUploadFile).toHaveBeenCalledWith(
        '/path/to/video.mov',
        expect.objectContaining({ mimeType: 'video/quicktime' })
      );
    });
  });

  describe('deleteVideo', () => {
    it('should delete video by file name', async () => {
      await provider.deleteVideo('files/test-video-123');

      expect(mockDeleteFile).toHaveBeenCalledWith('test-video-123');
    });

    it('should handle delete errors gracefully', async () => {
      mockDeleteFile.mockRejectedValue(new Error('Delete failed'));

      // Should not throw
      await expect(provider.deleteVideo('files/test-video-123')).resolves.toBeUndefined();
    });
  });

  describe('analyzeVideo', () => {
    it('should analyze video and return structured result with audio', async () => {
      const result = await provider.analyzeVideo('/path/to/video.mp4');

      expect(result.products).toHaveLength(1);
      expect(result.products[0].productId).toBe('product_1');
      expect(result.products[0].mentionedInAudio).toBe(true);
      expect(result.selectedFrames).toHaveLength(1);
      expect(result.selectedFrames[0].timestamp).toBe(5.5);
      expect(result.selectedFrames[0].qualityScore).toBe(85);
      expect(result.selectedFrames[0].audioMentionTimestamp).toBe(4.2);
      expect(result.videoDuration).toBe(30.0);

      // Audio analysis checks
      expect(result.audioAnalysis.hasAudio).toBe(true);
      expect(result.audioAnalysis.transcript).toBe('This is a test product with great features.');
      expect(result.audioAnalysis.language).toBe('en');
      expect(result.audioAnalysis.audioQuality).toBe(85);
      expect(result.audioAnalysis.productMetadata).toBeDefined();
      expect(result.audioAnalysis.productMetadata?.title).toBe('Amazing Test Product');
      expect(result.audioAnalysis.productMetadata?.bulletPoints).toHaveLength(3);
      expect(result.audioAnalysis.productMetadata?.price).toBe(29.99);
      expect(result.audioAnalysis.productMetadata?.condition).toBe('new');
    });

    it('should handle videos without audio', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(responseWithNoAudio),
        },
      });

      const result = await provider.analyzeVideo('/path/to/video.mp4');

      expect(result.audioAnalysis.hasAudio).toBe(false);
      expect(result.audioAnalysis.transcript).toBe('');
      expect(result.audioAnalysis.productMetadata).toBeUndefined();
    });

    it('should handle markdown code blocks in response', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => '```json\n' + JSON.stringify(validResponse) + '\n```',
        },
      });

      const result = await provider.analyzeVideo('/path/to/video.mp4');

      expect(result.selectedFrames).toHaveLength(1);
      expect(result.audioAnalysis.hasAudio).toBe(true);
    });

    it('should retry on failure', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce({
          response: {
            text: () => JSON.stringify(validResponse),
          },
        });

      const result = await provider.analyzeVideo('/path/to/video.mp4', {
        maxRetries: 3,
        retryDelay: 10,
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(result.selectedFrames).toHaveLength(1);
    });

    it('should throw after max retries', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await expect(
        provider.analyzeVideo('/path/to/video.mp4', {
          maxRetries: 2,
          retryDelay: 10,
        })
      ).rejects.toThrow('Unified video analysis failed after 2 attempts');
    });

    it('should throw on invalid JSON response', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => 'not valid json',
        },
      });

      await expect(
        provider.analyzeVideo('/path/to/video.mp4', {
          maxRetries: 1,
          retryDelay: 10,
        })
      ).rejects.toThrow('Failed to parse unified video analysis response');
    });

    it('should throw when response missing selected_frames', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              products_detected: [],
              video_duration_sec: 30,
              audio_analysis: { has_audio: false, transcript: '', language: '', audio_quality_0_100: 0 },
            }),
        },
      });

      await expect(
        provider.analyzeVideo('/path/to/video.mp4', {
          maxRetries: 1,
          retryDelay: 10,
        })
      ).rejects.toThrow('Response missing selected_frames array');
    });

    it('should throw when response missing audio_analysis', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              products_detected: [],
              selected_frames: [],
              video_duration_sec: 30,
            }),
        },
      });

      await expect(
        provider.analyzeVideo('/path/to/video.mp4', {
          maxRetries: 1,
          retryDelay: 10,
        })
      ).rejects.toThrow('Response missing audio_analysis object');
    });

    it('should cleanup uploaded video after analysis', async () => {
      await provider.analyzeVideo('/path/to/video.mp4');

      expect(mockDeleteFile).toHaveBeenCalledWith('test-video-123');
    });

    it('should cleanup uploaded video even on error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await expect(
        provider.analyzeVideo('/path/to/video.mp4', {
          maxRetries: 1,
          retryDelay: 10,
        })
      ).rejects.toThrow();

      expect(mockDeleteFile).toHaveBeenCalledWith('test-video-123');
    });

    it('should include default values for missing frame fields', async () => {
      const minimalResponse = {
        products_detected: [],
        selected_frames: [
          {
            timestamp_sec: 10,
            selection_reason: 'Good frame',
            product_id: 'p1',
            variant_id: 'v1',
            angle_estimate: 'front',
            quality_score_0_100: 90,
            // Missing optional fields
          },
        ],
        video_duration_sec: 60,
        frames_analyzed: 60,
        audio_analysis: {
          has_audio: false,
          transcript: '',
          language: '',
          audio_quality_0_100: 0,
        },
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(minimalResponse),
        },
      });

      const result = await provider.analyzeVideo('/path/to/video.mp4');

      expect(result.selectedFrames[0].rotationAngleDeg).toBe(0);
      expect(result.selectedFrames[0].obstructions).toBeDefined();
      expect(result.selectedFrames[0].backgroundRecommendations).toBeDefined();
    });

    it('should validate condition value', async () => {
      const responseWithInvalidCondition = {
        ...validResponse,
        audio_analysis: {
          ...validResponse.audio_analysis,
          product: {
            ...validResponse.audio_analysis.product,
            condition: 'invalid_condition',
          },
        },
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(responseWithInvalidCondition),
        },
      });

      const result = await provider.analyzeVideo('/path/to/video.mp4');

      // Invalid condition should be converted to undefined
      expect(result.audioAnalysis.productMetadata?.condition).toBeUndefined();
    });

    it('should validate dimension unit', async () => {
      const responseWithInvalidUnit = {
        ...validResponse,
        audio_analysis: {
          ...validResponse.audio_analysis,
          product: {
            ...validResponse.audio_analysis.product,
            dimensions: {
              length: 10,
              width: 5,
              height: 2,
              unit: 'invalid_unit',
            },
          },
        },
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(responseWithInvalidUnit),
        },
      });

      const result = await provider.analyzeVideo('/path/to/video.mp4');

      // Invalid unit should fallback to 'in'
      expect(result.audioAnalysis.productMetadata?.dimensions?.unit).toBe('in');
    });

    it('should validate weight unit', async () => {
      const responseWithInvalidUnit = {
        ...validResponse,
        audio_analysis: {
          ...validResponse.audio_analysis,
          product: {
            ...validResponse.audio_analysis.product,
            weight: {
              value: 1.5,
              unit: 'invalid_unit',
            },
          },
        },
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(responseWithInvalidUnit),
        },
      });

      const result = await provider.analyzeVideo('/path/to/video.mp4');

      // Invalid unit should fallback to 'lb'
      expect(result.audioAnalysis.productMetadata?.weight?.unit).toBe('lb');
    });
  });
});

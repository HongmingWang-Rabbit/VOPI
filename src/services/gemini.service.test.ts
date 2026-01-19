import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiService, type GeminiResponse, type RecommendedFrame } from './gemini.service.js';
import type { ScoredFrame } from './frame-scoring.service.js';

// Mock @google/generative-ai
const mockGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(function () {
      return {
        getGenerativeModel: vi.fn().mockReturnValue({
          generateContent: mockGenerateContent,
        }),
      };
    }),
  };
});

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake image data')),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    apis: {
      googleAi: 'test-api-key',
      geminiModel: 'gemini-2.0-flash-exp',
    },
    worker: {
      apiRetryDelayMs: 100,
    },
  })),
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

// Mock templates
vi.mock('../templates/gemini-system-prompt.js', () => ({
  GEMINI_SYSTEM_PROMPT: 'System prompt',
}));

vi.mock('../templates/gemini-output-schema.js', () => ({
  GEMINI_OUTPUT_SCHEMA: '{ schema }',
}));

import { GoogleGenerativeAI } from '@google/generative-ai';

describe('GeminiService', () => {
  let service: GeminiService;

  beforeEach(() => {
    service = new GeminiService();
    vi.clearAllMocks();
    mockGenerateContent.mockReset();
  });

  describe('init', () => {
    it('should initialize and return client', () => {
      const client = service.init();
      expect(GoogleGenerativeAI).toHaveBeenCalledWith('test-api-key');
      expect(client).toBeDefined();
    });

    it('should return same client on subsequent calls', () => {
      const client1 = service.init();
      const client2 = service.init();
      expect(client1).toBe(client2);
      expect(GoogleGenerativeAI).toHaveBeenCalledTimes(1);
    });
  });

  describe('classifyFrames', () => {
    const mockCandidate: ScoredFrame = {
      filename: 'frame_1.png',
      path: '/tmp/frame_1.png',
      index: 1,
      timestamp: 0.5,
      frameId: 'frame_00001',
      sharpness: 50,
      motion: 0.1,
      score: 45,
    };

    const mockMetadata = [
      {
        frame_id: 'frame_00001',
        timestamp_sec: 0.5,
        sequence_position: 1,
        total_candidates: 1,
      },
    ];

    const mockVideoMetadata = {
      filename: 'test.mp4',
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
    };

    it('should classify frames and return parsed response', async () => {
      const mockResponse: GeminiResponse = {
        frame_evaluation: [
          {
            frame_id: 'frame_00001',
            timestamp_sec: 0.5,
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
            description: 'Front view of product',
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
              real_life_setting: 'on a white table',
              creative_shot: 'floating with shadow',
            },
          },
        ],
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await service.classifyFrames(
        [mockCandidate],
        mockMetadata,
        mockVideoMetadata
      );

      expect(result.frame_evaluation).toHaveLength(1);
      expect(result.frame_evaluation[0].frame_id).toBe('frame_00001');
      expect(result.variants_discovered).toHaveLength(1);
    });

    it('should handle markdown code blocks in response', async () => {
      const mockResponse: GeminiResponse = {
        frame_evaluation: [
          {
            frame_id: 'frame_00001',
            timestamp_sec: 0.5,
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
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => '```json\n' + JSON.stringify(mockResponse) + '\n```',
        },
      });

      const result = await service.classifyFrames(
        [mockCandidate],
        mockMetadata,
        mockVideoMetadata
      );

      expect(result.frame_evaluation).toHaveLength(1);
    });

    it('should retry on failure', async () => {
      const mockResponse: GeminiResponse = {
        frame_evaluation: [
          {
            frame_id: 'frame_00001',
            timestamp_sec: 0.5,
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
      };

      mockGenerateContent
        .mockRejectedValueOnce(new Error('Rate limited'))
        .mockResolvedValueOnce({
          response: {
            text: () => JSON.stringify(mockResponse),
          },
        });

      const result = await service.classifyFrames(
        [mockCandidate],
        mockMetadata,
        mockVideoMetadata,
        { maxRetries: 2, retryDelay: 10 }
      );

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(result.frame_evaluation).toHaveLength(1);
    });

    it('should throw after max retries exhausted', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await expect(
        service.classifyFrames([mockCandidate], mockMetadata, mockVideoMetadata, {
          maxRetries: 2,
          retryDelay: 10,
        })
      ).rejects.toThrow('Classification failed after 2 attempts');
    });

    it('should throw when response missing frame_evaluation', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({ video: {} }),
        },
      });

      await expect(
        service.classifyFrames([mockCandidate], mockMetadata, mockVideoMetadata, {
          maxRetries: 1,
        })
      ).rejects.toThrow('Response missing frame_evaluation array');
    });

    it('should throw when response is not valid JSON', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => 'not valid json',
        },
      });

      await expect(
        service.classifyFrames([mockCandidate], mockMetadata, mockVideoMetadata, {
          maxRetries: 1,
        })
      ).rejects.toThrow('Failed to parse response as JSON');
    });
  });

  describe('getRecommendedFrames', () => {
    const mockCandidate: ScoredFrame = {
      filename: 'frame_1.png',
      path: '/tmp/frame_1.png',
      index: 1,
      timestamp: 0.5,
      frameId: 'frame_00001',
      sharpness: 50,
      motion: 0.1,
      score: 45,
    };

    it('should extract recommended frames from variants_discovered', () => {
      const geminiResult: GeminiResponse = {
        frame_evaluation: [
          {
            frame_id: 'frame_00001',
            timestamp_sec: 0.5,
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
      };

      const recommended = service.getRecommendedFrames(geminiResult, [mockCandidate]);

      expect(recommended).toHaveLength(1);
      expect(recommended[0].productId).toBe('product_1');
      expect(recommended[0].variantId).toBe('front_view');
      expect(recommended[0].angleEstimate).toBe('front');
      expect(recommended[0].geminiScore).toBe(85);
      expect(recommended[0].frameId).toBe('frame_00001');
    });

    it('should fallback to frame_evaluation when variants_discovered is empty', () => {
      const geminiResult: GeminiResponse = {
        frame_evaluation: [
          {
            frame_id: 'frame_00001',
            timestamp_sec: 0.5,
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
        variants_discovered: [],
      };

      const recommended = service.getRecommendedFrames(geminiResult, [mockCandidate]);

      expect(recommended).toHaveLength(1);
      expect(recommended[0].variantId).toBe('front_view');
    });

    it('should skip variants without best_frame_id', () => {
      const geminiResult: GeminiResponse = {
        frame_evaluation: [],
        variants_discovered: [
          {
            product_id: 'product_1',
            variant_id: 'front_view',
            angle_estimate: 'front',
            description: 'Front view',
            best_frame_id: '',
            best_frame_score: 85,
            all_frame_ids: [],
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
      };

      const recommended = service.getRecommendedFrames(geminiResult, [mockCandidate]);

      expect(recommended).toHaveLength(0);
    });

    it('should skip when candidate not found', () => {
      const geminiResult: GeminiResponse = {
        frame_evaluation: [],
        variants_discovered: [
          {
            product_id: 'product_1',
            variant_id: 'front_view',
            angle_estimate: 'front',
            description: 'Front view',
            best_frame_id: 'frame_99999',
            best_frame_score: 85,
            all_frame_ids: ['frame_99999'],
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
      };

      const recommended = service.getRecommendedFrames(geminiResult, [mockCandidate]);

      expect(recommended).toHaveLength(0);
    });

    it('should include obstruction info', () => {
      const geminiResult: GeminiResponse = {
        frame_evaluation: [
          {
            frame_id: 'frame_00001',
            timestamp_sec: 0.5,
            product_id: 'product_1',
            variant_id: 'front_view',
            angle_estimate: 'front',
            quality_score_0_100: 85,
            similarity_note: 'Has hand',
            obstructions: {
              has_obstruction: true,
              obstruction_types: ['hand'],
              obstruction_description: 'Hand visible',
              removable_by_ai: true,
            },
          },
        ],
        variants_discovered: [
          {
            product_id: 'product_1',
            variant_id: 'front_view',
            angle_estimate: 'front',
            description: 'Front view with hand',
            best_frame_id: 'frame_00001',
            best_frame_score: 85,
            all_frame_ids: ['frame_00001'],
            obstructions: {
              has_obstruction: true,
              obstruction_types: ['hand'],
              obstruction_description: 'Hand visible',
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
      };

      const recommended = service.getRecommendedFrames(geminiResult, [mockCandidate]);

      expect(recommended[0].obstructions.has_obstruction).toBe(true);
      expect(recommended[0].obstructions.obstruction_types).toContain('hand');
    });
  });
});

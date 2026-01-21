import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClassificationProvider } from './gemini-classification.provider.js';

// Mock gemini service
vi.mock('../../services/gemini.service.js', () => ({
  geminiService: {
    classifyFrames: vi.fn(),
    getRecommendedFrames: vi.fn(),
  },
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
}));

import { geminiService } from '../../services/gemini.service.js';
import { getConfig } from '../../config/index.js';

describe('GeminiClassificationProvider', () => {
  let provider: GeminiClassificationProvider;

  const mockFrames = [
    { frameId: 'frame_001', path: '/tmp/frame_001.png', timestamp: 0 },
    { frameId: 'frame_002', path: '/tmp/frame_002.png', timestamp: 1 },
  ];

  const mockMetadata = [
    { frame_id: 'frame_001', timestamp_sec: 0, sequence_position: 1, total_candidates: 2 },
    { frame_id: 'frame_002', timestamp_sec: 1, sequence_position: 2, total_candidates: 2 },
  ];

  const mockVideoMetadata = {
    duration: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    filename: 'test.mp4',
  };

  const mockGeminiResult = {
    products_detected: [
      {
        product_id: 'product_1',
        description: 'A red sneaker',
        product_category: 'footwear',
      },
    ],
    frame_evaluation: [
      {
        frame_id: 'frame_001',
        timestamp_sec: 0,
        product_id: 'product_1',
        variant_id: 'front_view',
        angle_estimate: 'front',
        quality_score_0_100: 85,
        similarity_note: 'Clear shot',
        rotation_angle_deg: 5,
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
        description: 'Front view of sneaker',
        best_frame_id: 'frame_001',
        best_frame_score: 85,
        all_frame_ids: ['frame_001'],
        obstructions: {
          has_obstruction: false,
          obstruction_types: [],
          obstruction_description: null,
          removable_by_ai: true,
        },
        background_recommendations: {
          solid_color: '#FFFFFF',
          solid_color_name: 'white',
          real_life_setting: 'on a shelf',
          creative_shot: 'floating',
        },
      },
    ],
  };

  const mockRecommendedFrames = [
    {
      frameId: 'frame_001',
      filename: 'frame_001.png',
      path: '/tmp/frame_001.png',
      index: 0,
      timestamp: 0,
      sharpness: 50,
      motion: 0.1,
      score: 45,
      productId: 'product_1',
      variantId: 'front_view',
      angleEstimate: 'front',
      recommendedType: 'product_1_front_view',
      geminiScore: 85,
      rotationAngleDeg: 5,
      variantDescription: 'Front view of sneaker',
      allFrameIds: ['frame_001'],
      obstructions: {
        has_obstruction: false,
        obstruction_types: [],
        obstruction_description: null,
        removable_by_ai: true,
      },
      backgroundRecommendations: {
        solid_color: '#FFFFFF',
        solid_color_name: 'white',
        real_life_setting: 'on a shelf',
        creative_shot: 'floating',
      },
    },
  ];

  beforeEach(() => {
    provider = new GeminiClassificationProvider();
    vi.clearAllMocks();

    vi.mocked(geminiService.classifyFrames).mockResolvedValue(mockGeminiResult);
    vi.mocked(geminiService.getRecommendedFrames).mockReturnValue(mockRecommendedFrames);
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('gemini');
    });
  });

  describe('isAvailable', () => {
    it('should return true when Google AI API key is configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { googleAi: 'test-api-key' },
      } as ReturnType<typeof getConfig>);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when Google AI API key is not configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { googleAi: '' },
      } as ReturnType<typeof getConfig>);

      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false when config throws', () => {
      vi.mocked(getConfig).mockImplementation(() => {
        throw new Error('Config error');
      });

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('classifyFrames', () => {
    it('should classify frames and return results', async () => {
      const result = await provider.classifyFrames(
        mockFrames,
        mockMetadata,
        mockVideoMetadata
      );

      expect(result.products).toHaveLength(1);
      expect(result.products[0]).toEqual({
        productId: 'product_1',
        description: 'A red sneaker',
        category: 'footwear',
      });

      expect(result.classifiedFrames).toHaveLength(1);
      expect(result.classifiedFrames[0]).toEqual({
        frameId: 'frame_001',
        productId: 'product_1',
        variantId: 'front_view',
        angleEstimate: 'front',
        qualityScore: 85,
        rotationAngleDeg: 5,
        variantDescription: 'Front view of sneaker',
        allFrameIds: ['frame_001'],
        obstructions: expect.any(Object),
        backgroundRecommendations: expect.any(Object),
      });

      expect(result.rawResponse).toBe(mockGeminiResult);
    });

    it('should pass options to gemini service', async () => {
      await provider.classifyFrames(
        mockFrames,
        mockMetadata,
        mockVideoMetadata,
        {
          model: 'gemini-2.0-flash',
          maxRetries: 5,
          retryDelay: 2000,
        }
      );

      expect(geminiService.classifyFrames).toHaveBeenCalledWith(
        expect.any(Array),
        mockMetadata,
        mockVideoMetadata,
        {
          model: 'gemini-2.0-flash',
          maxRetries: 5,
          retryDelay: 2000,
        }
      );
    });

    it('should convert frames to scored frame format for gemini service', async () => {
      await provider.classifyFrames(mockFrames, mockMetadata, mockVideoMetadata);

      expect(geminiService.classifyFrames).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            frameId: 'frame_001',
            path: '/tmp/frame_001.png',
            timestamp: 0,
            sharpness: 0,
            motion: 0,
            score: 0,
          }),
        ]),
        mockMetadata,
        mockVideoMetadata,
        expect.any(Object)
      );
    });

    it('should handle empty products array', async () => {
      vi.mocked(geminiService.classifyFrames).mockResolvedValue({
        ...mockGeminiResult,
        products_detected: undefined,
      });

      const result = await provider.classifyFrames(
        mockFrames,
        mockMetadata,
        mockVideoMetadata
      );

      expect(result.products).toEqual([]);
    });

    it('should handle empty recommended frames', async () => {
      vi.mocked(geminiService.getRecommendedFrames).mockReturnValue([]);

      const result = await provider.classifyFrames(
        mockFrames,
        mockMetadata,
        mockVideoMetadata
      );

      expect(result.classifiedFrames).toEqual([]);
    });
  });
});

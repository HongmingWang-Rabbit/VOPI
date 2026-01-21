import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhotoroomCommercialImageProvider } from './photoroom-commercial-image.provider.js';

// Mock photoroom service
vi.mock('../../services/photoroom.service.js', () => ({
  photoroomService: {
    generateWithSolidBackground: vi.fn(),
    generateWithAIBackground: vi.fn(),
    generateAllVersions: vi.fn(),
  },
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
}));

import { photoroomService } from '../../services/photoroom.service.js';
import { getConfig } from '../../config/index.js';

describe('PhotoroomCommercialImageProvider', () => {
  let provider: PhotoroomCommercialImageProvider;

  beforeEach(() => {
    provider = new PhotoroomCommercialImageProvider();
    vi.clearAllMocks();

    vi.mocked(photoroomService.generateWithSolidBackground).mockResolvedValue({
      success: true,
      outputPath: '/output/solid.png',
      size: 1024,
      method: 'solid',
      bgColor: '#FFFFFF',
    });

    vi.mocked(photoroomService.generateWithAIBackground).mockResolvedValue({
      success: true,
      outputPath: '/output/ai.png',
      size: 2048,
      method: 'ai',
      bgPrompt: 'on a wooden table',
    });

    vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
      frameId: 'frame_001',
      recommendedType: 'product_front',
      versions: {
        transparent: { success: true, outputPath: '/output/transparent.png' },
        solid: { success: true, outputPath: '/output/solid.png', bgColor: '#FFFFFF' },
        real: { success: true, outputPath: '/output/real.png', bgPrompt: 'on a shelf' },
        creative: { success: true, outputPath: '/output/creative.png', bgPrompt: 'floating' },
      },
    });
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('photoroom');
    });
  });

  describe('isAvailable', () => {
    it('should return true when Photoroom API key is configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { photoroom: 'test-api-key' },
      } as ReturnType<typeof getConfig>);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when Photoroom API key is not configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { photoroom: '' },
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

  describe('generateWithSolidBackground', () => {
    it('should generate image with solid background', async () => {
      const result = await provider.generateWithSolidBackground(
        '/input/image.png',
        '/output/solid.png',
        '#FF0000'
      );

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output/solid.png');
      expect(photoroomService.generateWithSolidBackground).toHaveBeenCalledWith(
        '/input/image.png',
        '/output/solid.png',
        '#FF0000'
      );
    });

    it('should handle failure result', async () => {
      vi.mocked(photoroomService.generateWithSolidBackground).mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const result = await provider.generateWithSolidBackground(
        '/input/image.png',
        '/output/solid.png',
        '#FF0000'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });
  });

  describe('generateWithAIBackground', () => {
    it('should generate image with AI background', async () => {
      const result = await provider.generateWithAIBackground(
        '/input/image.png',
        '/output/ai.png',
        'on a wooden table'
      );

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output/ai.png');
      expect(photoroomService.generateWithAIBackground).toHaveBeenCalledWith(
        '/input/image.png',
        '/output/ai.png',
        'on a wooden table'
      );
    });

    it('should handle failure result', async () => {
      vi.mocked(photoroomService.generateWithAIBackground).mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const result = await provider.generateWithAIBackground(
        '/input/image.png',
        '/output/ai.png',
        'on a table'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });
  });

  describe('generateAllVersions', () => {
    it('should generate all commercial image versions', async () => {
      const result = await provider.generateAllVersions(
        '/input/image.png',
        '/output',
        'product_front'
      );

      expect(result.frameId).toBe('product_front');
      expect(result.recommendedType).toBe('product_front');
      expect(result.versions.transparent?.success).toBe(true);
      expect(result.versions.solid?.success).toBe(true);
      expect(result.versions.real?.success).toBe(true);
      expect(result.versions.creative?.success).toBe(true);
    });

    it('should pass custom versions to photoroom service', async () => {
      await provider.generateAllVersions(
        '/input/image.png',
        '/output',
        'product_front',
        { versions: ['transparent', 'solid'] }
      );

      expect(photoroomService.generateAllVersions).toHaveBeenCalledWith(
        expect.any(Object),
        '/output',
        expect.objectContaining({
          versions: ['transparent', 'solid'],
        })
      );
    });

    it('should pass transparentSource option', async () => {
      await provider.generateAllVersions(
        '/input/image.png',
        '/output',
        'product_front',
        { transparentSource: '/extracted/product.png', skipTransparent: true }
      );

      expect(photoroomService.generateAllVersions).toHaveBeenCalledWith(
        expect.any(Object),
        '/output',
        expect.objectContaining({
          transparentSource: '/extracted/product.png',
          skipTransparent: true,
        })
      );
    });

    it('should pass background recommendations', async () => {
      const bgRecommendations = {
        solid_color: '#000000',
        solid_color_name: 'black',
        real_life_setting: 'on a dark shelf',
        creative_shot: 'with dramatic lighting',
      };

      await provider.generateAllVersions(
        '/input/image.png',
        '/output',
        'product_front',
        { backgroundRecommendations: bgRecommendations }
      );

      expect(photoroomService.generateAllVersions).toHaveBeenCalledWith(
        expect.objectContaining({
          backgroundRecommendations: bgRecommendations,
        }),
        '/output',
        expect.any(Object)
      );
    });

    it('should use default background recommendations when not provided', async () => {
      await provider.generateAllVersions(
        '/input/image.png',
        '/output',
        'product_front'
      );

      expect(photoroomService.generateAllVersions).toHaveBeenCalledWith(
        expect.objectContaining({
          backgroundRecommendations: expect.objectContaining({
            solid_color: '#FFFFFF',
            solid_color_name: 'white',
          }),
        }),
        '/output',
        expect.any(Object)
      );
    });

    it('should convert version results to provider format', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'product_front',
        versions: {
          solid: {
            success: true,
            outputPath: '/output/solid.png',
            size: 1024,
            method: 'solid',
            bgColor: '#FFFFFF',
          },
        },
      });

      const result = await provider.generateAllVersions(
        '/input/image.png',
        '/output',
        'product_front',
        { versions: ['solid'] }
      );

      expect(result.versions.solid).toEqual({
        success: true,
        outputPath: '/output/solid.png',
        size: 1024,
        method: 'solid',
        backgroundColor: '#FFFFFF',
        backgroundPrompt: undefined,
        error: undefined,
      });
    });

    it('should handle partial failures', async () => {
      vi.mocked(photoroomService.generateAllVersions).mockResolvedValue({
        frameId: 'frame_001',
        recommendedType: 'product_front',
        versions: {
          transparent: { success: true, outputPath: '/output/transparent.png' },
          solid: { success: false, error: 'Generation failed' },
        },
      });

      const result = await provider.generateAllVersions(
        '/input/image.png',
        '/output',
        'product_front',
        { versions: ['transparent', 'solid'] }
      );

      expect(result.versions.transparent?.success).toBe(true);
      expect(result.versions.solid?.success).toBe(false);
      expect(result.versions.solid?.error).toBe('Generation failed');
    });
  });
});

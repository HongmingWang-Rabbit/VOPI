import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhotoroomBackgroundRemovalProvider } from './photoroom-background-removal.provider.js';

// Mock photoroom service
vi.mock('../../services/photoroom.service.js', () => ({
  photoroomService: {
    removeBackground: vi.fn(),
    editImageWithAI: vi.fn(),
  },
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
}));

import { photoroomService } from '../../services/photoroom.service.js';
import { getConfig } from '../../config/index.js';

describe('PhotoroomBackgroundRemovalProvider', () => {
  let provider: PhotoroomBackgroundRemovalProvider;

  beforeEach(() => {
    provider = new PhotoroomBackgroundRemovalProvider();
    vi.clearAllMocks();

    vi.mocked(photoroomService.removeBackground).mockResolvedValue({
      success: true,
      outputPath: '/output/transparent.png',
    });

    vi.mocked(photoroomService.editImageWithAI).mockResolvedValue({
      success: true,
      outputPath: '/output/edited.png',
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

  describe('removeBackground', () => {
    it('should remove background without AI edit by default', async () => {
      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output/transparent.png');
      expect(photoroomService.removeBackground).toHaveBeenCalledWith(
        '/input/image.png',
        '/output/transparent.png'
      );
      expect(photoroomService.editImageWithAI).not.toHaveBeenCalled();
    });

    it('should use AI edit when obstructions are present', async () => {
      const obstructions = {
        has_obstruction: true,
        obstruction_types: ['hand'],
        obstruction_description: 'Hand holding product',
        removable_by_ai: true,
      };

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { useAIEdit: true, obstructions }
      );

      expect(result.success).toBe(true);
      expect(photoroomService.editImageWithAI).toHaveBeenCalledWith(
        '/input/image.png',
        '/output/transparent.png',
        { obstructions, customPrompt: undefined }
      );
      expect(photoroomService.removeBackground).not.toHaveBeenCalled();
    });

    it('should use AI edit with custom prompt', async () => {
      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { useAIEdit: true, customPrompt: 'Remove the background and hand' }
      );

      expect(result.success).toBe(true);
      expect(photoroomService.editImageWithAI).toHaveBeenCalledWith(
        '/input/image.png',
        '/output/transparent.png',
        { obstructions: undefined, customPrompt: 'Remove the background and hand' }
      );
    });

    it('should not use AI edit when useAIEdit is false even with obstructions', async () => {
      const obstructions = {
        has_obstruction: true,
        obstruction_types: ['hand'],
        obstruction_description: 'Hand holding product',
        removable_by_ai: true,
      };

      await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { useAIEdit: false, obstructions }
      );

      expect(photoroomService.removeBackground).toHaveBeenCalled();
      expect(photoroomService.editImageWithAI).not.toHaveBeenCalled();
    });

    it('should not use AI edit when no obstructions and no custom prompt', async () => {
      await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { useAIEdit: true }
      );

      expect(photoroomService.removeBackground).toHaveBeenCalled();
      expect(photoroomService.editImageWithAI).not.toHaveBeenCalled();
    });

    it('should handle failure result', async () => {
      vi.mocked(photoroomService.removeBackground).mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });
  });
});

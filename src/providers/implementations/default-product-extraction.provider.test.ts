import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultProductExtractionProvider } from './default-product-extraction.provider.js';
import type { BackgroundRemovalProvider } from '../interfaces/background-removal.provider.js';
import type { ImageTransformProvider } from '../interfaces/image-transform.provider.js';
import type { ExtractionFrame } from '../interfaces/product-extraction.provider.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock sharp (for the direct import in the provider when rotation is skipped)
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('test-image')),
  })),
}));

import { writeFile, unlink } from 'fs/promises';

describe('DefaultProductExtractionProvider', () => {
  let provider: DefaultProductExtractionProvider;
  let mockBgRemovalProvider: BackgroundRemovalProvider;
  let mockImageTransformProvider: ImageTransformProvider;

  const mockFrame: ExtractionFrame = {
    frameId: 'frame_001',
    path: '/input/frame.png',
    rotationAngleDeg: 5,
    recommendedType: 'product_front',
    obstructions: {
      has_obstruction: false,
      obstruction_types: [],
      obstruction_description: null,
      removable_by_ai: true,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock providers
    mockBgRemovalProvider = {
      providerId: 'mock-bg',
      removeBackground: vi.fn().mockResolvedValue({
        success: true,
        outputPath: '/tmp/transparent.png',
      }),
      isAvailable: vi.fn().mockReturnValue(true),
    };

    mockImageTransformProvider = {
      providerId: 'mock-transform',
      getDimensions: vi.fn().mockResolvedValue({ width: 1000, height: 800 }),
      rotate: vi.fn().mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('rotated-image'),
        dimensions: { width: 1020, height: 820 },
      }),
      crop: vi.fn().mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('cropped-image'),
        dimensions: { width: 500, height: 400 },
      }),
      centerOnCanvas: vi.fn().mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('final-image'),
        dimensions: { width: 550, height: 550 },
      }),
      findContentBounds: vi.fn().mockResolvedValue({
        x: 100,
        y: 100,
        width: 500,
        height: 400,
      }),
      isAvailable: vi.fn().mockReturnValue(true),
    };

    provider = new DefaultProductExtractionProvider(
      mockBgRemovalProvider,
      mockImageTransformProvider
    );
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('default');
    });
  });

  describe('isAvailable', () => {
    it('should return true when both providers are available', () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when background removal provider is unavailable', () => {
      vi.mocked(mockBgRemovalProvider.isAvailable).mockReturnValue(false);
      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false when image transform provider is unavailable', () => {
      vi.mocked(mockImageTransformProvider.isAvailable).mockReturnValue(false);
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('extractProduct', () => {
    it('should complete full extraction pipeline', async () => {
      const result = await provider.extractProduct(mockFrame, '/output');

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output/product_front_frame_001_extracted.png');
      expect(result.rotationApplied).toBe(5);
      expect(result.boundingBox).toEqual({ x: 100, y: 100, width: 500, height: 400 });
      expect(result.originalSize).toEqual({ width: 1000, height: 800 });
      expect(result.finalSize).toEqual({ width: 550, height: 550 });
    });

    it('should call background removal first', async () => {
      await provider.extractProduct(mockFrame, '/output');

      expect(mockBgRemovalProvider.removeBackground).toHaveBeenCalledWith(
        '/input/frame.png',
        '/output/product_front_frame_001_temp_transparent.png',
        { useAIEdit: false, obstructions: mockFrame.obstructions }
      );
    });

    it('should use AI edit when frame has obstructions and useAIEdit is enabled', async () => {
      const frameWithObstructions: ExtractionFrame = {
        ...mockFrame,
        obstructions: {
          has_obstruction: true,
          obstruction_types: ['hand'],
          obstruction_description: 'Hand visible',
          removable_by_ai: true,
        },
      };

      await provider.extractProduct(frameWithObstructions, '/output', { useAIEdit: true });

      expect(mockBgRemovalProvider.removeBackground).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ useAIEdit: true })
      );
    });

    it('should skip rotation for angles below threshold', async () => {
      const frameNoRotation: ExtractionFrame = {
        ...mockFrame,
        rotationAngleDeg: 0.3, // Below 0.5 threshold
      };

      const result = await provider.extractProduct(frameNoRotation, '/output');

      expect(result.success).toBe(true);
      expect(mockImageTransformProvider.rotate).not.toHaveBeenCalled();
    });

    it('should apply rotation for angles above threshold', async () => {
      await provider.extractProduct(mockFrame, '/output');

      expect(mockImageTransformProvider.rotate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          angle: 5,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
      );
    });

    it('should crop to bounding box', async () => {
      await provider.extractProduct(mockFrame, '/output');

      expect(mockImageTransformProvider.crop).toHaveBeenCalledWith(
        expect.any(Buffer),
        { region: { x: 100, y: 100, width: 500, height: 400 } }
      );
    });

    it('should center on square canvas with padding', async () => {
      await provider.extractProduct(mockFrame, '/output');

      // maxDim = 500 (width), padding = 500 * 0.05 = 25
      // targetSize = max(500 + 50, 512) = 550
      expect(mockImageTransformProvider.centerOnCanvas).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          canvasSize: 550,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
      );
    });

    it('should use minimum output size when product is small', async () => {
      vi.mocked(mockImageTransformProvider.findContentBounds).mockResolvedValue({
        x: 400,
        y: 400,
        width: 100,
        height: 100,
      });
      vi.mocked(mockImageTransformProvider.crop).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('cropped'),
        dimensions: { width: 100, height: 100 },
      });

      await provider.extractProduct(mockFrame, '/output');

      // maxDim = 100, padding = 5, but minOutputSize = 512
      expect(mockImageTransformProvider.centerOnCanvas).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ canvasSize: 512 })
      );
    });

    it('should write final output to file', async () => {
      await provider.extractProduct(mockFrame, '/output');

      expect(writeFile).toHaveBeenCalledWith(
        '/output/product_front_frame_001_extracted.png',
        expect.any(Buffer)
      );
    });

    it('should cleanup temp file on success', async () => {
      await provider.extractProduct(mockFrame, '/output');

      expect(unlink).toHaveBeenCalledWith(
        '/output/product_front_frame_001_temp_transparent.png'
      );
    });

    it('should cleanup temp file on failure', async () => {
      vi.mocked(mockImageTransformProvider.rotate).mockResolvedValue({
        success: false,
        error: 'Rotation failed',
      });

      const result = await provider.extractProduct(mockFrame, '/output');

      expect(result.success).toBe(false);
      expect(unlink).toHaveBeenCalled();
    });

    it('should handle background removal failure', async () => {
      vi.mocked(mockBgRemovalProvider.removeBackground).mockResolvedValue({
        success: false,
        error: 'Background removal failed',
      });

      const result = await provider.extractProduct(mockFrame, '/output');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Background removal failed');
    });

    it('should handle rotation failure', async () => {
      vi.mocked(mockImageTransformProvider.rotate).mockResolvedValue({
        success: false,
        error: 'Rotation failed',
      });

      const result = await provider.extractProduct(mockFrame, '/output');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Rotation failed');
    });

    it('should handle crop failure', async () => {
      vi.mocked(mockImageTransformProvider.crop).mockResolvedValue({
        success: false,
        error: 'Crop failed',
      });

      const result = await provider.extractProduct(mockFrame, '/output');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Crop failed');
    });

    it('should handle centering failure', async () => {
      vi.mocked(mockImageTransformProvider.centerOnCanvas).mockResolvedValue({
        success: false,
        error: 'Centering failed',
      });

      const result = await provider.extractProduct(mockFrame, '/output');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Centering failed');
    });

    it('should use full image when bounding box not found', async () => {
      vi.mocked(mockImageTransformProvider.findContentBounds).mockResolvedValue(null);

      const result = await provider.extractProduct(mockFrame, '/output');

      expect(result.success).toBe(true);
      expect(result.boundingBox).toBeUndefined();
      expect(mockImageTransformProvider.crop).not.toHaveBeenCalled();
      expect(mockImageTransformProvider.centerOnCanvas).not.toHaveBeenCalled();
    });

    it('should accept custom padding option', async () => {
      await provider.extractProduct(mockFrame, '/output', { padding: 0.1 });

      // maxDim = 500, padding = 500 * 0.1 = 50
      // targetSize = max(500 + 100, 512) = 600
      expect(mockImageTransformProvider.centerOnCanvas).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ canvasSize: 600 })
      );
    });

    it('should accept custom minOutputSize option', async () => {
      vi.mocked(mockImageTransformProvider.findContentBounds).mockResolvedValue({
        x: 400,
        y: 400,
        width: 100,
        height: 100,
      });
      vi.mocked(mockImageTransformProvider.crop).mockResolvedValue({
        success: true,
        outputBuffer: Buffer.from('cropped'),
        dimensions: { width: 100, height: 100 },
      });

      await provider.extractProduct(mockFrame, '/output', { minOutputSize: 1024 });

      expect(mockImageTransformProvider.centerOnCanvas).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ canvasSize: 1024 })
      );
    });

    it('should accept custom alphaThreshold option', async () => {
      await provider.extractProduct(mockFrame, '/output', { alphaThreshold: 50 });

      expect(mockImageTransformProvider.findContentBounds).toHaveBeenCalledWith(
        expect.any(Buffer),
        50
      );
    });

    it('should use default alphaThreshold when not specified', async () => {
      await provider.extractProduct(mockFrame, '/output');

      // Default alpha threshold is 10
      expect(mockImageTransformProvider.findContentBounds).toHaveBeenCalledWith(
        expect.any(Buffer),
        10
      );
    });
  });

  describe('extractProducts', () => {
    const frames: ExtractionFrame[] = [
      { ...mockFrame, frameId: 'frame_001' },
      { ...mockFrame, frameId: 'frame_002' },
      { ...mockFrame, frameId: 'frame_003' },
    ];

    it('should extract products from multiple frames', async () => {
      const results = await provider.extractProducts(frames, '/output');

      expect(results.size).toBe(3);
      expect(results.get('frame_001')?.success).toBe(true);
      expect(results.get('frame_002')?.success).toBe(true);
      expect(results.get('frame_003')?.success).toBe(true);
    });

    it('should call progress callback', async () => {
      const onProgress = vi.fn();

      await provider.extractProducts(frames, '/output', { onProgress });

      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenNthCalledWith(1, 1, 3);
      expect(onProgress).toHaveBeenNthCalledWith(2, 2, 3);
      expect(onProgress).toHaveBeenNthCalledWith(3, 3, 3);
    });

    it('should continue processing after individual failure', async () => {
      vi.mocked(mockBgRemovalProvider.removeBackground)
        .mockResolvedValueOnce({ success: true, outputPath: '/tmp/t1.png' })
        .mockResolvedValueOnce({ success: false, error: 'API error' })
        .mockResolvedValueOnce({ success: true, outputPath: '/tmp/t3.png' });

      const results = await provider.extractProducts(frames, '/output');

      expect(results.size).toBe(3);
      expect(results.get('frame_001')?.success).toBe(true);
      expect(results.get('frame_002')?.success).toBe(false);
      expect(results.get('frame_003')?.success).toBe(true);
    });

    it('should pass options to individual extractions', async () => {
      const framesWithObstructions: ExtractionFrame[] = [
        {
          ...mockFrame,
          obstructions: {
            has_obstruction: true,
            obstruction_types: ['hand'],
            obstruction_description: 'Hand',
            removable_by_ai: true,
          },
        },
      ];

      await provider.extractProducts(framesWithObstructions, '/output', { useAIEdit: true });

      expect(mockBgRemovalProvider.removeBackground).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ useAIEdit: true })
      );
    });
  });
});

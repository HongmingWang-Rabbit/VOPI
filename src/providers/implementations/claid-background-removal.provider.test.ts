import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
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

// Mock photoroom service for inpainting
vi.mock('../../services/photoroom.service.js', () => ({
  photoroomService: {
    inpaintHoles: vi.fn(),
  },
}));

// Mock s3-presign utilities
vi.mock('../../utils/s3-presign.js', () => ({
  isLocalS3: vi.fn(),
  getPresignedImageUrl: vi.fn(),
  cleanupTempS3File: vi.fn(),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { ClaidBackgroundRemovalProvider } from './claid-background-removal.provider.js';
import { readFile, writeFile } from 'fs/promises';
import { getConfig } from '../../config/index.js';
import { photoroomService } from '../../services/photoroom.service.js';
import { isLocalS3, getPresignedImageUrl, cleanupTempS3File } from '../../utils/s3-presign.js';

describe('ClaidBackgroundRemovalProvider', () => {
  let provider: ClaidBackgroundRemovalProvider;

  const mockImageBuffer = Buffer.from('fake-image-data');
  const mockResultData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const mockResultArrayBuffer = mockResultData.buffer;

  beforeEach(() => {
    provider = new ClaidBackgroundRemovalProvider();
    vi.clearAllMocks();

    // Default config mock
    vi.mocked(getConfig).mockReturnValue({
      apis: { claid: 'test-api-key' },
      storage: { endpoint: 'http://localhost:9000' },
    } as ReturnType<typeof getConfig>);

    // Default file read mock
    vi.mocked(readFile).mockResolvedValue(mockImageBuffer);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    // Default s3-presign mocks - use local mode by default (simpler to test)
    vi.mocked(isLocalS3).mockReturnValue(true);
    vi.mocked(getPresignedImageUrl).mockResolvedValue({
      url: 'https://s3.example.com/bucket/temp/test.jpg?signature=xxx',
      tempKey: 'temp/claid/uuid-test.jpg',
    });
    vi.mocked(cleanupTempS3File).mockResolvedValue(undefined);
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('claid');
    });
  });

  describe('isAvailable', () => {
    it('should return true when Claid API key is configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { claid: 'test-api-key' },
        storage: { endpoint: 'http://localhost:9000' },
      } as ReturnType<typeof getConfig>);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when Claid API key is not configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { claid: undefined },
        storage: { endpoint: 'http://localhost:9000' },
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
    it('should return error when API key is not configured', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { claid: undefined },
        storage: { endpoint: 'http://localhost:9000' },
      } as ReturnType<typeof getConfig>);

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claid API key not configured');
    });

    it('should remove background successfully', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      // Mock API response
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: {
              output: {
                tmp_url: mockTmpUrl,
              },
            },
          }),
        })
        // Mock image download
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output/transparent.png');
      expect(result.method).toBe('claid-selective');
      expect(result.size).toBe(mockResultData.length);

      // Verify multipart upload API was called (localhost triggers multipart mode)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.claid.ai/v1/image/edit/upload',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-api-key',
          },
        })
      );

      // Verify request body is FormData with correct operations
      const fetchCall = mockFetch.mock.calls[0];
      const formData = fetchCall[1].body as FormData;
      expect(formData).toBeInstanceOf(FormData);
      const dataField = formData.get('data') as string;
      const operations = JSON.parse(dataField);
      expect(operations.operations.background.remove.selective.object_to_keep).toBe('product');
      expect(operations.operations.background.remove.clipping).toBe(true);
      expect(operations.operations.background.color).toBe('transparent');

      // Verify file was written
      expect(writeFile).toHaveBeenCalledWith('/output/transparent.png', expect.any(Buffer));
    });

    it('should use custom prompt as object_to_keep', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { customPrompt: 'red sneaker' }
      );

      const fetchCall = mockFetch.mock.calls[0];
      const formData = fetchCall[1].body as FormData;
      const dataField = formData.get('data') as string;
      const operations = JSON.parse(dataField);
      expect(operations.operations.background.remove.selective.object_to_keep).toBe('red sneaker');
    });

    it('should use presigned URL mode in production (non-localhost S3)', async () => {
      // Configure production mode (non-localhost S3)
      vi.mocked(isLocalS3).mockReturnValue(false);

      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);

      // Verify presigned URL was obtained
      expect(getPresignedImageUrl).toHaveBeenCalledWith('/input/image.png', 'temp/claid');

      // Verify JSON API was called (not multipart)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.claid.ai/v1/image/edit',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );

      // Verify cleanup
      expect(cleanupTempS3File).toHaveBeenCalledWith('temp/claid/uuid-test.jpg');
    });

    it('should handle API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: vi.fn().mockResolvedValue({
          error: {
            type: 'validation_error',
            message: 'Invalid image format',
          },
        }),
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid image format');
    });

    it('should retry on rate limit (429)', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        // First call - rate limited
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: vi.fn().mockResolvedValue({
            error: { message: 'Rate limit exceeded' },
          }),
        })
        // Second call - success
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        // Download
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3); // 2 API calls + 1 download
    });

    it('should retry on server error (500)', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        // First call - server error
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: vi.fn().mockResolvedValue({
            error: { message: 'Internal server error' },
          }),
        })
        // Second call - success
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        // Download
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);
    });

    it('should fail after max retries', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValue({
          error: { message: 'Internal server error' },
        }),
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Internal server error');
      expect(mockFetch).toHaveBeenCalledTimes(3); // Max retries
    });

    it('should handle missing output URL in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: {},
        }),
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No output URL');
    });

    it('should handle download failure', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to download');
    });

    it('should handle network errors with retry', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        // First call - network error
        .mockRejectedValueOnce(new Error('Network error'))
        // Second call - success
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        // Download
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);
    });

    it('should run inpainting when useAIEdit is true', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      vi.mocked(photoroomService.inpaintHoles).mockResolvedValueOnce({
        success: true,
        outputPath: '/output/transparent.png',
        size: 2048,
        method: 'inpaint',
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { useAIEdit: true }
      );

      expect(result.success).toBe(true);
      expect(result.method).toBe('claid-selective+inpaint');
      expect(result.size).toBe(2048);
      expect(photoroomService.inpaintHoles).toHaveBeenCalledWith(
        '/output/transparent.png',
        '/output/transparent.png',
        { prompt: 'Fill in any missing or transparent parts of the product to make it complete and whole' }
      );
    });

    it('should return original result if inpainting fails', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      vi.mocked(photoroomService.inpaintHoles).mockResolvedValueOnce({
        success: false,
        error: 'Inpainting failed',
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { useAIEdit: true }
      );

      expect(result.success).toBe(true);
      expect(result.method).toBe('claid-selective');
      expect(result.size).toBe(mockResultData.length);
    });

    it('should return original result if inpainting throws', async () => {
      const mockTmpUrl = 'https://storage.claid.ai/tmp/result.png';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: { output: { tmp_url: mockTmpUrl } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      vi.mocked(photoroomService.inpaintHoles).mockRejectedValueOnce(
        new Error('Network error')
      );

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png',
        { useAIEdit: true }
      );

      expect(result.success).toBe(true);
      expect(result.method).toBe('claid-selective');
    });
  });
});

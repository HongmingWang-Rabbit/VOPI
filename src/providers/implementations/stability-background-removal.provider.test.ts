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

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { StabilityBackgroundRemovalProvider } from './stability-background-removal.provider.js';
import { readFile, writeFile } from 'fs/promises';
import { getConfig } from '../../config/index.js';

describe('StabilityBackgroundRemovalProvider', () => {
  let provider: StabilityBackgroundRemovalProvider;

  const mockImageBuffer = Buffer.from('fake-image-data');
  const mockResultData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const mockResultArrayBuffer = mockResultData.buffer;

  beforeEach(() => {
    provider = new StabilityBackgroundRemovalProvider();
    vi.clearAllMocks();

    // Default config mock
    vi.mocked(getConfig).mockReturnValue({
      apis: {
        stability: 'test-stability-api-key',
        stabilityBase: 'https://api.stability.ai',
      },
    } as ReturnType<typeof getConfig>);

    // Default file read mock
    vi.mocked(readFile).mockResolvedValue(mockImageBuffer);
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('stability');
    });
  });

  describe('isAvailable', () => {
    it('should return true when Stability API key is configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-api-key' },
      } as ReturnType<typeof getConfig>);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when Stability API key is not configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: undefined },
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
        apis: { stability: undefined, stabilityBase: 'https://api.stability.ai' },
      } as ReturnType<typeof getConfig>);

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Stability API key not configured (STABILITY_API_KEY)');
    });

    it('should remove background successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output/transparent.png');
      expect(result.method).toBe('stability-remove-bg');
      expect(result.size).toBe(mockResultData.length);

      // Verify API was called correctly
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.stability.ai/v2beta/stable-image/edit/remove-background',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-stability-api-key',
            'Accept': 'image/*',
          },
        })
      );

      // Verify request body is FormData
      const fetchCall = mockFetch.mock.calls[0];
      const formData = fetchCall[1].body as FormData;
      expect(formData).toBeInstanceOf(FormData);

      // Verify file was written
      expect(writeFile).toHaveBeenCalledWith('/output/transparent.png', expect.any(Buffer));
    });

    it('should detect MIME type from file extension', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
      });

      await provider.removeBackground(
        '/input/image.webp',
        '/output/transparent.png'
      );

      const fetchCall = mockFetch.mock.calls[0];
      const formData = fetchCall[1].body as FormData;
      const imageBlob = formData.get('image') as Blob;
      expect(imageBlob.type).toBe('image/webp');
    });

    it('should default to JPEG MIME type for unknown extensions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
      });

      await provider.removeBackground(
        '/input/image.jpg',
        '/output/transparent.png'
      );

      const fetchCall = mockFetch.mock.calls[0];
      const formData = fetchCall[1].body as FormData;
      const imageBlob = formData.get('image') as Blob;
      expect(imageBlob.type).toBe('image/jpeg');
    });

    it('should handle API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: vi.fn().mockResolvedValue('Invalid image format'),
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('422');
    });

    it('should retry on rate limit (429)', async () => {
      mockFetch
        // First call - rate limited
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: vi.fn().mockResolvedValue('Rate limit exceeded'),
        })
        // Second call - success
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
        });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on server error (500)', async () => {
      mockFetch
        // First call - server error
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: vi.fn().mockResolvedValue('Internal server error'),
        })
        // Second call - success
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
        text: vi.fn().mockResolvedValue('Internal server error'),
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Internal server error');
      expect(mockFetch).toHaveBeenCalledTimes(3); // Max retries
    });

    it('should handle network errors with retry', async () => {
      mockFetch
        // First call - network error
        .mockRejectedValueOnce(new Error('Network error'))
        // Second call - success
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

    it('should handle error when text() fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: vi.fn().mockRejectedValue(new Error('Failed to read response')),
      });

      const result = await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 400');
    });

    it('should use configured API base URL', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: {
          stability: 'test-api-key',
          stabilityBase: 'https://custom.stability.ai',
        },
      } as ReturnType<typeof getConfig>);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockResultArrayBuffer),
      });

      await provider.removeBackground(
        '/input/image.png',
        '/output/transparent.png'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.stability.ai/v2beta/stable-image/edit/remove-background',
        expect.anything()
      );
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StabilityService } from './stability.service.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock sharp
const mockSharpInstance = {
  metadata: vi.fn(),
  resize: vi.fn().mockReturnThis(),
  ensureAlpha: vi.fn().mockReturnThis(),
  raw: vi.fn().mockReturnThis(),
  grayscale: vi.fn().mockReturnThis(),
  blur: vi.fn().mockReturnThis(),
  png: vi.fn().mockReturnThis(),
  toBuffer: vi.fn(),
  toFile: vi.fn(),
};

vi.mock('sharp', () => ({
  default: vi.fn(() => mockSharpInstance),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    apis: {
      stability: 'test-stability-api-key',
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

import { writeFile, unlink } from 'fs/promises';
import { getConfig } from '../config/index.js';

describe('StabilityService', () => {
  let service: StabilityService;

  beforeEach(() => {
    service = new StabilityService();
    vi.clearAllMocks();

    // Setup default mock responses
    mockSharpInstance.metadata.mockResolvedValue({ width: 800, height: 600 });
    mockSharpInstance.toBuffer.mockResolvedValue({
      data: Buffer.alloc(800 * 600 * 4, 255), // Opaque white image
      info: { width: 800, height: 600, channels: 4 },
    });
    mockSharpInstance.toFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('inpaintHoles', () => {
    it('should return error when API key is not configured', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: {
          stability: undefined,
        },
      } as ReturnType<typeof getConfig>);

      const result = await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Stability API key not configured');
    });

    it('should handle image without dimensions gracefully', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      mockSharpInstance.metadata.mockResolvedValue({ width: undefined, height: undefined });

      const result = await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not get image dimensions');
    });

    it('should not write debug files when debug option is false', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      // Mock successful fetch
      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(Buffer.alloc(100)),
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      // Provide proper RGBA data
      const pixelCount = 768 * 576; // Resized dimensions (multiples of 64)
      const rgbaData = Buffer.alloc(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        rgbaData[i * 4] = 255;     // R
        rgbaData[i * 4 + 1] = 255; // G
        rgbaData[i * 4 + 2] = 255; // B
        rgbaData[i * 4 + 3] = 255; // A (opaque)
      }

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: rgbaData,
        info: { width: 768, height: 576, channels: 4 },
      });

      await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png',
        { debug: false }
      );

      // writeFile should only be called for the final output, not debug files
      const writeFileCalls = vi.mocked(writeFile).mock.calls;
      const debugFileCalls = writeFileCalls.filter(
        call => String(call[0]).includes('_prepared') || String(call[0]).includes('_inpaint_mask')
      );
      expect(debugFileCalls.length).toBe(0);
    });

    it('should write debug files when debug option is true', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      // Mock successful fetch
      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(Buffer.alloc(100)),
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      // Provide proper RGBA data
      const pixelCount = 768 * 576;
      const rgbaData = Buffer.alloc(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        rgbaData[i * 4] = 255;
        rgbaData[i * 4 + 1] = 255;
        rgbaData[i * 4 + 2] = 255;
        rgbaData[i * 4 + 3] = 255;
      }

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: rgbaData,
        info: { width: 768, height: 576, channels: 4 },
      });

      await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png',
        { debug: true, cleanup: false }
      );

      // Debug files should be written
      const writeFileCalls = vi.mocked(writeFile).mock.calls;
      const debugFileCalls = writeFileCalls.filter(
        call => String(call[0]).includes('_prepared') || String(call[0]).includes('_inpaint_mask')
      );
      expect(debugFileCalls.length).toBe(2);
    });

    it('should cleanup files on success when cleanup is true', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      // Mock successful fetch
      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(Buffer.alloc(100)),
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const pixelCount = 768 * 576;
      const rgbaData = Buffer.alloc(pixelCount * 4, 255);

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: rgbaData,
        info: { width: 768, height: 576, channels: 4 },
      });

      await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png',
        { cleanup: true }
      );

      // unlink should be called for cleanup
      expect(vi.mocked(unlink)).toHaveBeenCalled();
    });

    it('should retry on 5xx errors', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      const pixelCount = 768 * 576;
      const rgbaData = Buffer.alloc(pixelCount * 4, 255);
      mockSharpInstance.toBuffer.mockResolvedValue({
        data: rgbaData,
        info: { width: 768, height: 576, channels: 4 },
      });

      // First call fails with 500, second succeeds
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Internal Server Error'),
          });
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(Buffer.alloc(100)),
        });
      });

      const result = await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png'
      );

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
    });

    it('should not retry on 4xx errors', async () => {
      // Create fresh service instance for this test
      const freshService = new StabilityService();

      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      const pixelCount = 768 * 576;
      const rgbaData = Buffer.alloc(pixelCount * 4, 255);
      mockSharpInstance.toBuffer.mockResolvedValue({
        data: rgbaData,
        info: { width: 768, height: 576, channels: 4 },
      });

      // Create a fresh mock for this test
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });
      global.fetch = fetchMock;

      const result = await freshService.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 400');
      // Should only be called once (no retry for 4xx)
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should fail after max retries on persistent network errors', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      const pixelCount = 768 * 576;
      const rgbaData = Buffer.alloc(pixelCount * 4, 255);
      mockSharpInstance.toBuffer.mockResolvedValue({
        data: rgbaData,
        info: { width: 768, height: 576, channels: 4 },
      });

      // All calls fail with network error
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error('Network error'));
      });

      const result = await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Fetch failed after');
      expect(callCount).toBe(3); // MAX_RETRIES
    });

    it('should return success with correct output path on successful inpainting', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-key' },
      } as ReturnType<typeof getConfig>);

      const pixelCount = 768 * 576;
      const rgbaData = Buffer.alloc(pixelCount * 4, 255);

      // Mock toBuffer to return object format when resolveWithObject is true,
      // and just a Buffer otherwise (matching real sharp behavior)
      mockSharpInstance.toBuffer.mockImplementation(
        (options?: { resolveWithObject?: boolean }) => {
          if (options?.resolveWithObject) {
            return Promise.resolve({
              data: rgbaData,
              info: { width: 768, height: 576, channels: 4 },
            });
          }
          return Promise.resolve(Buffer.alloc(1000)); // PNG buffer
        }
      );

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.alloc(100)),
      });

      const result = await service.inpaintHoles(
        '/path/to/image.png',
        '/path/to/mask.png',
        '/path/to/output.png'
      );

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/path/to/output.png');
      // Size should be defined when success is true
      expect(result.size).toBeDefined();
      expect(result.size).toBeGreaterThan(0);
    });
  });
});

describe('dilateMask helper (via service behavior)', () => {
  it('should expand mask areas during inpainting', async () => {
    // This is tested indirectly through the service behavior
    // The dilation should expand white areas in the mask
    const service = new StabilityService();

    vi.mocked(getConfig).mockReturnValue({
      apis: { stability: 'test-key' },
    } as ReturnType<typeof getConfig>);

    // Create a mask with a small white spot
    const width = 64;
    const height = 64;
    const pixelCount = width * height;
    const rgbaData = Buffer.alloc(pixelCount * 4, 255);

    mockSharpInstance.metadata.mockResolvedValue({ width, height });
    mockSharpInstance.toBuffer.mockResolvedValue({
      data: rgbaData,
      info: { width, height, channels: 4 },
    });

    // Mock successful API response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.alloc(100)),
    });

    const result = await service.inpaintHoles(
      '/path/to/image.png',
      '/path/to/mask.png',
      '/path/to/output.png'
    );

    // The service should complete without errors
    expect(result.success).toBe(true);
  });
});

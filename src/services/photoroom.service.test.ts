import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhotoroomService } from './photoroom.service.js';
import type { RecommendedFrame } from './gemini.service.js';

// Mock https module
vi.mock('https', () => ({
  default: {
    request: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', () => ({
  createReadStream: vi.fn(() => ({
    pipe: vi.fn().mockReturnThis(),
    on: vi.fn((event, callback) => {
      if (event === 'end') setTimeout(callback, 0);
      return { on: vi.fn() };
    }),
  })),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    apis: {
      photoroom: 'test-api-key',
      photoroomBasicHost: 'sdk.photoroom.com',
      photoroomPlusHost: 'image-api.photoroom.com',
    },
    worker: {
      apiRetryDelayMs: 10,
      apiRateLimitDelayMs: 10,
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

import https from 'https';
import { writeFile } from 'fs/promises';

describe('PhotoroomService', () => {
  let service: PhotoroomService;

  beforeEach(() => {
    service = new PhotoroomService();
    vi.clearAllMocks();
  });

  const createMockResponse = (isImage: boolean, statusCode = 200) => {
    const chunks: Buffer[] = isImage ? [Buffer.from('image data')] : [];
    const errorData = isImage ? '' : JSON.stringify({ error: 'API error' });

    return {
      statusCode,
      headers: {
        'content-type': isImage ? 'image/png' : 'application/json',
      },
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          if (isImage) {
            chunks.forEach((chunk) => callback(chunk));
          } else {
            callback(Buffer.from(errorData));
          }
        }
        if (event === 'end') callback();
      }),
    };
  };

  const createMockRequest = (response: ReturnType<typeof createMockResponse>) => {
    const mockReq = {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((_event: string, _callback: () => void) => {
        // Don't call error by default
      }),
      setHeader: vi.fn(),
    };

    type HttpsRequestCallback = (res: { statusCode: number; headers: Record<string, string>; on: ReturnType<typeof vi.fn> }) => void;

    vi.mocked(https.request).mockImplementation(
      ((_urlOrOptions: string | URL | https.RequestOptions, optionsOrCallback?: https.RequestOptions | HttpsRequestCallback, maybeCallback?: HttpsRequestCallback) => {
        // Extract callback from variable argument positions
        const callback = typeof maybeCallback === 'function'
          ? maybeCallback
          : typeof optionsOrCallback === 'function'
            ? optionsOrCallback
            : undefined;
        setTimeout(() => {
          callback?.(response);
        }, 0);
        return mockReq as unknown as ReturnType<typeof https.request>;
      }) as typeof https.request
    );

    return mockReq;
  };

  describe('buildRemovalPrompt (private, tested via editImageWithAI)', () => {
    it('should return null for no obstructions', async () => {
      const mockResponse = createMockResponse(true);
      createMockRequest(mockResponse);

      await service.editImageWithAI('/input.png', '/output.png', {
        obstructions: {
          has_obstruction: false,
          obstruction_types: [],
          obstruction_description: null,
          removable_by_ai: true,
        },
      });

      // Verify default prompt is used when no obstructions
      expect(writeFile).toHaveBeenCalled();
    });

    it('should build prompt for hand obstructions', async () => {
      const mockResponse = createMockResponse(true);
      const mockReq = createMockRequest(mockResponse);

      await service.editImageWithAI('/input.png', '/output.png', {
        obstructions: {
          has_obstruction: true,
          obstruction_types: ['hand'],
          obstruction_description: 'Hand visible',
          removable_by_ai: true,
        },
      });

      // Check that the prompt was written to the request
      const writeCalls = mockReq.write.mock.calls.map((c) => c[0]).join('');
      expect(writeCalls).toContain('human hands and fingers');
    });
  });

  describe('removeBackground', () => {
    it('should call basic segment endpoint', async () => {
      const mockResponse = createMockResponse(true);
      createMockRequest(mockResponse);

      const result = await service.removeBackground('/input.png', '/output.png');

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output.png');
      expect(writeFile).toHaveBeenCalled();
    });

    it('should throw on API error', async () => {
      const mockResponse = createMockResponse(false, 400);
      createMockRequest(mockResponse);

      await expect(service.removeBackground('/input.png', '/output.png')).rejects.toThrow(
        'API error'
      );
    });
  });

  describe('editImageWithAI', () => {
    it('should call v2/edit endpoint', async () => {
      const mockResponse = createMockResponse(true);
      createMockRequest(mockResponse);

      const result = await service.editImageWithAI('/input.png', '/output.png');

      expect(result.success).toBe(true);
      expect(result.method).toBe('v2/edit');
      expect(writeFile).toHaveBeenCalledWith('/output.png', expect.any(Buffer));
    });

    it('should use custom prompt when provided', async () => {
      const mockResponse = createMockResponse(true);
      const mockReq = createMockRequest(mockResponse);

      await service.editImageWithAI('/input.png', '/output.png', {
        customPrompt: 'Custom removal prompt',
      });

      const writeCalls = mockReq.write.mock.calls.map((c) => c[0]).join('');
      expect(writeCalls).toContain('Custom removal prompt');
    });
  });

  describe('generateWithSolidBackground', () => {
    it('should generate image with solid background', async () => {
      const mockResponse = createMockResponse(true);
      const mockReq = createMockRequest(mockResponse);

      const result = await service.generateWithSolidBackground(
        '/input.png',
        '/output.png',
        '#FF0000'
      );

      expect(result.success).toBe(true);
      expect(result.method).toBe('solid_background');
      expect(result.bgColor).toBe('#FF0000');

      const writeCalls = mockReq.write.mock.calls.map((c) => c[0]).join('');
      expect(writeCalls).toContain('background.color');
      expect(writeCalls).toContain('#FF0000');
    });
  });

  describe('generateWithAIBackground', () => {
    it('should generate image with AI background', async () => {
      const mockResponse = createMockResponse(true);
      const mockReq = createMockRequest(mockResponse);

      const result = await service.generateWithAIBackground(
        '/input.png',
        '/output.png',
        'on a wooden table'
      );

      expect(result.success).toBe(true);
      expect(result.method).toBe('ai_background');
      expect(result.bgPrompt).toBe('on a wooden table');

      const writeCalls = mockReq.write.mock.calls.map((c) => c[0]).join('');
      expect(writeCalls).toContain('background.prompt');
      expect(writeCalls).toContain('on a wooden table');
    });
  });

  describe('generateAllVersions', () => {
    const mockFrame: RecommendedFrame = {
      filename: 'frame.png',
      path: '/tmp/frame.png',
      index: 1,
      timestamp: 1.0,
      frameId: 'frame_00001',
      sharpness: 50,
      motion: 0.1,
      score: 45,
      productId: 'product_1',
      variantId: 'front_view',
      angleEstimate: 'front',
      recommendedType: 'product_1_front_view',
      geminiScore: 85,
      rotationAngleDeg: 0,
      allFrameIds: ['frame_00001'],
      obstructions: {
        has_obstruction: false,
        obstruction_types: [],
        obstruction_description: null,
        removable_by_ai: true,
      },
      backgroundRecommendations: {
        solid_color: '#FFFFFF',
        solid_color_name: 'white',
        real_life_setting: 'on a white table',
        creative_shot: 'floating with shadow',
      },
    };

    it('should generate all default versions', async () => {
      const mockResponse = createMockResponse(true);
      createMockRequest(mockResponse);

      const result = await service.generateAllVersions(mockFrame, '/output');

      expect(result.frameId).toBe('frame_00001');
      expect(result.recommendedType).toBe('product_1_front_view');
      expect(result.versions.transparent).toBeDefined();
      expect(result.versions.solid).toBeDefined();
      expect(result.versions.real).toBeDefined();
      expect(result.versions.creative).toBeDefined();
    });

    it('should use AI edit when obstructions present and useAIEdit is true', async () => {
      const mockResponse = createMockResponse(true);
      createMockRequest(mockResponse);

      const frameWithObstruction: RecommendedFrame = {
        ...mockFrame,
        obstructions: {
          has_obstruction: true,
          obstruction_types: ['hand'],
          obstruction_description: 'Hand visible',
          removable_by_ai: true,
        },
      };

      const result = await service.generateAllVersions(frameWithObstruction, '/output', {
        useAIEdit: true,
      });

      expect(result.versions.transparent).toBeDefined();
    });

    it('should only generate requested versions', async () => {
      const mockResponse = createMockResponse(true);
      createMockRequest(mockResponse);

      const result = await service.generateAllVersions(mockFrame, '/output', {
        versions: ['transparent', 'solid'],
      });

      expect(result.versions.transparent).toBeDefined();
      expect(result.versions.solid).toBeDefined();
      expect(result.versions.real).toBeUndefined();
      expect(result.versions.creative).toBeUndefined();
    });

    it('should handle API failures gracefully', async () => {
      const mockResponse = createMockResponse(false, 500);
      createMockRequest(mockResponse);

      const result = await service.generateAllVersions(mockFrame, '/output', {
        versions: ['transparent'],
      });

      expect(result.versions.transparent?.success).toBe(false);
      expect(result.versions.transparent?.error).toBeDefined();
    });

    it('should skip other versions if transparent fails with obstructions', async () => {
      const mockResponse = createMockResponse(false, 500);
      createMockRequest(mockResponse);

      const frameWithObstruction: RecommendedFrame = {
        ...mockFrame,
        obstructions: {
          has_obstruction: true,
          obstruction_types: ['hand'],
          obstruction_description: 'Hand visible',
          removable_by_ai: true,
        },
      };

      const result = await service.generateAllVersions(frameWithObstruction, '/output');

      expect(result.versions.transparent?.success).toBe(false);
      // Other versions should not be attempted
      expect(result.versions.solid).toBeUndefined();
    });

    it('should not include transparent in result if not requested', async () => {
      const mockResponse = createMockResponse(true);
      createMockRequest(mockResponse);

      const result = await service.generateAllVersions(mockFrame, '/output', {
        versions: ['solid'],
      });

      expect(result.versions.transparent).toBeUndefined();
      expect(result.versions.solid).toBeDefined();
    });
  });
});

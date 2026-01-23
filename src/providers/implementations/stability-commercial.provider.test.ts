/**
 * Tests for Stability AI Commercial Image Provider
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before importing provider
vi.mock('../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock dependencies
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { StabilityCommercialProvider } from './stability-commercial.provider.js';

vi.mock('sharp', () => {
  const createMockSharpInstance = () => ({
    metadata: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('mock-image')),
    composite: vi.fn().mockReturnThis(),
  });
  // Return a fresh instance each time sharp is called
  const mockSharp = vi.fn(() => createMockSharpInstance());
  return { default: mockSharp };
});

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../utils/stability-api.js', () => ({
  makeStabilityAsyncRequest: vi.fn(),
  isWithinSizeLimit: vi.fn(),
  getFileSizeError: vi.fn(),
  parseHexColor: vi.fn(),
  STABILITY_API_CONSTANTS: {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 2000,
    POLLING_INTERVAL_MS: 3000,
    MAX_POLLING_ATTEMPTS: 60,
    MAX_INPUT_SIZE_BYTES: 10 * 1024 * 1024,
    MAX_PIXELS: 9_437_184,
  },
}));

import { readFile, writeFile } from 'fs/promises';
import { getConfig } from '../../config/index.js';
import {
  makeStabilityAsyncRequest,
  isWithinSizeLimit,
  getFileSizeError,
  parseHexColor,
} from '../utils/stability-api.js';

describe('StabilityCommercialProvider', () => {
  let provider: StabilityCommercialProvider;

  beforeEach(() => {
    provider = new StabilityCommercialProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('providerId', () => {
    it('returns correct provider ID', () => {
      expect(provider.providerId).toBe('stability-commercial');
    });
  });

  describe('isAvailable', () => {
    it('returns true when API key is configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: 'test-api-key', stabilityBase: 'https://api.stability.ai' },
      } as ReturnType<typeof getConfig>);

      expect(provider.isAvailable()).toBe(true);
    });

    it('returns false when API key is not configured', () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: undefined, stabilityBase: 'https://api.stability.ai' },
      } as ReturnType<typeof getConfig>);

      expect(provider.isAvailable()).toBe(false);
    });

    it('returns false when getConfig throws', () => {
      vi.mocked(getConfig).mockImplementation(() => {
        throw new Error('Config error');
      });

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('generateWithAIBackground', () => {
    const mockImageBuffer = Buffer.from('fake-image-data');
    const mockResultBuffer = Buffer.from('commercial-image-data');

    beforeEach(() => {
      vi.mocked(getConfig).mockReturnValue({
        apis: {
          stability: 'test-api-key',
          stabilityBase: 'https://api.stability.ai',
        },
      } as ReturnType<typeof getConfig>);
      vi.mocked(readFile).mockResolvedValue(mockImageBuffer);
      vi.mocked(writeFile).mockResolvedValue(undefined);
      vi.mocked(isWithinSizeLimit).mockReturnValue(true);
      vi.mocked(makeStabilityAsyncRequest).mockResolvedValue(mockResultBuffer);
    });

    it('returns error when API key is not configured', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: undefined, stabilityBase: 'https://api.stability.ai' },
      } as ReturnType<typeof getConfig>);

      const result = await provider.generateWithAIBackground('/input.png', '/output.png', {
        backgroundPrompt: 'on a white surface',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('API key not configured');
    });

    it('returns error when file is too large', async () => {
      vi.mocked(isWithinSizeLimit).mockReturnValue(false);
      vi.mocked(getFileSizeError).mockReturnValue('Image too large: 15.00MB exceeds 10MB limit');

      const result = await provider.generateWithAIBackground('/input.png', '/output.png', {
        backgroundPrompt: 'on a white surface',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('successfully generates commercial image', async () => {
      const result = await provider.generateWithAIBackground('/input.png', '/output.png', {
        backgroundPrompt: 'on a clean white surface',
      });

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output.png');
      expect(result.size).toBe(mockResultBuffer.length);
      expect(result.method).toBe('stability-replace-bg-relight');
      expect(result.bgPrompt).toBe('on a clean white surface');
      expect(writeFile).toHaveBeenCalledWith('/output.png', mockResultBuffer);
    });

    it('includes optional parameters in request', async () => {
      await provider.generateWithAIBackground('/input.png', '/output.png', {
        backgroundPrompt: 'on a white surface',
        foregroundPrompt: 'product photo',
        negativePrompt: 'blurry',
        lightSourceDirection: 'above',
        lightSourceStrength: 0.7,
        preserveOriginalSubject: 0.9,
        seed: 12345,
        outputFormat: 'jpeg',
      });

      expect(makeStabilityAsyncRequest).toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      vi.mocked(makeStabilityAsyncRequest).mockRejectedValue(new Error('API Error'));

      const result = await provider.generateWithAIBackground('/input.png', '/output.png', {
        backgroundPrompt: 'on a white surface',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API Error');
    });
  });

  describe('generateWithSolidBackground', () => {
    beforeEach(() => {
      vi.mocked(writeFile).mockResolvedValue(undefined);
      vi.mocked(parseHexColor).mockReturnValue({ r: 255, g: 255, b: 255, alpha: 1 });
    });

    it('successfully generates solid background image', async () => {
      const result = await provider.generateWithSolidBackground('/input.png', '/output.png', {
        backgroundColor: '#FFFFFF',
      });

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output.png');
      expect(result.method).toBe('solid-background');
      expect(result.bgColor).toBe('#FFFFFF');
    });

    it('uses parseHexColor for color validation', async () => {
      await provider.generateWithSolidBackground('/input.png', '/output.png', {
        backgroundColor: '#FF0000',
      });

      expect(parseHexColor).toHaveBeenCalledWith('#FF0000');
    });

    it('applies custom padding', async () => {
      await provider.generateWithSolidBackground('/input.png', '/output.png', {
        backgroundColor: '#FFFFFF',
        padding: 0.2,
      });

      expect(writeFile).toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      vi.mocked(writeFile).mockRejectedValue(new Error('Write error'));

      const result = await provider.generateWithSolidBackground('/input.png', '/output.png', {
        backgroundColor: '#FFFFFF',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write error');
    });
  });
});

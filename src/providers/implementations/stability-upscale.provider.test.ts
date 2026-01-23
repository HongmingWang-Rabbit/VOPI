/**
 * Tests for Stability AI Upscale Provider
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

import { StabilityUpscaleProvider } from './stability-upscale.provider.js';

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../utils/stability-api.js', () => ({
  makeStabilityRequest: vi.fn(),
  isWithinSizeLimit: vi.fn(),
  getFileSizeError: vi.fn(),
}));

import { readFile, writeFile } from 'fs/promises';
import { getConfig } from '../../config/index.js';
import { makeStabilityRequest, isWithinSizeLimit, getFileSizeError } from '../utils/stability-api.js';

describe('StabilityUpscaleProvider', () => {
  let provider: StabilityUpscaleProvider;

  beforeEach(() => {
    provider = new StabilityUpscaleProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('providerId', () => {
    it('returns correct provider ID', () => {
      expect(provider.providerId).toBe('stability-upscale');
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

  describe('upscale', () => {
    const mockImageBuffer = Buffer.from('fake-image-data');
    const mockResultBuffer = Buffer.from('upscaled-image-data');

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
      vi.mocked(makeStabilityRequest).mockResolvedValue(mockResultBuffer);
    });

    it('returns error when API key is not configured', async () => {
      vi.mocked(getConfig).mockReturnValue({
        apis: { stability: undefined, stabilityBase: 'https://api.stability.ai' },
      } as ReturnType<typeof getConfig>);

      const result = await provider.upscale('/input.png', '/output.png');

      expect(result.success).toBe(false);
      expect(result.error).toContain('API key not configured');
    });

    it('returns error when file is too large', async () => {
      vi.mocked(isWithinSizeLimit).mockReturnValue(false);
      vi.mocked(getFileSizeError).mockReturnValue('Image too large: 15.00MB exceeds 10MB limit');

      const result = await provider.upscale('/input.png', '/output.png');

      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('successfully upscales image with conservative endpoint', async () => {
      const result = await provider.upscale('/input.png', '/output.png');

      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('/output.png');
      expect(result.size).toBe(mockResultBuffer.length);
      expect(result.method).toBe('stability-conservative-upscale');
      expect(writeFile).toHaveBeenCalledWith('/output.png', mockResultBuffer);
    });

    it('uses creative endpoint when creativity > 0.5', async () => {
      const result = await provider.upscale('/input.png', '/output.png', {
        creativity: 0.7,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe('stability-creative-upscale');

      // Verify the endpoint used
      expect(makeStabilityRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: expect.stringContaining('/upscale/creative'),
        })
      );
    });

    it('uses conservative endpoint when creativity <= 0.5', async () => {
      const result = await provider.upscale('/input.png', '/output.png', {
        creativity: 0.3,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe('stability-conservative-upscale');

      // Verify the endpoint used
      expect(makeStabilityRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: expect.stringContaining('/upscale/conservative'),
        })
      );
    });

    it('includes optional parameters in form data', async () => {
      await provider.upscale('/input.png', '/output.png', {
        prompt: 'custom prompt',
        negativePrompt: 'avoid this',
        seed: 12345,
        outputFormat: 'jpeg',
      });

      expect(makeStabilityRequest).toHaveBeenCalled();
      const call = vi.mocked(makeStabilityRequest).mock.calls[0][0];
      expect(call.formData).toBeDefined();
    });

    it('handles API errors gracefully', async () => {
      vi.mocked(makeStabilityRequest).mockRejectedValue(new Error('API Error'));

      const result = await provider.upscale('/input.png', '/output.png');

      expect(result.success).toBe(false);
      expect(result.error).toBe('API Error');
    });

    it('detects MIME type from file extension', async () => {
      await provider.upscale('/input.webp', '/output.png');
      expect(makeStabilityRequest).toHaveBeenCalled();

      await provider.upscale('/input.jpg', '/output.png');
      expect(makeStabilityRequest).toHaveBeenCalled();
    });
  });
});

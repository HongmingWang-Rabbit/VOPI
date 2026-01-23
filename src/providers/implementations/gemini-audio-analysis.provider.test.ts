/**
 * Gemini Audio Analysis Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock functions defined at module scope
const mockGenerateContent = vi.fn();
const mockUploadFile = vi.fn();
const mockGetFile = vi.fn();
const mockDeleteFile = vi.fn();

// Mock Google Generative AI with proper class-like implementations
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    getGenerativeModel() {
      return {
        generateContent: mockGenerateContent,
      };
    }
  },
}));

vi.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: class MockGoogleAIFileManager {
    uploadFile = mockUploadFile;
    getFile = mockGetFile;
    deleteFile = mockDeleteFile;
  },
  FileState: {
    PROCESSING: 'PROCESSING',
    ACTIVE: 'ACTIVE',
    FAILED: 'FAILED',
  },
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    apis: {
      googleAi: 'test-api-key',
      geminiModel: 'gemini-2.0-flash',
    },
    worker: {
      apiRetryDelayMs: 10,
    },
    audio: {
      processingTimeoutMs: 1000,
      pollingIntervalMs: 100,
      maxRetries: 2,
    },
  })),
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

// Mock errors
vi.mock('../../utils/errors.js', () => ({
  ExternalApiError: class ExternalApiError extends Error {
    constructor(provider: string, message: string) {
      super(`${provider}: ${message}`);
      this.name = 'ExternalApiError';
    }
  },
}));

// Mock mime-types
vi.mock('../../utils/mime-types.js', () => ({
  getAudioMimeType: vi.fn(() => 'audio/mp3'),
}));

import { GeminiAudioAnalysisProvider } from './gemini-audio-analysis.provider.js';

describe('GeminiAudioAnalysisProvider', () => {
  let provider: GeminiAudioAnalysisProvider;

  const validResponse = {
    transcript: 'This is a great leather wallet with RFID protection.',
    language: 'en',
    audioQuality: 85,
    product: {
      title: 'Premium Leather RFID Wallet',
      description: 'A high-quality leather wallet with RFID protection.',
      shortDescription: 'Premium leather wallet with RFID blocking.',
      bulletPoints: ['Genuine leather', 'RFID protection', 'Slim design'],
      brand: 'TestBrand',
      category: 'Accessories',
      subcategory: 'Wallets',
      materials: ['leather'],
      color: 'brown',
      colors: ['brown', 'black'],
      price: { value: 49.99, currency: 'USD' },
      keywords: ['wallet', 'leather', 'RFID'],
      tags: ['men', 'accessories'],
      condition: 'new',
    },
    confidence: {
      overall: 85,
      title: 90,
      description: 80,
      price: 75,
      attributes: 70,
    },
    relevantExcerpts: ['great leather wallet', 'RFID protection'],
  };

  beforeEach(() => {
    provider = new GeminiAudioAnalysisProvider();
    vi.clearAllMocks();

    // Default mock setup - file is immediately ACTIVE
    mockUploadFile.mockResolvedValue({
      file: {
        uri: 'files/test-audio-123',
        name: 'test-audio-123',
        state: 'ACTIVE',
      },
    });

    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify(validResponse),
      },
    });

    mockDeleteFile.mockResolvedValue(undefined);
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('gemini-audio');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is configured', () => {
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('uploadAudio', () => {
    it('should upload audio and return file URI', async () => {
      const uri = await provider.uploadAudio('/path/to/audio.mp3');

      expect(mockUploadFile).toHaveBeenCalledWith('/path/to/audio.mp3', {
        mimeType: 'audio/mp3',
        displayName: 'audio.mp3',
      });
      expect(uri).toBe('files/test-audio-123');
    });

    it('should throw when processing fails', async () => {
      mockUploadFile.mockResolvedValue({
        file: {
          uri: 'files/test-audio-123',
          name: 'test-audio-123',
          state: 'FAILED',
          error: { message: 'Invalid audio format' },
        },
      });

      await expect(provider.uploadAudio('/path/to/audio.mp3')).rejects.toThrow(
        'Audio processing failed'
      );
    });

    it('should wait for processing to complete', async () => {
      // First return PROCESSING, then ACTIVE
      mockUploadFile.mockResolvedValue({
        file: {
          uri: 'files/test-audio-123',
          name: 'test-audio-123',
          state: 'PROCESSING',
        },
      });

      mockGetFile.mockResolvedValue({
        name: 'test-audio-123',
        state: 'ACTIVE',
      });

      const uri = await provider.uploadAudio('/path/to/audio.mp3');

      expect(mockGetFile).toHaveBeenCalled();
      expect(uri).toBe('files/test-audio-123');
    });

    it('should throw on processing timeout', async () => {
      mockUploadFile.mockResolvedValue({
        file: {
          uri: 'files/test-audio-123',
          name: 'test-audio-123',
          state: 'PROCESSING',
        },
      });

      // Keep returning PROCESSING to trigger timeout
      mockGetFile.mockResolvedValue({
        name: 'test-audio-123',
        state: 'PROCESSING',
      });

      await expect(provider.uploadAudio('/path/to/audio.mp3')).rejects.toThrow(
        'Audio processing timeout'
      );
    });
  });

  describe('deleteAudio', () => {
    it('should delete audio by file name', async () => {
      await provider.deleteAudio('files/test-audio-123');

      expect(mockDeleteFile).toHaveBeenCalledWith('test-audio-123');
    });

    it('should handle delete errors gracefully', async () => {
      mockDeleteFile.mockRejectedValue(new Error('Delete failed'));

      // Should not throw
      await expect(provider.deleteAudio('files/test-audio-123')).resolves.toBeUndefined();
    });

    it('should extract file name from URI correctly', async () => {
      await provider.deleteAudio('https://generativelanguage.googleapis.com/v1/files/test-audio-456');

      expect(mockDeleteFile).toHaveBeenCalledWith('test-audio-456');
    });
  });

  describe('analyzeAudio', () => {
    it('should analyze audio and return structured result', async () => {
      const result = await provider.analyzeAudio('/path/to/audio.mp3');

      expect(result.transcript).toBe('This is a great leather wallet with RFID protection.');
      expect(result.language).toBe('en');
      expect(result.audioQuality).toBe(85);
      expect(result.productMetadata.title).toBe('Premium Leather RFID Wallet');
      expect(result.productMetadata.bulletPoints).toHaveLength(3);
      expect(result.confidence.overall).toBe(85);
      expect(result.relevantExcerpts).toHaveLength(2);
    });

    it('should handle markdown code blocks in response', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => '```json\n' + JSON.stringify(validResponse) + '\n```',
        },
      });

      const result = await provider.analyzeAudio('/path/to/audio.mp3');

      expect(result.productMetadata.title).toBe('Premium Leather RFID Wallet');
    });

    it('should retry on failure', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce({
          response: {
            text: () => JSON.stringify(validResponse),
          },
        });

      const result = await provider.analyzeAudio('/path/to/audio.mp3', {
        maxRetries: 3,
        retryDelay: 10,
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(result.productMetadata.title).toBe('Premium Leather RFID Wallet');
    });

    it('should throw after max retries', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await expect(
        provider.analyzeAudio('/path/to/audio.mp3', {
          maxRetries: 2,
          retryDelay: 10,
        })
      ).rejects.toThrow('Audio analysis failed after 2 attempts');
    });

    it('should throw on invalid JSON response', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => 'not valid json',
        },
      });

      await expect(
        provider.analyzeAudio('/path/to/audio.mp3', {
          maxRetries: 1,
          retryDelay: 10,
        })
      ).rejects.toThrow('Failed to parse audio analysis response');
    });

    it('should throw on schema validation failure', async () => {
      // Missing required fields
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            transcript: 'Test',
            // Missing other required fields
          }),
        },
      });

      await expect(
        provider.analyzeAudio('/path/to/audio.mp3', {
          maxRetries: 1,
          retryDelay: 10,
        })
      ).rejects.toThrow('Audio analysis response validation failed');
    });

    it('should cleanup uploaded audio after analysis', async () => {
      await provider.analyzeAudio('/path/to/audio.mp3');

      expect(mockDeleteFile).toHaveBeenCalledWith('test-audio-123');
    });

    it('should cleanup uploaded audio even on error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await expect(
        provider.analyzeAudio('/path/to/audio.mp3', {
          maxRetries: 1,
          retryDelay: 10,
        })
      ).rejects.toThrow();

      expect(mockDeleteFile).toHaveBeenCalledWith('test-audio-123');
    });

    it('should handle null values in response', async () => {
      const responseWithNulls = {
        ...validResponse,
        product: {
          ...validResponse.product,
          brand: null,
          size: null,
          dimensions: null,
          weight: null,
        },
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(responseWithNulls),
        },
      });

      const result = await provider.analyzeAudio('/path/to/audio.mp3');

      // null values should be converted to undefined
      expect(result.productMetadata.brand).toBeUndefined();
      expect(result.productMetadata.size).toBeUndefined();
    });

    it('should pass options to provider', async () => {
      await provider.analyzeAudio('/path/to/audio.mp3', {
        model: 'gemini-2.0-flash-lite',
        maxBulletPoints: 3,
        focusAreas: ['price', 'materials'],
        temperature: 0.5,
      });

      // Verify generateContent was called (options are passed through model config)
      expect(mockGenerateContent).toHaveBeenCalled();
    });

    it('should include raw response in result', async () => {
      const result = await provider.analyzeAudio('/path/to/audio.mp3');

      expect(result.rawResponse).toBeDefined();
      expect(result.rawResponse.transcript).toBe(validResponse.transcript);
    });

    it('should handle dimensions and weight in response', async () => {
      const responseWithDimensions = {
        ...validResponse,
        product: {
          ...validResponse.product,
          dimensions: { length: 4, width: 3, height: 0.5, unit: 'in' },
          weight: { value: 0.2, unit: 'lb' },
        },
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(responseWithDimensions),
        },
      });

      const result = await provider.analyzeAudio('/path/to/audio.mp3');

      expect(result.productMetadata.dimensions).toBeDefined();
      expect(result.productMetadata.dimensions?.length).toBe(4);
      expect(result.productMetadata.weight).toBeDefined();
      expect(result.productMetadata.weight?.value).toBe(0.2);
    });
  });
});

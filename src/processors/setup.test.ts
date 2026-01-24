/**
 * Processor Setup Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('../utils/logger.js', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockLogger.child = vi.fn(() => mockLogger);
  return {
    createChildLogger: vi.fn(() => mockLogger),
    getLogger: vi.fn(() => mockLogger),
  };
});

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    apis: {
      googleAi: 'test-api-key',
      geminiModel: 'gemini-2.0-flash-exp',
      geminiVideoModel: 'gemini-2.0-flash-exp',
    },
    worker: {
      apiRetryDelayMs: 100,
    },
    storage: {
      bucket: 'test-bucket',
      endpoint: 'http://localhost:9000',
    },
  })),
}));

// Mock services that processors depend on
vi.mock('../services/storage.service.js', () => ({
  storageService: {
    downloadFromUrl: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue({ url: 'https://example.com/file.jpg' }),
    getJobKey: vi.fn().mockReturnValue('jobs/test/file.jpg'),
  },
}));

vi.mock('../services/frame-scoring.service.js', () => ({
  frameScoringService: {
    scoreFrames: vi.fn().mockResolvedValue([]),
    selectBestFramePerSecond: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../services/video.service.js', () => ({
  videoService: {
    extractFrames: vi.fn().mockResolvedValue({ frames: [], metadata: {} }),
    getMetadata: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/photoroom.service.js', () => ({
  photoroomService: {
    generateAllVersions: vi.fn().mockResolvedValue({ versions: {} }),
    extractProduct: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../services/gemini.service.js', () => ({
  geminiService: {
    classifyFrames: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../services/credits.service.js', () => ({
  creditsService: {
    calculateJobCost: vi.fn().mockResolvedValue({ totalCredits: 1, breakdown: [] }),
    calculateJobCostWithAffordability: vi.fn().mockResolvedValue({ totalCredits: 1, breakdown: [], canAfford: true }),
    spendCredits: vi.fn().mockResolvedValue({ success: true, newBalance: 10, transactionId: 'test-tx' }),
  },
}));

vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn(() => ({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  })),
  schema: {
    videos: {},
    frames: {},
    jobs: {},
    commercialImages: {},
  },
}));

vi.mock('../providers/setup.js', () => ({
  getProductExtractionProvider: vi.fn(() => ({
    extractProduct: vi.fn().mockResolvedValue({ success: true, outputPath: '/test.png' }),
  })),
  getImageTransformProvider: vi.fn(() => ({
    findContentBounds: vi.fn().mockResolvedValue({ top: 0, left: 0, width: 100, height: 100 }),
    crop: vi.fn().mockResolvedValue('/cropped.png'),
    resize: vi.fn().mockResolvedValue('/resized.png'),
    rotate: vi.fn().mockResolvedValue('/rotated.png'),
  })),
  getBackgroundRemovalProvider: vi.fn(() => ({
    removeBackground: vi.fn().mockResolvedValue('/no-bg.png'),
  })),
}));

vi.mock('../providers/implementations/gemini-video-analysis.provider.js', () => ({
  GeminiVideoAnalysisProvider: vi.fn().mockImplementation(() => ({
    analyzeVideo: vi.fn().mockResolvedValue({ frames: [] }),
  })),
  geminiVideoAnalysisProvider: {
    analyzeVideo: vi.fn().mockResolvedValue({ frames: [] }),
  },
}));

import { setupProcessors, verifyProcessors } from './setup.js';
import { processorRegistry } from './registry.js';
import { allProcessors } from './impl/index.js';

describe('Processor Setup', () => {
  beforeEach(() => {
    // Clear registry before each test
    processorRegistry.clear();
  });

  afterEach(() => {
    // Clean up after tests
    processorRegistry.clear();
  });

  describe('setupProcessors', () => {
    it('should register all processors', () => {
      expect(processorRegistry.getIds()).toHaveLength(0);

      setupProcessors();

      expect(processorRegistry.getIds()).toHaveLength(allProcessors.length);
    });

    it('should register processors with correct IDs', () => {
      setupProcessors();

      const expectedIds = [
        'download',
        'extract-frames',
        'gemini-video-analysis',
        'score-frames',
        'gemini-classify',
        'filter-by-score',
        'extract-products',
        'photoroom-bg-remove',
        'claid-bg-remove',
        'center-product',
        'rotate-image',
        'save-frame-records',
        'upload-frames',
        'generate-commercial',
        'complete-job',
      ];

      for (const id of expectedIds) {
        expect(processorRegistry.has(id)).toBe(true);
      }
    });

    it('should be idempotent (safe to call multiple times)', () => {
      setupProcessors();
      const firstCount = processorRegistry.getIds().length;

      setupProcessors();
      const secondCount = processorRegistry.getIds().length;

      expect(firstCount).toBe(secondCount);
    });
  });

  describe('verifyProcessors', () => {
    it('should return true when all processors are valid', () => {
      setupProcessors();

      const result = verifyProcessors();

      expect(result).toBe(true);
    });

    it('should return true for empty registry', () => {
      // Empty registry has no invalid processors
      const result = verifyProcessors();

      expect(result).toBe(true);
    });
  });

  describe('processor structure', () => {
    beforeEach(() => {
      setupProcessors();
    });

    it('all processors should have required properties', () => {
      const processors = processorRegistry.getAll();

      for (const processor of processors) {
        expect(processor.id).toBeDefined();
        expect(processor.id.length).toBeGreaterThan(0);
        expect(processor.displayName).toBeDefined();
        expect(processor.statusKey).toBeDefined();
        expect(processor.io).toBeDefined();
        expect(processor.io.requires).toBeDefined();
        expect(processor.io.produces).toBeDefined();
        expect(typeof processor.execute).toBe('function');
      }
    });

    it('all processors should have valid data path arrays', () => {
      const processors = processorRegistry.getAll();
      // DataPath: unified type for all data requirements
      const validPaths = [
        'video', 'images', 'text',
        'audio', 'transcript', 'product.metadata',
        'frames', 'frames.scores', 'frames.classifications',
        'frames.dbId', 'frames.s3Url', 'frames.version'
      ];

      for (const processor of processors) {
        for (const req of processor.io.requires) {
          expect(validPaths).toContain(req);
        }
        for (const prod of processor.io.produces) {
          expect(validPaths).toContain(prod);
        }
      }
    });

    it('download processor should require video (sourceUrl) and produce video (path)', () => {
      const download = processorRegistry.get('download');

      expect(download).toBeDefined();
      expect(download!.io.requires).toContain('video');
      expect(download!.io.produces).toContain('video');
    });

    it('background removal processors should be swappable', () => {
      expect(processorRegistry.areSwappable('photoroom-bg-remove', 'claid-bg-remove')).toBe(true);
    });

    it('image transformation processors should have images -> images IO', () => {
      const transformProcessors = ['center-product', 'rotate-image'];

      for (const id of transformProcessors) {
        const processor = processorRegistry.get(id);
        expect(processor).toBeDefined();
        expect(processor!.io.requires).toContain('images');
        expect(processor!.io.produces).toContain('images');
      }
    });
  });
});

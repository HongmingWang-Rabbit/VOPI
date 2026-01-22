/**
 * Processor Integration Tests
 *
 * Tests the complete processor stack architecture with real processor registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

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

import { setupProcessors } from './setup.js';
import { processorRegistry } from './registry.js';
import { stackRunner } from './runner.js';
import {
  stackTemplates,
  classicStack,
  geminiVideoStack,
  minimalStack,
  framesOnlyStack,
  customBgRemovalStack,
} from './templates/index.js';

describe('Processor Integration', () => {
  beforeEach(() => {
    processorRegistry.clear();
    setupProcessors();
  });

  afterEach(() => {
    processorRegistry.clear();
  });

  describe('stack validation with real processors', () => {
    it('should validate classic stack', () => {
      // Pass initialIO: ['video'] since download processor now requires video input
      const result = stackRunner.validate(classicStack, ['video']);

      expect(result.valid).toBe(true);
      expect(result.availableOutputs).toContain('video');
      expect(result.availableOutputs).toContain('images');
    });

    it('should validate gemini video stack', () => {
      const result = stackRunner.validate(geminiVideoStack, ['video']);

      expect(result.valid).toBe(true);
    });

    it('should validate minimal stack', () => {
      const result = stackRunner.validate(minimalStack, ['video']);

      expect(result.valid).toBe(true);
    });

    it('should validate frames only stack', () => {
      const result = stackRunner.validate(framesOnlyStack, ['video']);

      expect(result.valid).toBe(true);
    });

    it('should validate custom bg removal stack', () => {
      const result = stackRunner.validate(customBgRemovalStack, ['video']);

      expect(result.valid).toBe(true);
    });

    it('should validate all predefined stacks', () => {
      for (const stack of Object.values(stackTemplates)) {
        // All production stacks require video input - compute dynamically
        const requiredInputs = stackRunner.getRequiredInputs(stack);
        const result = stackRunner.validate(stack, requiredInputs);
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('processor swap validation', () => {
    it('should allow swapping photoroom-bg-remove with claid-bg-remove', () => {
      const result = stackRunner.validateSwaps({
        'photoroom-bg-remove': 'claid-bg-remove',
      });

      expect(result.valid).toBe(true);
    });

    it('should reject swapping incompatible processors', () => {
      const result = stackRunner.validateSwaps({
        download: 'score-frames', // download produces video, score-frames requires images
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('stack configuration', () => {
    it('should apply processor swaps to stack', () => {
      const steps = stackRunner.applyConfig(customBgRemovalStack, {
        processorSwaps: { 'photoroom-bg-remove': 'claid-bg-remove' },
      });

      const processorIds = steps.map((s) => s.processor);
      expect(processorIds).toContain('claid-bg-remove');
      expect(processorIds).not.toContain('photoroom-bg-remove');
    });

    it('should insert processors into stack', () => {
      const originalLength = classicStack.steps.length;

      const steps = stackRunner.applyConfig(classicStack, {
        insertProcessors: [{ after: 'extract-frames', processor: 'rotate-image' }],
      });

      expect(steps).toHaveLength(originalLength + 1);

      const extractIdx = steps.findIndex((s) => s.processor === 'extract-frames');
      expect(steps[extractIdx + 1].processor).toBe('rotate-image');
    });

    it('should apply processor options', () => {
      const steps = stackRunner.applyConfig(classicStack, {
        processorOptions: {
          'extract-frames': { fps: 30 },
        },
      });

      const extractStep = steps.find((s) => s.processor === 'extract-frames');
      expect(extractStep?.options?.fps).toBe(30);
    });
  });

  describe('IO flow validation', () => {
    it('should track IO availability through classic stack', () => {
      // After download
      expect(stackRunner.getAvailableIO(classicStack, 0)).toContain('video');

      // After extract-frames (produces images and frames)
      expect(stackRunner.getAvailableIO(classicStack, 1)).toContain('video');
      expect(stackRunner.getAvailableIO(classicStack, 1)).toContain('images');
      expect(stackRunner.getAvailableIO(classicStack, 1)).toContain('frames');

      // After score-frames (produces scores)
      expect(stackRunner.getAvailableIO(classicStack, 2)).toContain('scores');
    });

    it('should track IO availability through gemini video stack', () => {
      // After download
      expect(stackRunner.getAvailableIO(geminiVideoStack, 0)).toContain('video');

      // After gemini-video-analysis (produces images, frames, and classifications)
      expect(stackRunner.getAvailableIO(geminiVideoStack, 1)).toContain('images');
      expect(stackRunner.getAvailableIO(geminiVideoStack, 1)).toContain('frames');
      expect(stackRunner.getAvailableIO(geminiVideoStack, 1)).toContain('classifications');
    });
  });

  describe('processor lookup', () => {
    it('should find producers of video', () => {
      const producers = processorRegistry.getProducers('video');
      const ids = producers.map((p) => p.id);

      expect(ids).toContain('download');
    });

    it('should find consumers of video', () => {
      const consumers = processorRegistry.getConsumers('video');
      const ids = consumers.map((p) => p.id);

      expect(ids).toContain('extract-frames');
      expect(ids).toContain('gemini-video-analysis');
    });

    it('should find all image transformers', () => {
      const imageToImage = processorRegistry.getAll().filter(
        (p) => p.io.requires.includes('images') && p.io.produces.includes('images')
      );

      const ids = imageToImage.map((p) => p.id);
      expect(ids).toContain('score-frames');
      expect(ids).toContain('photoroom-bg-remove');
      expect(ids).toContain('claid-bg-remove');
      expect(ids).toContain('center-product');
      expect(ids).toContain('rotate-image');
    });
  });

  describe('registry summary', () => {
    it('should provide complete summary of all processors', () => {
      const summary = processorRegistry.summary();

      expect(summary.length).toBeGreaterThan(0);

      for (const item of summary) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('displayName');
        expect(item).toHaveProperty('requires');
        expect(item).toHaveProperty('produces');
      }
    });
  });

  describe('custom stack creation', () => {
    it('should create and validate custom stacks', () => {
      const customStack = stackRunner.createStack('custom', 'Custom Stack', [
        { processor: 'download' },
        { processor: 'extract-frames' },
        { processor: 'score-frames' },
        { processor: 'filter-by-score' },
        { processor: 'upload-frames' },
        { processor: 'complete-job' },
      ]);

      // Pass initialIO: ['video'] since download requires video input
      const result = stackRunner.validate(customStack, ['video']);

      expect(result.valid).toBe(true);
    });

    it('should reject invalid custom stacks', () => {
      const invalidStack = stackRunner.createStack('invalid', 'Invalid Stack', [
        { processor: 'download' },
        // Missing extract-frames, jumping to score-frames which needs images
        { processor: 'score-frames' },
      ]);

      // Even with video input, this should fail because score-frames needs images
      const result = stackRunner.validate(invalidStack, ['video']);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("requires 'images'");
    });
  });
});

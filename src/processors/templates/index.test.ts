/**
 * Stack Templates Tests
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  stackTemplates,
  getStackTemplate,
  getStackTemplateIds,
  getDefaultStackId,
  classicStack,
  geminiVideoStack,
  minimalStack,
  framesOnlyStack,
  customBgRemovalStack,
} from './index.js';
import { PipelineStrategy } from '../../types/config.types.js';

// Mock logger for processor setup
vi.mock('../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock config for processor setup
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    apis: { googleAi: 'test-key', geminiModel: 'test', geminiVideoModel: 'test' },
    worker: { apiRetryDelayMs: 100 },
    storage: { bucket: 'test', endpoint: 'http://localhost:9000' },
  })),
}));

// Mock services
vi.mock('../../services/storage.service.js', () => ({ storageService: {} }));
vi.mock('../../services/frame-scoring.service.js', () => ({ frameScoringService: {} }));
vi.mock('../../services/video.service.js', () => ({ videoService: {} }));
vi.mock('../../services/photoroom.service.js', () => ({ photoroomService: {} }));
vi.mock('../../services/gemini.service.js', () => ({ geminiService: {} }));
vi.mock('../../db/index.js', () => ({ getDatabase: vi.fn(), schema: {} }));
vi.mock('../../providers/setup.js', () => ({
  getProductExtractionProvider: vi.fn(),
  getImageTransformProvider: vi.fn(),
  getBackgroundRemovalProvider: vi.fn(),
}));
vi.mock('../../providers/implementations/gemini-video-analysis.provider.js', () => ({
  GeminiVideoAnalysisProvider: vi.fn(),
  geminiVideoAnalysisProvider: {},
}));

describe('Stack Templates', () => {
  describe('stackTemplates', () => {
    it('should contain all defined stacks', () => {
      expect(stackTemplates).toHaveProperty('classic');
      expect(stackTemplates).toHaveProperty('gemini_video');
      expect(stackTemplates).toHaveProperty('minimal');
      expect(stackTemplates).toHaveProperty('frames_only');
      expect(stackTemplates).toHaveProperty('custom_bg_removal');
    });

    it('should have matching IDs', () => {
      expect(stackTemplates.classic.id).toBe('classic');
      expect(stackTemplates.gemini_video.id).toBe('gemini_video');
      expect(stackTemplates.minimal.id).toBe('minimal');
      expect(stackTemplates.frames_only.id).toBe('frames_only');
      expect(stackTemplates.custom_bg_removal.id).toBe('custom_bg_removal');
    });
  });

  describe('classicStack', () => {
    it('should have correct id and name', () => {
      expect(classicStack.id).toBe('classic');
      expect(classicStack.name).toBe('Classic Pipeline');
    });

    it('should have the correct processor order', () => {
      const processorIds = classicStack.steps.map((s) => s.processor);

      expect(processorIds).toEqual([
        'download',
        'extract-frames',
        'score-frames',
        'gemini-classify',
        'save-frame-records',
        'claid-bg-remove',
        'fill-product-holes',
        'center-product',
        'upload-frames',
        'generate-commercial',
        'complete-job',
      ]);
    });

    it('should start with download', () => {
      expect(classicStack.steps[0].processor).toBe('download');
    });

    it('should end with complete-job', () => {
      expect(classicStack.steps[classicStack.steps.length - 1].processor).toBe('complete-job');
    });
  });

  describe('geminiVideoStack', () => {
    it('should have correct id and name', () => {
      expect(geminiVideoStack.id).toBe('gemini_video');
      expect(geminiVideoStack.name).toBe('Gemini Video Pipeline');
    });

    it('should have the correct processor order', () => {
      const processorIds = geminiVideoStack.steps.map((s) => s.processor);

      expect(processorIds).toEqual([
        'download',
        'gemini-video-analysis',
        'save-frame-records',
        'claid-bg-remove',
        'fill-product-holes',
        'center-product',
        'upload-frames',
        'generate-commercial',
        'complete-job',
      ]);
    });

    it('should use gemini-video-analysis instead of extract-frames', () => {
      const processorIds = geminiVideoStack.steps.map((s) => s.processor);

      expect(processorIds).toContain('gemini-video-analysis');
      expect(processorIds).not.toContain('extract-frames');
      expect(processorIds).not.toContain('score-frames');
    });
  });

  describe('minimalStack', () => {
    it('should have correct id and name', () => {
      expect(minimalStack.id).toBe('minimal');
      expect(minimalStack.name).toBe('Minimal Pipeline');
    });

    it('should not include commercial generation', () => {
      const processorIds = minimalStack.steps.map((s) => s.processor);

      expect(processorIds).not.toContain('generate-commercial');
      expect(processorIds).not.toContain('extract-products');
    });

    it('should include basic frame extraction and upload', () => {
      const processorIds = minimalStack.steps.map((s) => s.processor);

      expect(processorIds).toContain('download');
      expect(processorIds).toContain('extract-frames');
      expect(processorIds).toContain('score-frames');
      expect(processorIds).toContain('upload-frames');
    });
  });

  describe('framesOnlyStack', () => {
    it('should have correct id and name', () => {
      expect(framesOnlyStack.id).toBe('frames_only');
      expect(framesOnlyStack.name).toBe('Frames Only Pipeline');
    });

    it('should skip AI classification', () => {
      const processorIds = framesOnlyStack.steps.map((s) => s.processor);

      expect(processorIds).not.toContain('gemini-classify');
      expect(processorIds).toContain('filter-by-score');
    });
  });

  describe('customBgRemovalStack', () => {
    it('should have correct id and name', () => {
      expect(customBgRemovalStack.id).toBe('custom_bg_removal');
      expect(customBgRemovalStack.name).toBe('Custom Background Removal');
    });

    it('should include photoroom-bg-remove (swappable)', () => {
      const processorIds = customBgRemovalStack.steps.map((s) => s.processor);

      expect(processorIds).toContain('photoroom-bg-remove');
    });

    it('should include center-product', () => {
      const processorIds = customBgRemovalStack.steps.map((s) => s.processor);

      expect(processorIds).toContain('center-product');
    });
  });

  describe('getStackTemplate', () => {
    it('should return stack template by ID', () => {
      expect(getStackTemplate('classic')).toBe(classicStack);
      expect(getStackTemplate('gemini_video')).toBe(geminiVideoStack);
      expect(getStackTemplate('minimal')).toBe(minimalStack);
    });

    it('should return undefined for unknown ID', () => {
      expect(getStackTemplate('nonexistent')).toBeUndefined();
    });
  });

  describe('getStackTemplateIds', () => {
    it('should return all template IDs', () => {
      const ids = getStackTemplateIds();

      expect(ids).toContain('classic');
      expect(ids).toContain('gemini_video');
      expect(ids).toContain('minimal');
      expect(ids).toContain('frames_only');
      expect(ids).toContain('custom_bg_removal');
      expect(ids).toHaveLength(5);
    });
  });

  describe('getDefaultStackId', () => {
    it('should return classic for CLASSIC strategy', () => {
      expect(getDefaultStackId(PipelineStrategy.CLASSIC)).toBe('classic');
    });

    it('should return gemini_video for GEMINI_VIDEO strategy', () => {
      expect(getDefaultStackId(PipelineStrategy.GEMINI_VIDEO)).toBe('gemini_video');
    });
  });

  describe('stack structure validation', () => {
    const allStacks = [
      classicStack,
      geminiVideoStack,
      minimalStack,
      framesOnlyStack,
      customBgRemovalStack,
    ];

    it.each(allStacks)('$name should have required properties', (stack) => {
      expect(stack).toHaveProperty('id');
      expect(stack).toHaveProperty('name');
      expect(stack).toHaveProperty('steps');
      expect(Array.isArray(stack.steps)).toBe(true);
      expect(stack.steps.length).toBeGreaterThan(0);
    });

    it.each(allStacks)('$name should have valid step definitions', (stack) => {
      for (const step of stack.steps) {
        expect(step).toHaveProperty('processor');
        expect(typeof step.processor).toBe('string');
        expect(step.processor.length).toBeGreaterThan(0);
      }
    });

    it.each(allStacks)('$name should start with download', (stack) => {
      expect(stack.steps[0].processor).toBe('download');
    });

    it.each(allStacks)('$name should end with complete-job', (stack) => {
      expect(stack.steps[stack.steps.length - 1].processor).toBe('complete-job');
    });
  });

  describe('stack IO validation (dynamic computation)', () => {
    // Import these dynamically to ensure mocks are set up first
    let stackRunner: typeof import('../runner.js').stackRunner;
    let setupProcessors: typeof import('../setup.js').setupProcessors;
    let processorRegistry: typeof import('../registry.js').processorRegistry;

    beforeAll(async () => {
      const runnerModule = await import('../runner.js');
      const setupModule = await import('../setup.js');
      const registryModule = await import('../registry.js');

      stackRunner = runnerModule.stackRunner;
      setupProcessors = setupModule.setupProcessors;
      processorRegistry = registryModule.processorRegistry;

      processorRegistry.clear();
      setupProcessors();
    });

    afterAll(() => {
      processorRegistry.clear();
    });

    it('all production stacks should validate with video input', () => {
      for (const stack of Object.values(stackTemplates)) {
        // All production stacks start with download which requires video
        const result = stackRunner.validate(stack, ['video']);
        expect(result.valid).toBe(true);
      }
    });

    it('should dynamically compute requiredInputs from first processor', () => {
      // classicStack starts with download which requires 'video'
      const inputs = stackRunner.getRequiredInputs(classicStack);
      expect(inputs).toContain('video');
    });

    it('should dynamically compute producedOutputs from all processors', () => {
      const outputs = stackRunner.getProducedOutputs(classicStack);
      expect(outputs).toContain('video');
      expect(outputs).toContain('images');
      expect(outputs).toContain('frames');
      expect(outputs).toContain('scores');
      expect(outputs).toContain('classifications');
    });

    it('framesOnlyStack should NOT produce classifications (no AI)', () => {
      const outputs = stackRunner.getProducedOutputs(framesOnlyStack);
      expect(outputs).not.toContain('classifications');
    });

    it('classicStack should produce classifications (uses gemini-classify)', () => {
      const outputs = stackRunner.getProducedOutputs(classicStack);
      expect(outputs).toContain('classifications');
    });

    it('geminiVideoStack should produce classifications (uses gemini-video-analysis)', () => {
      const outputs = stackRunner.getProducedOutputs(geminiVideoStack);
      expect(outputs).toContain('classifications');
    });

    it('getStackIOSummary should return computed IO', () => {
      const summary = stackRunner.getStackIOSummary(classicStack);
      expect(summary.id).toBe('classic');
      expect(summary.name).toBe('Classic Pipeline');
      expect(summary.requiredInputs).toContain('video');
      expect(summary.producedOutputs).toContain('classifications');
    });
  });
});

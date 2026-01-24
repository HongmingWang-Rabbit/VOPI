/**
 * StackRunner Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { StackRunner } from './runner.js';
import { processorRegistry } from './registry.js';
import type {
  Processor,
  ProcessorContext,
  PipelineData,
  ProcessorResult,
  StackTemplate,
  StackConfig,
  DataPath,
} from './types.js';
import { JobStatus } from '../types/job.types.js';
import type { Job } from '../db/schema.js';
import type { PipelineTimer } from '../utils/timer.js';

// Helper to create mock processors
function createMockProcessor(
  id: string,
  requires: DataPath[],
  produces: DataPath[],
  executeFn?: (context: ProcessorContext, data: PipelineData) => Promise<ProcessorResult>
): Processor {
  return {
    id,
    displayName: `Mock ${id}`,
    statusKey: JobStatus.EXTRACTING,
    io: { requires, produces },
    execute: executeFn || (async () => ({ success: true })),
  };
}

// Helper to create mock context
function createMockContext(overrides?: Partial<ProcessorContext>): ProcessorContext {
  const mockTimer = {
    startStep: vi.fn(),
    endStep: vi.fn(),
    timeOperation: vi.fn().mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as PipelineTimer;

  return {
    job: { id: 'job-1', videoUrl: 'https://example.com/video.mp4' } as Job,
    jobId: 'job-1',
    config: {
      fps: 10,
      batchSize: 30,
      commercialVersions: ['transparent', 'solid'],
      aiCleanup: true,
      geminiModel: 'gemini-2.0-flash',
    },
    workDirs: {
      root: '/tmp/job-1',
      video: '/tmp/job-1/video',
      frames: '/tmp/job-1/frames',
      candidates: '/tmp/job-1/candidates',
      extracted: '/tmp/job-1/extracted',
      final: '/tmp/job-1/final',
      commercial: '/tmp/job-1/commercial',
    },
    onProgress: vi.fn(),
    timer: mockTimer,
    effectiveConfig: {
      pipelineStrategy: 'classic',
      fps: 10,
      batchSize: 30,
      geminiModel: 'gemini-2.0-flash',
      geminiVideoModel: 'gemini-2.0-flash',
      geminiImageModel: 'gemini-2.5-flash-image',
      temperature: 0.2,
      topP: 0.8,
      motionAlpha: 0.3,
      minTemporalGap: 1,
      topKPercent: 0.3,
      commercialVersions: ['transparent', 'solid'],
      aiCleanup: true,
      geminiVideoFps: 1,
      geminiVideoMaxFrames: 10,
      debugEnabled: false,
    },
    ...overrides,
  };
}

describe('StackRunner', () => {
  let runner: StackRunner;

  beforeEach(() => {
    runner = new StackRunner();
    processorRegistry.clear();
  });

  describe('validate', () => {
    it('should validate a valid stack', () => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));
      processorRegistry.register(createMockProcessor('extract', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('upload', ['images'], ['text']));

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'download' },
          { processor: 'extract' },
          { processor: 'upload' },
        ],
      };

      const result = runner.validate(stack);

      expect(result.valid).toBe(true);
      expect(result.availableOutputs).toContain('video');
      expect(result.availableOutputs).toContain('images');
      expect(result.availableOutputs).toContain('text');
    });

    it('should fail if processor not found', () => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'download' },
          { processor: 'nonexistent' },
        ],
      };

      const result = runner.validate(stack);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Processor 'nonexistent' not found");
    });

    it('should fail if IO requirements not met', () => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));
      processorRegistry.register(createMockProcessor('upload', ['images'], ['text']));

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'download' },
          { processor: 'upload' }, // Requires images but only video is available
        ],
      };

      const result = runner.validate(stack);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("requires 'images' but it's not available");
    });

    it('should accumulate outputs through the stack', () => {
      processorRegistry.register(createMockProcessor('step1', [], ['video']));
      processorRegistry.register(createMockProcessor('step2', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('step3', ['video', 'images'], ['text']));

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'step1' },
          { processor: 'step2' },
          { processor: 'step3' },
        ],
      };

      const result = runner.validate(stack);

      expect(result.valid).toBe(true);
    });

    it('should validate stack with initial IO types', () => {
      // No download processor - starts with extract which requires video
      processorRegistry.register(createMockProcessor('extract', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('upload', ['images'], ['text']));

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'extract' },
          { processor: 'upload' },
        ],
      };

      // Without initial data, validation should fail
      const resultWithoutInitial = runner.validate(stack);
      expect(resultWithoutInitial.valid).toBe(false);
      expect(resultWithoutInitial.error).toContain("requires 'video' but it's not available");

      // With initial video data, validation should pass
      const resultWithInitial = runner.validate(stack, { metadata: {}, video: { sourceUrl: 'test' } });
      expect(resultWithInitial.valid).toBe(true);
      expect(resultWithInitial.availableOutputs).toContain('video');
      expect(resultWithInitial.availableOutputs).toContain('images');
      expect(resultWithInitial.availableOutputs).toContain('text');
    });

    it('should validate stack with multiple initial data paths', () => {
      processorRegistry.register(createMockProcessor('process', ['images', 'text'], ['images']));

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'process' }],
      };

      // With both required initial data
      const result = runner.validate(stack, { metadata: {}, images: ['img.jpg'], text: 'test' });
      expect(result.valid).toBe(true);
    });
  });

  describe('validateSwaps', () => {
    it('should validate compatible processor swaps', () => {
      processorRegistry.register(createMockProcessor('proc-a', ['images'], ['images']));
      processorRegistry.register(createMockProcessor('proc-b', ['images'], ['images']));

      const result = runner.validateSwaps({ 'proc-a': 'proc-b' });

      expect(result.valid).toBe(true);
    });

    it('should reject swaps with incompatible IO', () => {
      processorRegistry.register(createMockProcessor('proc-a', ['images'], ['images']));
      processorRegistry.register(createMockProcessor('proc-b', ['images'], ['text']));

      const result = runner.validateSwaps({ 'proc-a': 'proc-b' });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("data path contracts don't match");
    });

    it('should reject swaps with nonexistent processors', () => {
      processorRegistry.register(createMockProcessor('proc-a', ['images'], ['images']));

      const result = runner.validateSwaps({ 'proc-a': 'nonexistent' });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Replacement processor 'nonexistent' not found");
    });
  });

  describe('applyConfig', () => {
    beforeEach(() => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));
      processorRegistry.register(createMockProcessor('extract', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('upload', ['images'], ['text']));
      processorRegistry.register(createMockProcessor('alt-extract', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('transform', ['images'], ['images']));
    });

    it('should apply processor swaps', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'download' },
          { processor: 'extract' },
          { processor: 'upload' },
        ],
      };

      const config: StackConfig = {
        processorSwaps: { extract: 'alt-extract' },
      };

      const steps = runner.applyConfig(stack, config);

      expect(steps[1].processor).toBe('alt-extract');
    });

    it('should insert processors after specified step', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'download' },
          { processor: 'extract' },
          { processor: 'upload' },
        ],
      };

      const config: StackConfig = {
        insertProcessors: [{ after: 'extract', processor: 'transform' }],
      };

      const steps = runner.applyConfig(stack, config);

      expect(steps).toHaveLength(4);
      expect(steps[2].processor).toBe('transform');
    });

    it('should apply processor options', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'download' },
          { processor: 'extract', options: { fps: 5 } },
        ],
      };

      const config: StackConfig = {
        processorOptions: {
          extract: { fps: 30, quality: 'high' },
        },
      };

      const steps = runner.applyConfig(stack, config);

      expect(steps[1].options).toEqual({ fps: 30, quality: 'high' });
    });

    it('should merge processor options with existing options', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'extract', options: { fps: 5, existing: true } }],
      };

      const config: StackConfig = {
        processorOptions: {
          extract: { fps: 30 },
        },
      };

      const steps = runner.applyConfig(stack, config);

      expect(steps[0].options).toEqual({ fps: 30, existing: true });
    });
  });

  describe('execute', () => {
    it('should execute all processors in order', async () => {
      const executionOrder: string[] = [];

      processorRegistry.register(
        createMockProcessor('step1', [], ['video'], async () => {
          executionOrder.push('step1');
          return { success: true, data: { video: { path: '/video.mp4' } } };
        })
      );
      processorRegistry.register(
        createMockProcessor('step2', ['video'], ['images'], async () => {
          executionOrder.push('step2');
          return { success: true, data: { images: ['/frame1.jpg'] } };
        })
      );
      processorRegistry.register(
        createMockProcessor('step3', ['images'], ['text'], async () => {
          executionOrder.push('step3');
          return { success: true, data: { text: 'done' } };
        })
      );

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'step1' },
          { processor: 'step2' },
          { processor: 'step3' },
        ],
      };

      const context = createMockContext();
      const result = await runner.execute(stack, context);

      expect(executionOrder).toEqual(['step1', 'step2', 'step3']);
      expect(result.text).toBe('done');
    });

    it('should pass and merge data between processors', async () => {
      processorRegistry.register(
        createMockProcessor('step1', [], ['video'], async () => {
          return { success: true, data: { video: { path: '/video.mp4' }, custom1: 'value1' } };
        })
      );
      processorRegistry.register(
        createMockProcessor('step2', ['video'], ['images'], async (_ctx, data) => {
          return {
            success: true,
            data: { images: ['/frame.jpg'], receivedVideo: data.video, custom2: 'value2' },
          };
        })
      );

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'step1' }, { processor: 'step2' }],
      };

      const context = createMockContext();
      const result = await runner.execute(stack, context);

      expect(result.custom1).toBe('value1');
      expect(result.custom2).toBe('value2');
      expect(result.video).toEqual({ path: '/video.mp4' });
      expect(result.receivedVideo).toEqual({ path: '/video.mp4' });
    });

    it('should throw if processor fails', async () => {
      processorRegistry.register(
        createMockProcessor('step1', [], ['video'], async () => {
          return { success: false, error: 'Download failed' };
        })
      );

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'step1' }],
      };

      const context = createMockContext();

      await expect(runner.execute(stack, context)).rejects.toThrow('Download failed');
    });

    it('should stop execution if skip flag is set', async () => {
      const executionOrder: string[] = [];

      processorRegistry.register(
        createMockProcessor('step1', [], ['video'], async () => {
          executionOrder.push('step1');
          return { success: true, skip: true };
        })
      );
      processorRegistry.register(
        createMockProcessor('step2', ['video'], ['images'], async () => {
          executionOrder.push('step2');
          return { success: true };
        })
      );

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'step1' }, { processor: 'step2' }],
      };

      const context = createMockContext();
      await runner.execute(stack, context);

      expect(executionOrder).toEqual(['step1']);
    });

    it('should skip processors when condition returns false', async () => {
      const executionOrder: string[] = [];

      processorRegistry.register(
        createMockProcessor('step1', [], ['video'], async () => {
          executionOrder.push('step1');
          return { success: true, data: { shouldSkip: true } };
        })
      );
      processorRegistry.register(
        createMockProcessor('step2', ['video'], ['images'], async () => {
          executionOrder.push('step2');
          return { success: true };
        })
      );
      processorRegistry.register(
        createMockProcessor('step3', ['video'], ['text'], async () => {
          executionOrder.push('step3');
          return { success: true };
        })
      );

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'step1' },
          { processor: 'step2', condition: (data) => !data.shouldSkip },
          { processor: 'step3' },
        ],
      };

      const context = createMockContext();
      await runner.execute(stack, context);

      expect(executionOrder).toEqual(['step1', 'step3']);
    });

    it('should apply config before execution', async () => {
      processorRegistry.register(
        createMockProcessor('original', ['video'], ['images'], async () => {
          return { success: true, data: { usedProcessor: 'original' } };
        })
      );
      processorRegistry.register(
        createMockProcessor('replacement', ['video'], ['images'], async () => {
          return { success: true, data: { usedProcessor: 'replacement' } };
        })
      );
      processorRegistry.register(
        createMockProcessor('download', [], ['video'], async () => {
          return { success: true, data: { video: { path: '/video.mp4' } } };
        })
      );

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'download' }, { processor: 'original' }],
      };

      const config: StackConfig = {
        processorSwaps: { original: 'replacement' },
      };

      const context = createMockContext();
      const result = await runner.execute(stack, context, config);

      expect(result.usedProcessor).toBe('replacement');
    });

    it('should throw on invalid processor swaps', async () => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));
      processorRegistry.register(createMockProcessor('proc-a', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('proc-b', ['video'], ['text'])); // Different output

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'download' }, { processor: 'proc-a' }],
      };

      const config: StackConfig = {
        processorSwaps: { 'proc-a': 'proc-b' },
      };

      const context = createMockContext();

      await expect(runner.execute(stack, context, config)).rejects.toThrow(
        'Invalid processor swaps'
      );
    });

    it('should use initial data if provided', async () => {
      // Note: Initial data is merged with the execution data but doesn't affect validation.
      // The stack must still be valid (IO requirements met by processor outputs).
      processorRegistry.register(
        createMockProcessor('download', [], ['video'], async () => {
          // This won't override initial data since we merge results
          return { success: true };
        })
      );
      processorRegistry.register(
        createMockProcessor('process', ['video'], ['images'], async (_ctx, data) => {
          return { success: true, data: { processedFrom: data.video } };
        })
      );

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'download' }, { processor: 'process' }],
      };

      const context = createMockContext();
      const initialData: PipelineData = { metadata: {}, video: { path: '/initial-video.mp4' } };

      const result = await runner.execute(stack, context, undefined, initialData);

      // The initial video data is preserved and used by process
      expect(result.processedFrom).toEqual({ path: '/initial-video.mp4' });
    });
  });

  describe('createStack', () => {
    it('should create a stack template', () => {
      const stack = runner.createStack('custom', 'Custom Stack', [
        { processor: 'download' },
        { processor: 'extract' },
      ]);

      expect(stack.id).toBe('custom');
      expect(stack.name).toBe('Custom Stack');
      expect(stack.steps).toHaveLength(2);
    });
  });

  describe('getAvailableIO', () => {
    beforeEach(() => {
      processorRegistry.register(createMockProcessor('step1', [], ['video']));
      processorRegistry.register(createMockProcessor('step2', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('step3', ['images'], ['text']));
    });

    it('should return available IO types up to specified step', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'step1' },
          { processor: 'step2' },
          { processor: 'step3' },
        ],
      };

      expect(runner.getAvailableIO(stack, 0)).toEqual(new Set(['video']));
      expect(runner.getAvailableIO(stack, 1)).toEqual(new Set(['video', 'images']));
      expect(runner.getAvailableIO(stack, 2)).toEqual(new Set(['video', 'images', 'text']));
    });

    it('should handle out of bounds step index', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'step1' }],
      };

      expect(runner.getAvailableIO(stack, 10)).toEqual(new Set(['video']));
    });
  });

  describe('getRequiredInputs', () => {
    beforeEach(() => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));
      processorRegistry.register(createMockProcessor('extract', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('classify', ['images'], ['text']));
    });

    it('should return empty array for stack starting with no-requirement processor', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'download' }, { processor: 'extract' }],
      };

      expect(runner.getRequiredInputs(stack)).toEqual([]);
    });

    it('should return required inputs from first processor', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'extract' }, { processor: 'classify' }],
      };

      expect(runner.getRequiredInputs(stack)).toEqual(['video']);
    });

    it('should return empty array for empty stack', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [],
      };

      expect(runner.getRequiredInputs(stack)).toEqual([]);
    });

    it('should return empty array for unknown first processor', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'unknown-processor' }],
      };

      expect(runner.getRequiredInputs(stack)).toEqual([]);
    });
  });

  describe('getProducedOutputs', () => {
    beforeEach(() => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));
      processorRegistry.register(createMockProcessor('extract', ['video'], ['images']));
      processorRegistry.register(createMockProcessor('classify', ['images'], ['text']));
    });

    it('should return all outputs produced by stack processors', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [
          { processor: 'download' },
          { processor: 'extract' },
          { processor: 'classify' },
        ],
      };

      const outputs = runner.getProducedOutputs(stack);
      expect(outputs).toContain('video');
      expect(outputs).toContain('images');
      expect(outputs).toContain('text');
      expect(outputs).toHaveLength(3);
    });

    it('should return empty array for empty stack', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [],
      };

      expect(runner.getProducedOutputs(stack)).toEqual([]);
    });

    it('should not duplicate outputs', () => {
      processorRegistry.register(createMockProcessor('step-a', [], ['images']));
      processorRegistry.register(createMockProcessor('step-b', ['images'], ['images'])); // Same output

      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'step-a' }, { processor: 'step-b' }],
      };

      const outputs = runner.getProducedOutputs(stack);
      expect(outputs).toEqual(['images']);
    });
  });

  describe('getStackIOSummary', () => {
    beforeEach(() => {
      processorRegistry.register(createMockProcessor('download', [], ['video']));
      processorRegistry.register(createMockProcessor('extract', ['video'], ['images']));
    });

    it('should return computed IO summary', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'download' }, { processor: 'extract' }],
      };

      const summary = runner.getStackIOSummary(stack);

      expect(summary.id).toBe('test');
      expect(summary.name).toBe('Test Stack');
      expect(summary.requiredInputs).toEqual([]);  // download has no requirements
      expect(summary.producedOutputs).toContain('video');
      expect(summary.producedOutputs).toContain('images');
    });

    it('should compute requiredInputs from first processor', () => {
      const stack: StackTemplate = {
        id: 'test',
        name: 'Test Stack',
        steps: [{ processor: 'extract' }],  // extract requires video
      };

      const summary = runner.getStackIOSummary(stack);
      expect(summary.requiredInputs).toContain('video');
    });
  });
});

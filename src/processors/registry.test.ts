/**
 * ProcessorRegistry Tests
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

import { ProcessorRegistry } from './registry.js';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, IOType } from './types.js';
import { JobStatus } from '../types/job.types.js';

// Helper to create mock processors
function createMockProcessor(
  id: string,
  requires: IOType[],
  produces: IOType[]
): Processor {
  return {
    id,
    displayName: `Mock ${id}`,
    statusKey: JobStatus.EXTRACTING,
    io: { requires, produces },
    async execute(
      _context: ProcessorContext,
      _data: PipelineData,
      _options?: Record<string, unknown>
    ): Promise<ProcessorResult> {
      return { success: true };
    },
  };
}

describe('ProcessorRegistry', () => {
  let registry: ProcessorRegistry;

  beforeEach(() => {
    registry = new ProcessorRegistry();
  });

  describe('register', () => {
    it('should register a processor', () => {
      const processor = createMockProcessor('test-proc', [], ['video']);
      registry.register(processor);

      expect(registry.has('test-proc')).toBe(true);
      expect(registry.get('test-proc')).toBe(processor);
    });

    it('should allow overwriting existing processors', () => {
      const proc1 = createMockProcessor('test-proc', [], ['video']);
      const proc2 = createMockProcessor('test-proc', [], ['images']);

      registry.register(proc1);
      registry.register(proc2);

      expect(registry.get('test-proc')).toBe(proc2);
    });
  });

  describe('registerAll', () => {
    it('should register multiple processors', () => {
      const processors = [
        createMockProcessor('proc-1', [], ['video']),
        createMockProcessor('proc-2', ['video'], ['images']),
        createMockProcessor('proc-3', ['images'], ['classifications']),
      ];

      registry.registerAll(processors);

      expect(registry.getIds()).toHaveLength(3);
      expect(registry.has('proc-1')).toBe(true);
      expect(registry.has('proc-2')).toBe(true);
      expect(registry.has('proc-3')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return processor if found', () => {
      const processor = createMockProcessor('test-proc', [], ['video']);
      registry.register(processor);

      expect(registry.get('test-proc')).toBe(processor);
    });

    it('should return undefined if not found', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getOrThrow', () => {
    it('should return processor if found', () => {
      const processor = createMockProcessor('test-proc', [], ['video']);
      registry.register(processor);

      expect(registry.getOrThrow('test-proc')).toBe(processor);
    });

    it('should throw if processor not found', () => {
      expect(() => registry.getOrThrow('nonexistent')).toThrow(
        "Processor 'nonexistent' not found in registry"
      );
    });
  });

  describe('has', () => {
    it('should return true if processor exists', () => {
      registry.register(createMockProcessor('test-proc', [], ['video']));
      expect(registry.has('test-proc')).toBe(true);
    });

    it('should return false if processor does not exist', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('getIds', () => {
    it('should return all registered processor IDs', () => {
      registry.register(createMockProcessor('proc-a', [], ['video']));
      registry.register(createMockProcessor('proc-b', ['video'], ['images']));

      const ids = registry.getIds();
      expect(ids).toContain('proc-a');
      expect(ids).toContain('proc-b');
      expect(ids).toHaveLength(2);
    });

    it('should return empty array if no processors registered', () => {
      expect(registry.getIds()).toEqual([]);
    });
  });

  describe('getAll', () => {
    it('should return all registered processors', () => {
      const proc1 = createMockProcessor('proc-a', [], ['video']);
      const proc2 = createMockProcessor('proc-b', ['video'], ['images']);

      registry.register(proc1);
      registry.register(proc2);

      const all = registry.getAll();
      expect(all).toContain(proc1);
      expect(all).toContain(proc2);
      expect(all).toHaveLength(2);
    });
  });

  describe('getProducers', () => {
    it('should return processors that produce a specific IO type', () => {
      const videoProducer = createMockProcessor('video-prod', [], ['video']);
      const imageProducer = createMockProcessor('image-prod', ['video'], ['images']);
      const bothProducer = createMockProcessor('both-prod', [], ['video', 'images']);

      registry.registerAll([videoProducer, imageProducer, bothProducer]);

      const videoProducers = registry.getProducers('video');
      expect(videoProducers).toContain(videoProducer);
      expect(videoProducers).toContain(bothProducer);
      expect(videoProducers).not.toContain(imageProducer);

      const imageProducers = registry.getProducers('images');
      expect(imageProducers).toContain(imageProducer);
      expect(imageProducers).toContain(bothProducer);
      expect(imageProducers).not.toContain(videoProducer);
    });
  });

  describe('getConsumers', () => {
    it('should return processors that require a specific IO type', () => {
      const videoConsumer = createMockProcessor('video-cons', ['video'], ['images']);
      const imageConsumer = createMockProcessor('image-cons', ['images'], ['classifications']);
      const bothConsumer = createMockProcessor('both-cons', ['video', 'images'], ['classifications']);

      registry.registerAll([videoConsumer, imageConsumer, bothConsumer]);

      const videoConsumers = registry.getConsumers('video');
      expect(videoConsumers).toContain(videoConsumer);
      expect(videoConsumers).toContain(bothConsumer);
      expect(videoConsumers).not.toContain(imageConsumer);

      const imageConsumers = registry.getConsumers('images');
      expect(imageConsumers).toContain(imageConsumer);
      expect(imageConsumers).toContain(bothConsumer);
      expect(imageConsumers).not.toContain(videoConsumer);
    });
  });

  describe('areSwappable', () => {
    it('should return true for processors with same IO', () => {
      const proc1 = createMockProcessor('proc-1', ['images'], ['images']);
      const proc2 = createMockProcessor('proc-2', ['images'], ['images']);

      registry.registerAll([proc1, proc2]);

      expect(registry.areSwappable('proc-1', 'proc-2')).toBe(true);
    });

    it('should return false for processors with different requirements', () => {
      const proc1 = createMockProcessor('proc-1', ['video'], ['images']);
      const proc2 = createMockProcessor('proc-2', ['images'], ['images']);

      registry.registerAll([proc1, proc2]);

      expect(registry.areSwappable('proc-1', 'proc-2')).toBe(false);
    });

    it('should return false for processors with different outputs', () => {
      const proc1 = createMockProcessor('proc-1', ['images'], ['images']);
      const proc2 = createMockProcessor('proc-2', ['images'], ['classifications']);

      registry.registerAll([proc1, proc2]);

      expect(registry.areSwappable('proc-1', 'proc-2')).toBe(false);
    });

    it('should return false if processor not found', () => {
      const proc1 = createMockProcessor('proc-1', ['images'], ['images']);
      registry.register(proc1);

      expect(registry.areSwappable('proc-1', 'nonexistent')).toBe(false);
      expect(registry.areSwappable('nonexistent', 'proc-1')).toBe(false);
    });

    it('should handle processors with multiple IO types', () => {
      const proc1 = createMockProcessor('proc-1', ['video', 'classifications'], ['images', 'text']);
      const proc2 = createMockProcessor('proc-2', ['video', 'classifications'], ['images', 'text']);
      const proc3 = createMockProcessor('proc-3', ['classifications', 'video'], ['text', 'images']); // Same but different order

      registry.registerAll([proc1, proc2, proc3]);

      expect(registry.areSwappable('proc-1', 'proc-2')).toBe(true);
      expect(registry.areSwappable('proc-1', 'proc-3')).toBe(true); // Order shouldn't matter
    });
  });

  describe('clear', () => {
    it('should remove all registered processors', () => {
      registry.register(createMockProcessor('proc-1', [], ['video']));
      registry.register(createMockProcessor('proc-2', ['video'], ['images']));

      expect(registry.getIds()).toHaveLength(2);

      registry.clear();

      expect(registry.getIds()).toHaveLength(0);
      expect(registry.has('proc-1')).toBe(false);
      expect(registry.has('proc-2')).toBe(false);
    });
  });

  describe('summary', () => {
    it('should return summary of all processors', () => {
      registry.register(createMockProcessor('download', [], ['video']));
      registry.register(createMockProcessor('extract', ['video'], ['images']));

      const summary = registry.summary();

      expect(summary).toHaveLength(2);
      expect(summary).toContainEqual({
        id: 'download',
        displayName: 'Mock download',
        requires: [],
        produces: ['video'],
      });
      expect(summary).toContainEqual({
        id: 'extract',
        displayName: 'Mock extract',
        requires: ['video'],
        produces: ['images'],
      });
    });
  });
});

/**
 * Processor Registry
 *
 * Central registry for processor implementations.
 * Allows runtime registration and lookup of processors by ID.
 */

import type { Processor, ProcessorIO, IOType } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ service: 'processor-registry' });

/**
 * ProcessorRegistry - Manages processor instances
 */
export class ProcessorRegistry {
  private processors = new Map<string, Processor>();

  /**
   * Register a processor
   * @param processor - Processor to register
   */
  register(processor: Processor): void {
    if (this.processors.has(processor.id)) {
      logger.warn({ processorId: processor.id }, 'Overwriting existing processor');
    }
    this.processors.set(processor.id, processor);
    logger.debug({ processorId: processor.id, io: processor.io }, 'Processor registered');
  }

  /**
   * Register multiple processors
   * @param processors - Array of processors to register
   */
  registerAll(processors: Processor[]): void {
    for (const processor of processors) {
      this.register(processor);
    }
  }

  /**
   * Get a processor by ID
   * @param id - Processor ID
   * @returns Processor instance or undefined
   */
  get(id: string): Processor | undefined {
    return this.processors.get(id);
  }

  /**
   * Get a processor by ID, throwing if not found
   * @param id - Processor ID
   * @returns Processor instance
   * @throws Error if processor not found
   */
  getOrThrow(id: string): Processor {
    const processor = this.processors.get(id);
    if (!processor) {
      throw new Error(`Processor '${id}' not found in registry`);
    }
    return processor;
  }

  /**
   * Check if a processor is registered
   * @param id - Processor ID
   */
  has(id: string): boolean {
    return this.processors.has(id);
  }

  /**
   * Get all registered processor IDs
   */
  getIds(): string[] {
    return Array.from(this.processors.keys());
  }

  /**
   * Get all registered processors
   */
  getAll(): Processor[] {
    return Array.from(this.processors.values());
  }

  /**
   * Get processors that produce a specific IO type
   * @param type - IO type to look for
   */
  getProducers(type: IOType): Processor[] {
    return this.getAll().filter((p) => p.io.produces.includes(type));
  }

  /**
   * Get processors that require a specific IO type
   * @param type - IO type to look for
   */
  getConsumers(type: IOType): Processor[] {
    return this.getAll().filter((p) => p.io.requires.includes(type));
  }

  /**
   * Check if two processors have compatible IO for swapping
   * (same requirements and same outputs)
   * @param processorA - First processor ID
   * @param processorB - Second processor ID
   */
  areSwappable(processorA: string, processorB: string): boolean {
    const a = this.get(processorA);
    const b = this.get(processorB);

    if (!a || !b) return false;

    return this.ioEquals(a.io, b.io);
  }

  /**
   * Check if two IO declarations are equal
   */
  private ioEquals(a: ProcessorIO, b: ProcessorIO): boolean {
    const reqA = [...a.requires].sort();
    const reqB = [...b.requires].sort();
    const prodA = [...a.produces].sort();
    const prodB = [...b.produces].sort();

    return (
      reqA.length === reqB.length &&
      prodA.length === prodB.length &&
      reqA.every((v, i) => v === reqB[i]) &&
      prodA.every((v, i) => v === prodB[i])
    );
  }

  /**
   * Clear all registered processors
   */
  clear(): void {
    this.processors.clear();
  }

  /**
   * Get a summary of registered processors
   */
  summary(): Array<{ id: string; displayName: string; requires: string[]; produces: string[] }> {
    return this.getAll().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      requires: p.io.requires,
      produces: p.io.produces,
    }));
  }
}

/**
 * Global processor registry instance
 */
export const processorRegistry = new ProcessorRegistry();

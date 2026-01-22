/**
 * Processor Setup
 *
 * Registers all processor implementations with the registry.
 * Call this during application initialization.
 */

import { processorRegistry } from './registry.js';
import { allProcessors } from './impl/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ service: 'processor-setup' });

/**
 * Register all default processors
 */
export function setupProcessors(): void {
  logger.info('Registering processors');

  processorRegistry.registerAll(allProcessors);

  logger.info({ processorCount: allProcessors.length }, 'Processors registered');

  // Log summary
  const summary = processorRegistry.summary();
  logger.debug({ processors: summary }, 'Processor registry summary');
}

/**
 * Verify all processors are properly registered
 * @returns true if all processors are valid
 */
export function verifyProcessors(): boolean {
  const processors = processorRegistry.getAll();

  for (const processor of processors) {
    if (!processor.id) {
      logger.error({ processor: processor.displayName }, 'Processor missing ID');
      return false;
    }

    if (!processor.io) {
      logger.error({ processor: processor.id }, 'Processor missing IO declaration');
      return false;
    }

    if (!processor.execute) {
      logger.error({ processor: processor.id }, 'Processor missing execute method');
      return false;
    }
  }

  return true;
}

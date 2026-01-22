/**
 * Processors Module
 *
 * This module provides a composable processor stack architecture for pipeline execution.
 * It supports:
 * - Modular processors with declared IO types
 * - Stack composition and validation
 * - Processor swapping with compatible IO
 * - Runtime stack configuration
 *
 * Usage:
 *
 * 1. Initialize processors (call once at app startup):
 *    ```ts
 *    import { setupProcessors } from './processors/index.js';
 *    setupProcessors();
 *    ```
 *
 * 2. Execute a stack:
 *    ```ts
 *    import { stackRunner, getStackTemplate, processorRegistry } from './processors/index.js';
 *
 *    const stack = getStackTemplate('classic');
 *    const result = await stackRunner.execute(stack, context, config);
 *    ```
 *
 * 3. Swap processors:
 *    ```ts
 *    const config = {
 *      processorSwaps: {
 *        'photoroom-bg-remove': 'claid-bg-remove',  // Same IO contract
 *      },
 *    };
 *    await stackRunner.execute(stack, context, config);
 *    ```
 *
 * 4. Validate a stack:
 *    ```ts
 *    const validation = stackRunner.validate(stack);
 *    if (!validation.valid) {
 *      console.error(validation.error);
 *    }
 *    ```
 */

// Export types
export * from './types.js';

// Export constants
export * from './constants.js';

// Export registry
export { processorRegistry, ProcessorRegistry } from './registry.js';

// Export runner
export { stackRunner, StackRunner } from './runner.js';

// Export templates
export {
  stackTemplates,
  getStackTemplate,
  getStackTemplateIds,
  getDefaultStackId,
  classicStack,
  geminiVideoStack,
  minimalStack,
  framesOnlyStack,
  customBgRemovalStack,
  // Staging templates
  stagingStackTemplates,
  getStagingStackTemplate,
  getStagingStackTemplateIds,
} from './templates/index.js';

// Export setup
export { setupProcessors, verifyProcessors } from './setup.js';

// Export implementations
export * from './impl/index.js';

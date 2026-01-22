/**
 * Stack Runner
 *
 * Executes processor stacks with validation and error handling.
 * Handles processor swapping, insertion, and IO validation.
 */

import type {
  StackTemplate,
  StackStep,
  StackConfig,
  StackValidationResult,
  ProcessorContext,
  PipelineData,
  IOType,
} from './types.js';
import { processorRegistry } from './registry.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ service: 'stack-runner' });

/**
 * StackRunner - Executes processor stacks
 *
 * Uses WeakMap caching for IO computation methods to avoid repeated
 * iteration over stack steps. Cache is automatically cleared when
 * stack templates are garbage collected.
 */
export class StackRunner {
  /** Cache for getRequiredInputs results */
  private requiredInputsCache = new WeakMap<StackTemplate, IOType[]>();

  /** Cache for getProducedOutputs results */
  private producedOutputsCache = new WeakMap<StackTemplate, IOType[]>();

  /**
   * Clear IO computation caches.
   * Useful when processors are re-registered or for testing.
   */
  clearCache(): void {
    this.requiredInputsCache = new WeakMap<StackTemplate, IOType[]>();
    this.producedOutputsCache = new WeakMap<StackTemplate, IOType[]>();
  }

  /**
   * Validate a stack template
   * Checks that IO types flow correctly through the stack
   * @param stack - Stack template to validate
   * @param initialIO - Optional initial IO types available (from initialData)
   * @returns Validation result
   */
  validate(stack: StackTemplate, initialIO?: IOType[]): StackValidationResult {
    const available = new Set<IOType>(initialIO);

    for (let i = 0; i < stack.steps.length; i++) {
      const step = stack.steps[i];
      const processor = processorRegistry.get(step.processor);

      if (!processor) {
        return {
          valid: false,
          error: `Step ${i + 1}: Processor '${step.processor}' not found in registry`,
        };
      }

      // Check requirements are satisfied
      for (const req of processor.io.requires) {
        if (!available.has(req)) {
          return {
            valid: false,
            error: `Step ${i + 1}: Processor '${step.processor}' requires '${req}' but it's not available. Available: [${[...available].join(', ')}]`,
          };
        }
      }

      // Add outputs to available set
      for (const out of processor.io.produces) {
        available.add(out);
      }
    }

    return {
      valid: true,
      availableOutputs: [...available],
    };
  }

  /**
   * Validate processor swaps
   * Ensures swapped processors have compatible IO
   * @param swaps - Map of original -> replacement processor IDs
   */
  validateSwaps(swaps: Record<string, string>): StackValidationResult {
    for (const [original, replacement] of Object.entries(swaps)) {
      if (!processorRegistry.has(original)) {
        return {
          valid: false,
          error: `Original processor '${original}' not found in registry`,
        };
      }

      if (!processorRegistry.has(replacement)) {
        return {
          valid: false,
          error: `Replacement processor '${replacement}' not found in registry`,
        };
      }

      if (!processorRegistry.areSwappable(original, replacement)) {
        const origProc = processorRegistry.get(original)!;
        const replProc = processorRegistry.get(replacement)!;
        return {
          valid: false,
          error: `Cannot swap '${original}' (requires: [${origProc.io.requires}], produces: [${origProc.io.produces}]) with '${replacement}' (requires: [${replProc.io.requires}], produces: [${replProc.io.produces}]) - IO contracts don't match`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Apply configuration to a stack template
   * Handles processor swaps and insertions
   * @param stack - Base stack template
   * @param config - Stack configuration
   * @returns Modified stack steps
   */
  applyConfig(stack: StackTemplate, config: StackConfig): StackStep[] {
    let steps = [...stack.steps];

    // Apply processor swaps
    if (config.processorSwaps) {
      steps = steps.map((step) => {
        const replacement = config.processorSwaps![step.processor];
        if (replacement) {
          logger.debug({ original: step.processor, replacement }, 'Swapping processor');
          return { ...step, processor: replacement };
        }
        return step;
      });
    }

    // Apply processor insertions
    if (config.insertProcessors) {
      for (const insertion of config.insertProcessors) {
        const afterIndex = steps.findIndex((s) => s.processor === insertion.after);
        if (afterIndex === -1) {
          logger.warn({ after: insertion.after }, 'Processor to insert after not found');
          continue;
        }

        const newStep: StackStep = {
          processor: insertion.processor,
          options: insertion.options,
        };

        steps.splice(afterIndex + 1, 0, newStep);
        logger.debug({ after: insertion.after, inserted: insertion.processor }, 'Inserted processor');
      }
    }

    // Apply processor options
    if (config.processorOptions) {
      steps = steps.map((step) => {
        const options = config.processorOptions![step.processor];
        if (options) {
          return {
            ...step,
            options: { ...step.options, ...options },
          };
        }
        return step;
      });
    }

    return steps;
  }

  /**
   * Execute a stack
   * @param stack - Stack template to execute
   * @param context - Execution context
   * @param config - Optional stack configuration
   * @param initialData - Initial pipeline data
   * @returns Final pipeline data
   */
  async execute(
    stack: StackTemplate,
    context: ProcessorContext,
    config?: StackConfig,
    initialData?: PipelineData
  ): Promise<PipelineData> {
    // Validate swaps if provided
    if (config?.processorSwaps) {
      const swapValidation = this.validateSwaps(config.processorSwaps);
      if (!swapValidation.valid) {
        throw new Error(`Invalid processor swaps: ${swapValidation.error}`);
      }
    }

    // Apply configuration to get final steps
    const steps = config ? this.applyConfig(stack, config) : stack.steps;

    // Infer initial IO types from initialData
    const initialIO = this.inferIOTypes(initialData);

    // Validate the final stack with initial IO
    const validation = this.validate({ ...stack, steps }, initialIO);
    if (!validation.valid) {
      throw new Error(`Invalid stack: ${validation.error}`);
    }

    let data: PipelineData = initialData || {};

    logger.info({
      stackId: stack.id,
      jobId: context.jobId,
      stepCount: steps.length,
    }, 'Starting stack execution');

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Check condition if present
      if (step.condition && !step.condition(data, context)) {
        logger.debug({ processor: step.processor, step: i + 1 }, 'Skipping processor (condition not met)');
        continue;
      }

      const processor = processorRegistry.getOrThrow(step.processor);

      logger.info({
        processor: processor.id,
        step: i + 1,
        totalSteps: steps.length,
        jobId: context.jobId,
      }, 'Executing processor');

      // Runtime IO validation - check if declared requirements are met
      const currentIO = this.inferIOTypes(data);
      for (const req of processor.io.requires) {
        if (!currentIO.includes(req)) {
          const message = `Processor '${processor.id}' requires '${req}' but only [${currentIO.join(', ')}] available`;
          if (config?.strictIOValidation) {
            throw new Error(message);
          }
          logger.warn({
            processor: processor.id,
            missing: req,
            available: currentIO,
            jobId: context.jobId,
          }, 'Runtime IO requirement not met - processor may fail');
        }
      }

      try {
        context.timer.startStep(processor.id);

        const result = await processor.execute(context, data, step.options);

        context.timer.endStep();

        if (!result.success) {
          throw new Error(result.error || `Processor '${processor.id}' failed`);
        }

        // Merge result data
        if (result.data) {
          data = { ...data, ...result.data };
        }

        // Check for skip flag
        if (result.skip) {
          logger.info({ processor: processor.id }, 'Processor requested skip of remaining steps');
          break;
        }
      } catch (error) {
        logger.error({
          processor: processor.id,
          step: i + 1,
          error: (error as Error).message,
          jobId: context.jobId,
        }, 'Processor execution failed');
        throw error;
      }
    }

    logger.info({
      stackId: stack.id,
      jobId: context.jobId,
    }, 'Stack execution completed');

    return data;
  }

  /**
   * Infer IO types from pipeline data
   * @param data - Pipeline data to inspect
   * @returns Array of available IO types
   */
  inferIOTypes(data?: PipelineData): IOType[] {
    if (!data) return [];

    const types: IOType[] = [];

    // Core types
    if (data.video?.path || data.video?.sourceUrl) types.push('video');
    if (data.images && data.images.length > 0) types.push('images');
    if (data.text) types.push('text');

    // Frame data types
    if (data.frames && data.frames.length > 0) types.push('frames');
    if (data.scoredFrames && data.scoredFrames.length > 0) types.push('scores');
    if (data.frameRecords && data.frameRecords.size > 0) types.push('frame-records');

    // Classifications: frames with AI classification data (productId, variantId)
    // Check recommendedFrames first (typical location), then frames
    const classifiedFrames = data.recommendedFrames || data.frames;
    if (classifiedFrames && classifiedFrames.some((f) => f.productId || f.variantId)) {
      types.push('classifications');
    }

    return types;
  }

  /**
   * Create a custom stack from steps
   * @param id - Stack ID
   * @param name - Stack name
   * @param steps - Array of step definitions
   */
  createStack(id: string, name: string, steps: StackStep[]): StackTemplate {
    return { id, name, steps };
  }

  /**
   * Get available IO types after running a stack up to a certain step
   * @param stack - Stack template
   * @param upToStep - Step index (inclusive)
   */
  getAvailableIO(stack: StackTemplate, upToStep: number): Set<IOType> {
    const available = new Set<IOType>();

    for (let i = 0; i <= upToStep && i < stack.steps.length; i++) {
      const step = stack.steps[i];
      const processor = processorRegistry.get(step.processor);
      if (processor) {
        for (const out of processor.io.produces) {
          available.add(out);
        }
      }
    }

    return available;
  }

  /**
   * Get the required inputs for a stack (from the first processor)
   * Results are cached using WeakMap for performance.
   * @param stack - Stack template to analyze
   * @returns Array of required IO types, or empty array if stack is empty or first processor not found
   */
  getRequiredInputs(stack: StackTemplate): IOType[] {
    // Check cache first
    const cached = this.requiredInputsCache.get(stack);
    if (cached) return cached;

    // Compute if not cached
    if (stack.steps.length === 0) return [];

    const firstProcessor = processorRegistry.get(stack.steps[0].processor);
    if (!firstProcessor) return [];

    const result = [...firstProcessor.io.requires];

    // Cache and return
    this.requiredInputsCache.set(stack, result);
    return result;
  }

  /**
   * Get the outputs produced by a stack (accumulated from all processors)
   * Results are cached using WeakMap for performance.
   * @param stack - Stack template to analyze
   * @returns Array of IO types that will be available after stack execution
   */
  getProducedOutputs(stack: StackTemplate): IOType[] {
    // Check cache first
    const cached = this.producedOutputsCache.get(stack);
    if (cached) return cached;

    // Compute if not cached
    const outputs = new Set<IOType>();

    for (const step of stack.steps) {
      const processor = processorRegistry.get(step.processor);
      if (processor) {
        for (const out of processor.io.produces) {
          outputs.add(out);
        }
      }
    }

    const result = [...outputs];

    // Cache and return
    this.producedOutputsCache.set(stack, result);
    return result;
  }

  /**
   * Get a summary of stack IO computed from processor declarations
   * @param stack - Stack template to summarize
   * @returns Object with input/output information
   */
  getStackIOSummary(stack: StackTemplate): {
    id: string;
    name: string;
    requiredInputs: IOType[];
    producedOutputs: IOType[];
  } {
    return {
      id: stack.id,
      name: stack.name,
      requiredInputs: this.getRequiredInputs(stack),
      producedOutputs: this.getProducedOutputs(stack),
    };
  }
}

/**
 * Global stack runner instance
 */
export const stackRunner = new StackRunner();

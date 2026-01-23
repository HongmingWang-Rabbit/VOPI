/**
 * Claid Background Removal Processor
 *
 * Removes background from images using Claid.ai API.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { getInputFrames } from '../../types.js';
import { claidBackgroundRemovalProvider } from '../../../providers/implementations/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:claid-bg-remove' });

export const claidBgRemoveProcessor: Processor = {
  id: 'claid-bg-remove',
  displayName: 'Remove Background (Claid)',
  statusKey: JobStatus.EXTRACTING_PRODUCT,
  io: {
    requires: ['images', 'frames'],
    produces: ['images'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress, timer } = context;

    // Get input frames with fallback to legacy fields
    const inputFrames = getInputFrames(data);
    if (inputFrames.length === 0) {
      return { success: false, error: 'No frames for background removal' };
    }

    // Check if Claid provider is available
    if (!claidBackgroundRemovalProvider.isAvailable()) {
      logger.info({ jobId }, 'Claid provider not available (CLAID_API_KEY not set), skipping background removal');
      // Return success with no data changes - pipeline continues with next processor
      // Note: Do NOT set skip: true here, as that would skip ALL remaining processors
      return {
        success: true,
        data: {}, // No changes, keep existing data
      };
    }

    // Determine product type from options or pipeline data
    // Priority: processor options > pipeline data (metadata)
    const customPrompt = (options?.customPrompt as string) ||
                         data.metadata?.productType ||
                         (data.productType as string | undefined) ||
                         undefined;

    logger.info({
      jobId,
      frameCount: inputFrames.length,
      customPrompt: customPrompt || '(default: product)',
    }, 'Removing backgrounds with Claid');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 65,
      message: 'Removing backgrounds (Claid)',
    });

    const results = new Map<string, { success: boolean; outputPath?: string; rotationApplied: number; error?: string }>();

    // Build provider options
    const providerOptions = customPrompt ? { customPrompt } : {};

    // Process frames in parallel with concurrency limit (API rate limiting)
    const concurrency = getConcurrency('CLAID_BG_REMOVE', options);
    let processedCount = 0;

    const parallelResults = await parallelMap(
      inputFrames,
      async (frame) => {
        const outputPath = path.join(workDirs.extracted, `${frame.frameId}_transparent.png`);

        const result = await timer.timeOperation(
          'claid_remove_background',
          () => claidBackgroundRemovalProvider.removeBackground(
            frame.path,
            outputPath,
            providerOptions
          ),
          { frameId: frame.frameId }
        );

        // Update progress (thread-safe increment)
        processedCount++;
        await onProgress?.({
          status: JobStatus.EXTRACTING_PRODUCT,
          percentage: 65 + Math.round((processedCount / inputFrames.length) * 5),
          message: `Processing ${processedCount}/${inputFrames.length}`,
        });

        return {
          frameId: frame.frameId,
          success: result.success,
          outputPath: result.success ? outputPath : undefined,
          rotationApplied: 0,
          error: result.error,
        };
      },
      { concurrency }
    );

    // Collect results
    for (let i = 0; i < inputFrames.length; i++) {
      const frame = inputFrames[i];
      const result = parallelResults.results[i];

      if (isParallelError(result)) {
        results.set(frame.frameId, {
          success: false,
          rotationApplied: 0,
          error: result.message,
        });
      } else {
        results.set(frame.frameId, result);
      }
    }

    const successCount = [...results.values()].filter((r) => r.success).length;
    const failedCount = inputFrames.length - successCount;

    // Log failures with details
    if (failedCount > 0) {
      const failures = [...results.entries()].filter(([, r]) => !r.success);
      for (const [frameId, result] of failures) {
        logger.error({ jobId, frameId, error: result.error }, 'Claid background removal failed for frame');
      }
    }

    logger.info({ jobId, success: successCount, failed: failedCount, total: inputFrames.length }, 'Claid background removal complete');

    // If ALL frames failed, return error instead of silently passing through originals
    if (successCount === 0) {
      const firstError = [...results.values()].find((r) => r.error)?.error || 'All frames failed';
      return {
        success: false,
        error: `Claid background removal failed: ${firstError}`,
      };
    }

    // Update frame paths only for successful extractions
    const updatedFrames: FrameMetadata[] = inputFrames.map((frame) => {
      const result = results.get(frame.frameId);
      if (result?.success && result.outputPath) {
        return { ...frame, path: result.outputPath };
      }
      // Log warning for frames that will use original (no extraction)
      logger.warn({ jobId, frameId: frame.frameId }, 'Using original frame (extraction failed)');
      return frame;
    });

    return {
      success: true,
      data: {
        extractionResults: results,
        images: updatedFrames.map((f) => f.path),
        // Legacy field for backwards compatibility
        recommendedFrames: updatedFrames,
        // New unified metadata
        metadata: {
          ...data.metadata,
          frames: updatedFrames,
        },
      },
    };
  },
};

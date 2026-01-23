/**
 * Stability Upscale Processor
 *
 * Upscales product images using Stability AI's conservative upscale API.
 * This produces clean 4x upscaled images without generative additions,
 * ideal for e-commerce product photography.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { getInputFrames } from '../../types.js';
import { stabilityUpscaleProvider } from '../../../providers/implementations/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:stability-upscale' });

export const stabilityUpscaleProcessor: Processor = {
  id: 'stability-upscale',
  displayName: 'Upscale Image',
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
      return { success: false, error: 'No frames to upscale' };
    }

    // Check if provider is available
    if (!stabilityUpscaleProvider.isAvailable()) {
      logger.warn({ jobId }, 'Stability API not configured, skipping upscale');
      return {
        success: true,
        data: {
          images: inputFrames.map((f) => f.path),
          recommendedFrames: inputFrames,
          metadata: {
            ...data.metadata,
            frames: inputFrames,
          },
        },
      };
    }

    const outputFormat = (options?.outputFormat as 'png' | 'jpeg' | 'webp') ?? 'png';
    const creativity = (options?.creativity as number) ?? 0; // 0 = conservative upscale

    logger.info({ jobId, frameCount: inputFrames.length, creativity }, 'Upscaling images with Stability AI');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 72,
      message: 'Upscaling images',
    });

    // Process frames with controlled concurrency (API rate limits)
    const concurrency = getConcurrency('STABILITY_UPSCALE', options);
    let processedCount = 0;

    const parallelResults = await parallelMap(
      inputFrames,
      async (frame): Promise<FrameMetadata> => {
        try {
          const outputPath = path.join(workDirs.extracted, `${frame.frameId}_upscaled.png`);

          const result = await timer.timeOperation(
            'stability_upscale',
            () => stabilityUpscaleProvider.upscale(frame.path, outputPath, {
              outputFormat,
              creativity,
            }),
            { frameId: frame.frameId }
          );

          // Update progress
          processedCount++;
          await onProgress?.({
            status: JobStatus.EXTRACTING_PRODUCT,
            percentage: 72 + Math.round((processedCount / inputFrames.length) * 8),
            message: `Upscaling ${processedCount}/${inputFrames.length}`,
          });

          if (result.success && result.outputPath) {
            logger.debug({
              frameId: frame.frameId,
              method: result.method,
              size: result.size,
            }, 'Frame upscaled');

            return { ...frame, path: result.outputPath };
          }

          logger.warn({ frameId: frame.frameId, error: result.error }, 'Upscale failed, keeping original');
          return frame;
        } catch (error) {
          logger.warn({ frameId: frame.frameId, error: (error as Error).message }, 'Failed to upscale frame');
          return frame;
        }
      },
      { concurrency }
    );

    // Collect results maintaining order
    const updatedFrames: FrameMetadata[] = parallelResults.results.map((result, i) =>
      isParallelError(result) ? inputFrames[i] : result
    );

    const successCount = updatedFrames.filter((f, i) => f.path !== inputFrames[i].path).length;

    logger.info({ jobId, upscaledCount: successCount, totalCount: updatedFrames.length }, 'Image upscaling complete');

    return {
      success: true,
      data: {
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

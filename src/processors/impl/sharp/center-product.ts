/**
 * Center Product Processor
 *
 * Centers the product within the image and applies consistent padding.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { getInputFrames } from '../../types.js';
import { sharpImageTransformProvider } from '../../../providers/implementations/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:center-product' });

export const centerProductProcessor: Processor = {
  id: 'center-product',
  displayName: 'Center Product',
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
      return { success: false, error: 'No frames to center' };
    }

    const padding = (options?.padding as number) ?? 0.05; // 5% padding
    const minSize = (options?.minSize as number) ?? 512;

    logger.info({ jobId, frameCount: inputFrames.length, padding }, 'Centering products');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 68,
      message: 'Centering products',
    });

    // Process frames in parallel (CPU-bound Sharp operations, higher concurrency)
    const concurrency = getConcurrency('SHARP_TRANSFORM', options);
    let processedCount = 0;
    const { writeFile } = await import('fs/promises');

    const parallelResults = await parallelMap(
      inputFrames,
      async (frame): Promise<FrameMetadata> => {
        try {
          // Detect content bounds
          const bounds = await timer.timeOperation(
            'detect_content_bounds',
            () => sharpImageTransformProvider.findContentBounds(frame.path, 10),
            { frameId: frame.frameId }
          );

          // Update progress
          processedCount++;
          await onProgress?.({
            status: JobStatus.EXTRACTING_PRODUCT,
            percentage: 68 + Math.round((processedCount / inputFrames.length) * 2),
            message: `Centering ${processedCount}/${inputFrames.length}`,
          });

          if (!bounds) {
            return frame;
          }

          const outputPath = path.join(workDirs.extracted, `${frame.frameId}_centered.png`);

          // Crop to content bounds
          const croppedResult = await timer.timeOperation(
            'crop_content',
            () => sharpImageTransformProvider.crop(frame.path, { region: bounds }),
            { frameId: frame.frameId }
          );

          if (!croppedResult.success || !croppedResult.outputBuffer) {
            return frame;
          }

          // Calculate canvas size with padding
          const contentSize = Math.max(bounds.width, bounds.height);
          const canvasSize = Math.max(minSize, Math.round(contentSize * (1 + padding * 2)));

          // Center on canvas
          const centeredResult = await timer.timeOperation(
            'center_on_canvas',
            () => sharpImageTransformProvider.centerOnCanvas(croppedResult.outputBuffer!, {
              canvasSize,
              padding,
            }),
            { frameId: frame.frameId }
          );

          if (centeredResult.success && centeredResult.outputBuffer) {
            await writeFile(outputPath, centeredResult.outputBuffer);
            return { ...frame, path: outputPath };
          }

          return frame;
        } catch (error) {
          logger.warn({ frameId: frame.frameId, error: (error as Error).message }, 'Failed to center product');
          return frame;
        }
      },
      { concurrency }
    );

    // Collect results maintaining order
    const updatedFrames: FrameMetadata[] = parallelResults.results.map((result, i) =>
      isParallelError(result) ? inputFrames[i] : result
    );

    logger.info({ jobId, centeredCount: updatedFrames.length }, 'Product centering complete');

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

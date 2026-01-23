/**
 * Center Product Processor
 *
 * Centers the product within the image and applies consistent padding.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { sharpImageTransformProvider } from '../../../providers/implementations/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

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

    // Use metadata.frames as primary source, fall back to legacy fields
    const inputFrames = data.metadata?.frames || data.recommendedFrames || data.frames;
    if (!inputFrames || inputFrames.length === 0) {
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

    const updatedFrames: FrameMetadata[] = [];

    for (let i = 0; i < inputFrames.length; i++) {
      const frame = inputFrames[i];
      const progress = 68 + Math.round(((i + 1) / inputFrames.length) * 2);

      await onProgress?.({
        status: JobStatus.EXTRACTING_PRODUCT,
        percentage: progress,
        message: `Centering ${i + 1}/${inputFrames.length}`,
      });

      try {
        // Detect content bounds
        const bounds = await timer.timeOperation(
          'detect_content_bounds',
          () => sharpImageTransformProvider.findContentBounds(frame.path, 10),
          { frameId: frame.frameId }
        );

        if (!bounds) {
          // No content found, keep original
          updatedFrames.push(frame);
          continue;
        }

        const outputPath = path.join(workDirs.extracted, `${frame.frameId}_centered.png`);

        // Crop to content bounds
        const croppedResult = await timer.timeOperation(
          'crop_content',
          () => sharpImageTransformProvider.crop(frame.path, { region: bounds }),
          { frameId: frame.frameId }
        );

        if (!croppedResult.success || !croppedResult.outputBuffer) {
          updatedFrames.push(frame);
          continue;
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
          const { writeFile } = await import('fs/promises');
          await writeFile(outputPath, centeredResult.outputBuffer);
          updatedFrames.push({ ...frame, path: outputPath });
        } else {
          updatedFrames.push(frame);
        }
      } catch (error) {
        logger.warn({ frameId: frame.frameId, error: (error as Error).message }, 'Failed to center product');
        updatedFrames.push(frame); // Keep original on error
      }
    }

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

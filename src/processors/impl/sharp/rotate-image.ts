/**
 * Rotate Image Processor
 *
 * Rotates images based on the rotation angle from Gemini analysis.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { sharpImageTransformProvider } from '../../../providers/implementations/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:rotate-image' });

export const rotateImageProcessor: Processor = {
  id: 'rotate-image',
  displayName: 'Rotate Image',
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

    const frames = data.recommendedFrames || data.frames;
    if (!frames || frames.length === 0) {
      return { success: false, error: 'No frames to rotate' };
    }

    const defaultAngle = (options?.angle as number) ?? 0;

    logger.info({ jobId, frameCount: frames.length }, 'Rotating images');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 66,
      message: 'Rotating images',
    });

    const updatedFrames = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const angle = frame.rotationAngleDeg ?? defaultAngle;

      // Skip if no rotation needed
      if (Math.abs(angle) < 0.5) {
        updatedFrames.push(frame);
        continue;
      }

      const progress = 66 + Math.round(((i + 1) / frames.length) * 2);

      await onProgress?.({
        status: JobStatus.EXTRACTING_PRODUCT,
        percentage: progress,
        message: `Rotating ${i + 1}/${frames.length}`,
      });

      try {
        const outputPath = path.join(workDirs.extracted, `${frame.frameId}_rotated.png`);

        const result = await timer.timeOperation(
          'rotate_image',
          () => sharpImageTransformProvider.rotate(frame.path, { angle }),
          { frameId: frame.frameId, angle }
        );

        if (result.success && result.outputBuffer) {
          const { writeFile } = await import('fs/promises');
          await writeFile(outputPath, result.outputBuffer);
          updatedFrames.push({ ...frame, path: outputPath, rotationAngleDeg: angle });
        } else {
          updatedFrames.push(frame);
        }
      } catch (error) {
        logger.warn({ frameId: frame.frameId, error: (error as Error).message }, 'Failed to rotate image');
        updatedFrames.push(frame); // Keep original on error
      }
    }

    logger.info({ jobId, rotatedCount: updatedFrames.filter((f) => f.rotationAngleDeg !== undefined && f.rotationAngleDeg !== 0).length }, 'Image rotation complete');

    return {
      success: true,
      data: {
        images: updatedFrames.map((f) => f.path),
        recommendedFrames: updatedFrames,
      },
    };
  },
};

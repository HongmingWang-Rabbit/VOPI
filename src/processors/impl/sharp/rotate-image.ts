/**
 * Rotate Image Processor
 *
 * Rotates images based on the rotation angle from Gemini analysis.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
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

    // Use metadata.frames as primary source, fall back to legacy fields
    const inputFrames = data.metadata?.frames || data.recommendedFrames || data.frames;
    if (!inputFrames || inputFrames.length === 0) {
      return { success: false, error: 'No frames to rotate' };
    }

    const defaultAngle = (options?.angle as number) ?? 0;
    const threshold = (options?.threshold as number) ?? 0.5; // Don't rotate if < 0.5 degree

    logger.info({ jobId, frameCount: inputFrames.length }, 'Rotating images');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 66,
      message: 'Rotating images',
    });

    const updatedFrames: FrameMetadata[] = [];
    let rotatedCount = 0;

    for (let i = 0; i < inputFrames.length; i++) {
      const frame = inputFrames[i];
      const angle = frame.rotationAngleDeg ?? defaultAngle;

      // Skip if no rotation needed
      if (Math.abs(angle) < threshold) {
        updatedFrames.push(frame);
        continue;
      }

      const progress = 66 + Math.round(((i + 1) / inputFrames.length) * 2);

      await onProgress?.({
        status: JobStatus.EXTRACTING_PRODUCT,
        percentage: progress,
        message: `Rotating ${i + 1}/${inputFrames.length}`,
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
          updatedFrames.push({ ...frame, path: outputPath });
          rotatedCount++;
        } else {
          updatedFrames.push(frame);
        }
      } catch (error) {
        logger.warn({ frameId: frame.frameId, error: (error as Error).message }, 'Failed to rotate image');
        updatedFrames.push(frame); // Keep original on error
      }
    }

    logger.info({ jobId, rotatedCount, total: inputFrames.length }, 'Image rotation complete');

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

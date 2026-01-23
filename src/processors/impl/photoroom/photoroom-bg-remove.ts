/**
 * Photoroom Background Removal Processor
 *
 * Removes background from images using Photoroom API.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { photoroomBackgroundRemovalProvider } from '../../../providers/implementations/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:photoroom-bg-remove' });

export const photoroomBgRemoveProcessor: Processor = {
  id: 'photoroom-bg-remove',
  displayName: 'Remove Background (Photoroom)',
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
      return { success: false, error: 'No frames for background removal' };
    }

    logger.info({ jobId, frameCount: inputFrames.length }, 'Removing backgrounds with Photoroom');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 65,
      message: 'Removing backgrounds',
    });

    const useAIEdit = options?.useAIEdit as boolean | undefined;
    const results = new Map<string, { success: boolean; outputPath?: string; rotationApplied: number; error?: string }>();

    for (let i = 0; i < inputFrames.length; i++) {
      const frame = inputFrames[i];
      const progress = 65 + Math.round(((i + 1) / inputFrames.length) * 5);

      await onProgress?.({
        status: JobStatus.EXTRACTING_PRODUCT,
        percentage: progress,
        message: `Processing ${i + 1}/${inputFrames.length}`,
      });

      try {
        const outputPath = path.join(workDirs.extracted, `${frame.frameId}_transparent.png`);

        const result = await timer.timeOperation(
          'photoroom_remove_background',
          () => photoroomBackgroundRemovalProvider.removeBackground(
            frame.path,
            outputPath,
            {
              useAIEdit: useAIEdit && frame.obstructions?.has_obstruction,
              obstructions: frame.obstructions,
            }
          ),
          { frameId: frame.frameId }
        );

        results.set(frame.frameId, {
          success: result.success,
          outputPath: result.success ? outputPath : undefined,
          rotationApplied: 0,
          error: result.error,
        });
      } catch (error) {
        results.set(frame.frameId, {
          success: false,
          rotationApplied: 0,
          error: (error as Error).message,
        });
      }
    }

    const successCount = [...results.values()].filter((r) => r.success).length;
    const failedCount = inputFrames.length - successCount;

    // Log failures
    if (failedCount > 0) {
      const failures = [...results.entries()].filter(([, r]) => !r.success);
      for (const [frameId, result] of failures) {
        logger.error({ jobId, frameId, error: result.error }, 'Photoroom background removal failed for frame');
      }
    }

    logger.info({ jobId, success: successCount, failed: failedCount, total: inputFrames.length }, 'Background removal complete');

    // If ALL frames failed, return error
    if (successCount === 0) {
      const firstError = [...results.values()].find((r) => r.error)?.error || 'All frames failed';
      return {
        success: false,
        error: `Photoroom background removal failed: ${firstError}`,
      };
    }

    // Update frame paths
    const updatedFrames: FrameMetadata[] = inputFrames.map((frame) => {
      const result = results.get(frame.frameId);
      if (result?.success && result.outputPath) {
        return { ...frame, path: result.outputPath };
      }
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

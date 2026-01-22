/**
 * Photoroom Background Removal Processor
 *
 * Removes background from images using Photoroom API.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
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

    const frames = data.recommendedFrames || data.frames;
    if (!frames || frames.length === 0) {
      return { success: false, error: 'No frames for background removal' };
    }

    logger.info({ jobId, frameCount: frames.length }, 'Removing backgrounds with Photoroom');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 65,
      message: 'Removing backgrounds',
    });

    const useAIEdit = options?.useAIEdit as boolean | undefined;
    const results = new Map<string, { success: boolean; outputPath?: string; error?: string }>();

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const progress = 65 + Math.round(((i + 1) / frames.length) * 5);

      await onProgress?.({
        status: JobStatus.EXTRACTING_PRODUCT,
        percentage: progress,
        message: `Processing ${i + 1}/${frames.length}`,
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
          error: result.error,
        });
      } catch (error) {
        results.set(frame.frameId, {
          success: false,
          error: (error as Error).message,
        });
      }
    }

    const successCount = [...results.values()].filter((r) => r.success).length;
    logger.info({ jobId, success: successCount, total: frames.length }, 'Background removal complete');

    // Update frame paths
    const updatedFrames = frames.map((frame) => {
      const result = results.get(frame.frameId);
      if (result?.success && result.outputPath) {
        return { ...frame, path: result.outputPath };
      }
      return frame;
    });

    return {
      success: true,
      data: {
        extractionResults: results as Map<string, { success: boolean; outputPath?: string; rotationApplied: number; error?: string }>,
        images: updatedFrames.map((f) => f.path),
        recommendedFrames: updatedFrames,
      },
    };
  },
};

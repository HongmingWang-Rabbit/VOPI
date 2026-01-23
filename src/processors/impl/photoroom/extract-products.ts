/**
 * Extract Products Processor
 *
 * Extracts products from frames (remove background, rotate, center).
 * Uses the provider registry for flexible implementation swapping.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { providerRegistry } from '../../../providers/index.js';
import type { ExtractionFrame } from '../../../providers/interfaces/product-extraction.provider.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:extract-products' });

export const extractProductsProcessor: Processor = {
  id: 'extract-products',
  displayName: 'Extract Products',
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
    const { jobId, config, workDirs, onProgress, timer } = context;

    // Use metadata.frames as primary source, fall back to legacy fields
    const inputFrames = data.metadata?.frames || data.recommendedFrames || data.frames;
    if (!inputFrames || inputFrames.length === 0) {
      return { success: false, error: 'No frames to extract products from' };
    }

    logger.info({ jobId, frameCount: inputFrames.length }, 'Extracting products');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 65,
      message: 'Extracting products',
    });

    const hasObstructions = inputFrames.some((f) => f.obstructions?.has_obstruction);
    const useAIEdit = (options?.useAIEdit as boolean) ?? (config.aiCleanup && hasObstructions);

    // Get product extraction provider from registry
    const { provider, providerId, abTestId } = providerRegistry.get('productExtraction', undefined, jobId);
    logger.info({ providerId, abTestId, jobId }, 'Using product extraction provider');

    // Map frames to ExtractionFrame interface
    const extractionFrames: ExtractionFrame[] = inputFrames.map((frame) => ({
      frameId: frame.frameId,
      path: frame.path,
      rotationAngleDeg: frame.rotationAngleDeg || 0,
      obstructions: frame.obstructions,
      recommendedType: frame.recommendedType || frame.frameId,
    }));

    // Extract products
    const results = await timer.timeOperation(
      'product_extraction_all',
      () => provider.extractProducts(
        extractionFrames,
        workDirs.extracted,
        {
          useAIEdit,
          onProgress: async (current, total) => {
            const percentage = 65 + Math.round((current / total) * 5);
            await onProgress?.({
              status: JobStatus.EXTRACTING_PRODUCT,
              percentage,
              message: `Extracting product ${current}/${total}`,
            });
          },
        }
      ),
      { frameCount: extractionFrames.length, useAIEdit, providerId }
    );

    const successCount = [...results.values()].filter((r) => r.success).length;
    const failedCount = inputFrames.length - successCount;

    // Log failures
    if (failedCount > 0) {
      const failures = [...results.entries()].filter(([, r]) => !r.success);
      for (const [frameId, result] of failures) {
        logger.error({ jobId, frameId, error: result.error }, 'Product extraction failed for frame');
      }
    }

    logger.info({
      jobId,
      total: inputFrames.length,
      success: successCount,
      failed: failedCount,
      providerId,
    }, 'Product extraction complete');

    // If ALL frames failed, return error
    if (successCount === 0) {
      const firstError = [...results.values()].find((r) => r.error)?.error || 'All frames failed';
      return {
        success: false,
        error: `Product extraction failed: ${firstError}`,
      };
    }

    // Update frame paths to extracted versions where available
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

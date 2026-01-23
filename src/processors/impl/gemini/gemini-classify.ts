/**
 * Gemini Classify Processor
 *
 * Classifies frames using Gemini AI to discover product variants.
 * Removes rejected frames, keeping only final selections.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { geminiService } from '../../../services/gemini.service.js';
import { frameScoringService, type ScoredFrame } from '../../../services/frame-scoring.service.js';
import { JobStatus } from '../../../types/job.types.js';
import type { VideoMetadata } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:gemini-classify' });

export const geminiClassifyProcessor: Processor = {
  id: 'gemini-classify',
  displayName: 'Classify with Gemini',
  statusKey: JobStatus.CLASSIFYING,
  io: {
    requires: ['images', 'frames'],
    produces: ['frames.classifications'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, config, onProgress, timer } = context;

    // Use metadata.frames as primary source, fall back to legacy fields
    const inputFrames = data.metadata?.frames || data.candidateFrames || data.frames;
    if (!inputFrames || inputFrames.length === 0) {
      return { success: false, error: 'No frames to classify' };
    }

    const videoMetadata = (data.metadata?.video as VideoMetadata) || {
      duration: 0,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'unknown',
      filename: 'unknown',
    };

    logger.info({ jobId, frameCount: inputFrames.length }, 'Classifying frames with Gemini');

    await onProgress?.({
      status: JobStatus.CLASSIFYING,
      percentage: 50,
      message: 'AI variant discovery',
    });

    // Default batch size of 20 if not specified in options or config
    const batchSize = (options?.batchSize as number) ?? config.batchSize ?? 20;
    const batches: FrameMetadata[][] = [];

    for (let i = 0; i < inputFrames.length; i += batchSize) {
      batches.push(inputFrames.slice(i, i + batchSize));
    }

    // Track best frame per variant
    const bestByVariant = new Map<string, { frame: FrameMetadata; score: number }>();
    let failedBatches = 0;
    let detectedProductType: string | undefined;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchProgress = 50 + Math.round(((batchIdx + 1) / batches.length) * 15);

      await onProgress?.({
        status: JobStatus.CLASSIFYING,
        percentage: batchProgress,
        message: `Processing batch ${batchIdx + 1}/${batches.length}`,
      });

      // Convert to ScoredFrame format for Gemini service
      const scoredBatch: ScoredFrame[] = batch.map((f, idx) => ({
        frameId: f.frameId,
        filename: f.filename,
        path: f.path,
        timestamp: f.timestamp,
        index: f.index ?? idx,
        sharpness: f.sharpness ?? 0,
        motion: f.motion ?? 0,
        score: f.score ?? 0,
      }));

      const batchMetadata = frameScoringService.prepareCandidateMetadata(scoredBatch);

      try {
        const batchResult = await timer.timeOperation(
          'gemini_classify_batch',
          () => geminiService.classifyFrames(scoredBatch, batchMetadata, videoMetadata, {
            model: (options?.model as string) ?? config.geminiModel,
          }),
          { batchIdx, batchSize: batch.length }
        );

        // Extract product category from first detected product
        const detectedCategory = batchResult.products_detected?.[0]?.product_category;
        if (detectedCategory && !detectedProductType) {
          detectedProductType = detectedCategory;
          logger.info({ productCategory: detectedCategory }, 'Product category detected by Gemini');
        }

        const batchWinners = geminiService.getRecommendedFrames(batchResult, scoredBatch);

        for (const winner of batchWinners) {
          const key = `${winner.productId}_${winner.variantId}`;
          const score = winner.geminiScore || 50;
          const existing = bestByVariant.get(key);

          if (!existing || score > existing.score) {
            // Find original frame metadata and merge with winner
            const originalFrame = batch.find((f) => f.frameId === winner.frameId);
            const enhancedFrame: FrameMetadata = {
              ...originalFrame,
              frameId: winner.frameId,
              filename: winner.filename,
              path: winner.path,
              timestamp: winner.timestamp,
              index: originalFrame?.index ?? 0,
              sharpness: winner.sharpness,
              motion: winner.motion,
              score: winner.score,
              productId: winner.productId,
              variantId: winner.variantId,
              angleEstimate: winner.angleEstimate,
              recommendedType: winner.recommendedType,
              variantDescription: winner.variantDescription,
              geminiScore: winner.geminiScore,
              rotationAngleDeg: winner.rotationAngleDeg,
              allFrameIds: winner.allFrameIds,
              obstructions: winner.obstructions,
              backgroundRecommendations: winner.backgroundRecommendations,
              isFinalSelection: true,
            };

            bestByVariant.set(key, { frame: enhancedFrame, score });
          }
        }
      } catch (error) {
        failedBatches++;
        logger.error({ error, batchIdx, jobId }, 'Batch classification failed');
      }
    }

    // IMPORTANT: Only keep the final selected frames (removes rejected ones)
    const recommendedFrames = [...bestByVariant.values()].map((v) => v.frame);

    // Check if all batches failed
    if (failedBatches === batches.length) {
      logger.error({ jobId, failedBatches, totalBatches: batches.length }, 'All classification batches failed');
      return {
        success: false,
        error: `All ${batches.length} classification batches failed`,
      };
    }

    // Warn if no variants discovered (but some batches succeeded)
    if (recommendedFrames.length === 0) {
      logger.warn({ jobId, failedBatches, totalBatches: batches.length }, 'No variants discovered from classification');
      return {
        success: false,
        error: 'No product variants discovered from classification',
      };
    }

    logger.info({
      jobId,
      inputFrames: inputFrames.length,
      variantsFound: recommendedFrames.length,
      failedBatches,
      productType: detectedProductType || '(not detected)',
    }, `Classification complete: ${inputFrames.length} → ${recommendedFrames.length} frames`);

    return {
      success: true,
      data: {
        // Update images to only include recommended frames
        images: recommendedFrames.map((f) => f.path),
        // Legacy fields for backwards compatibility
        recommendedFrames,
        // Pass productType to downstream processors
        productType: detectedProductType,
        // New unified metadata - frames are now filtered to final selections only
        metadata: {
          ...data.metadata,
          frames: recommendedFrames,
          variantsDiscovered: recommendedFrames.length,
          productType: detectedProductType,
        },
      },
    };
  },
};

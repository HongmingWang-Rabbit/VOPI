/**
 * Gemini Classify Processor
 *
 * Classifies frames using Gemini AI to discover product variants.
 * Removes rejected frames, keeping only final selections.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { getInputFrames } from '../../types.js';
import { geminiService, type TranscriptContext } from '../../../services/gemini.service.js';
import { frameScoringService, type ScoredFrame } from '../../../services/frame-scoring.service.js';
import { JobStatus } from '../../../types/job.types.js';
import type { VideoMetadata } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:gemini-classify' });

/**
 * Result from processing a single batch of frames
 */
interface BatchResult {
  batchIdx: number;
  winners: Array<{
    key: string;
    score: number;
    frame: FrameMetadata;
  }>;
  productCategory?: string;
  error?: string;
}

/**
 * Build transcript context from pipeline metadata if available
 */
function buildTranscriptContext(data: PipelineData): TranscriptContext | undefined {
  const transcript = data.metadata?.transcript;
  if (!transcript || transcript.length === 0) {
    return undefined;
  }

  const productMetadata = data.metadata?.productMetadata;

  // Extract key features from bullet points
  const keyFeatures = productMetadata?.bulletPoints?.slice(0, 5) || [];

  return {
    transcript,
    productMetadata: productMetadata ? {
      title: productMetadata.title,
      category: productMetadata.category,
      materials: productMetadata.materials,
      color: productMetadata.color,
      bulletPoints: productMetadata.bulletPoints,
    } : undefined,
    keyFeatures,
  };
}

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

    // Get input frames with fallback to legacy fields
    const inputFrames = getInputFrames(data);
    if (inputFrames.length === 0) {
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

    // Build transcript context if audio analysis was performed
    const transcriptContext = buildTranscriptContext(data);
    const hasAudioContext = !!transcriptContext;

    logger.info({ jobId, frameCount: inputFrames.length, hasAudioContext }, 'Classifying frames with Gemini');

    await onProgress?.({
      status: JobStatus.CLASSIFYING,
      percentage: 50,
      message: hasAudioContext ? 'AI variant discovery (with audio context)' : 'AI variant discovery',
    });

    // Default batch size of 20 if not specified in options or config
    const batchSize = (options?.batchSize as number) ?? config.batchSize ?? 20;
    const batches: FrameMetadata[][] = [];

    for (let i = 0; i < inputFrames.length; i += batchSize) {
      batches.push(inputFrames.slice(i, i + batchSize));
    }

    // Track best frame per variant
    const bestByVariant = new Map<string, { frame: FrameMetadata; score: number }>();
    let detectedProductType: string | undefined;
    const minScoreThreshold = (options?.minScore as number) ?? 15;

    // Process batches in parallel for faster classification
    const concurrency = getConcurrency('GEMINI_CLASSIFY', options);
    let processedBatches = 0;

    const batchResults = await parallelMap(
      batches.map((batch, idx) => ({ batch, batchIdx: idx })),
      async ({ batch, batchIdx }): Promise<BatchResult> => {
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
            () => geminiService.classifyFrames(
              scoredBatch,
              batchMetadata,
              videoMetadata,
              { model: (options?.model as string) ?? config.geminiModel },
              transcriptContext,
              context.tokenUsage
            ),
            { batchIdx, batchSize: batch.length, hasAudioContext }
          );

          // Update progress
          processedBatches++;
          await onProgress?.({
            status: JobStatus.CLASSIFYING,
            percentage: 50 + Math.round((processedBatches / batches.length) * 15),
            message: `Processing batch ${processedBatches}/${batches.length}`,
          });

          const productCategory = batchResult.products_detected?.[0]?.product_category;
          const batchWinners = geminiService.getRecommendedFrames(batchResult, scoredBatch);

          const winners: BatchResult['winners'] = [];
          for (const winner of batchWinners) {
            const key = `${winner.productId}_${winner.variantId}`;
            const score = winner.geminiScore || 50;

            // Skip frames with very low scores (rejected by Gemini due to cutoff, etc.)
            if (score < minScoreThreshold) {
              logger.info(
                { frameId: winner.frameId, score, threshold: minScoreThreshold },
                'Skipping low-score frame (likely cut-off or unusable)'
              );
              continue;
            }

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

            winners.push({ key, score, frame: enhancedFrame });
          }

          return { batchIdx, winners, productCategory };
        } catch (error) {
          logger.error({ error, batchIdx, jobId }, 'Batch classification failed');
          return { batchIdx, winners: [], error: (error as Error).message };
        }
      },
      { concurrency }
    );

    // Aggregate results from all batches
    let failedBatches = 0;
    for (let i = 0; i < batchResults.results.length; i++) {
      const result = batchResults.results[i];

      if (isParallelError(result)) {
        failedBatches++;
        continue;
      }

      if (result.error) {
        failedBatches++;
        continue;
      }

      // Extract product category from first batch that has it
      if (result.productCategory && !detectedProductType) {
        detectedProductType = result.productCategory;
        logger.info({ productCategory: detectedProductType }, 'Product category detected by Gemini');
      }

      // Merge winners, keeping best score per variant
      for (const { key, score, frame } of result.winners) {
        const existing = bestByVariant.get(key);
        if (!existing || score > existing.score) {
          bestByVariant.set(key, { frame, score });
        }
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

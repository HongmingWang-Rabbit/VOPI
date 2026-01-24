/**
 * Spend Credits Processor
 *
 * Calculates job cost based on actual video duration and spends credits.
 * Should run after video download when video metadata is available.
 *
 * This processor:
 * 1. Gets video duration from pipeline data
 * 2. Calculates actual job cost using dynamic pricing
 * 3. Attempts to spend credits (idempotent via job ID)
 * 4. Fails the job if insufficient credits
 */

import type { Processor, ProcessorContext, ProcessorResult, PipelineData } from '../../types.js';
import { creditsService } from '../../../services/credits.service.js';
import { createChildLogger } from '../../../utils/logger.js';
import { CreditErrorCode, type AddOnServiceType, type CreditError } from '../../../types/credits.types.js';

const logger = createChildLogger({ processor: 'spend-credits' });

/**
 * Minimum credits that can be spent in a single transaction.
 * This ensures we never try to spend 0 credits even if the calculated cost
 * rounds down to 0 (e.g., for very short videos).
 */
const MINIMUM_CREDITS_PER_SPEND = 1;

export const spendCreditsProcessor: Processor = {
  id: 'spend-credits',
  displayName: 'Spend Credits',
  statusKey: 'pending', // Keep status as pending during credit check
  io: {
    requires: ['video'], // Requires video metadata to be available
    produces: [], // Doesn't produce new data, just spends credits
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, job } = context;
    const userId = job.userId;

    // If no user ID, skip credit spending (API key based jobs use legacy system)
    if (!userId) {
      logger.debug({ jobId }, 'No user ID - skipping credit spend (API key job)');
      return { success: true };
    }

    // Get video duration from pipeline data
    const videoDuration = data.video?.metadata?.duration ?? data.metadata?.video?.duration;

    if (videoDuration === undefined || videoDuration <= 0) {
      logger.warn({ jobId }, 'Video duration not available - using minimum cost');
    }

    const durationSeconds = videoDuration ?? 0;

    // Calculate actual job cost
    const costResponse = await creditsService.calculateJobCost({
      videoDurationSeconds: durationSeconds,
      frameCount: options?.frameCount as number | undefined,
      addOns: options?.addOns as AddOnServiceType[] | undefined,
    });

    // Round total credits to nearest integer for spending, ensuring minimum
    const creditsToSpend = Math.max(MINIMUM_CREDITS_PER_SPEND, Math.round(costResponse.totalCredits));

    logger.info(
      {
        jobId,
        userId,
        videoDuration: durationSeconds,
        calculatedCost: costResponse.totalCredits,
        creditsToSpend,
        breakdown: costResponse.breakdown,
      },
      'Calculated job cost'
    );

    // Create idempotency key based on job ID
    const idempotencyKey = `job:${jobId}:spend`;

    // Attempt to spend credits
    const spendResult = await creditsService.spendCredits(
      userId,
      creditsToSpend,
      idempotencyKey,
      jobId,
      `Video processing (${Math.round(durationSeconds)}s)`
    );

    if (!spendResult.success) {
      logger.error(
        {
          jobId,
          userId,
          creditsRequired: creditsToSpend,
          currentBalance: spendResult.newBalance,
          error: spendResult.error,
        },
        'Insufficient credits for job'
      );

      // Return failure with structured error data
      const creditError: CreditError = {
        code: CreditErrorCode.INSUFFICIENT_CREDITS,
        creditsRequired: creditsToSpend,
        creditsAvailable: spendResult.newBalance,
        breakdown: costResponse.breakdown,
        videoDurationSeconds: durationSeconds,
      };

      return {
        success: false,
        error: `Insufficient credits. Required: ${creditsToSpend}, available: ${spendResult.newBalance}. Please purchase more credits.`,
        data: {
          metadata: {
            ...data.metadata,
            extensions: {
              ...(data.metadata?.extensions || {}),
              creditError,
            },
          },
        },
      };
    }

    logger.info(
      {
        jobId,
        userId,
        creditsSpent: creditsToSpend,
        newBalance: spendResult.newBalance,
        transactionId: spendResult.transactionId,
      },
      'Credits spent successfully'
    );

    // Store credit info in metadata for reference
    return {
      success: true,
      data: {
        metadata: {
          ...data.metadata,
          extensions: {
            ...(data.metadata?.extensions || {}),
            credits: {
              spent: creditsToSpend,
              transactionId: spendResult.transactionId,
              breakdown: costResponse.breakdown,
              videoDurationSeconds: durationSeconds,
            },
          },
        },
      },
    };
  },
};

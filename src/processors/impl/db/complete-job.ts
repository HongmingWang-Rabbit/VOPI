/**
 * Complete Job Processor
 *
 * Marks job as complete and saves final results.
 */

import { eq } from 'drizzle-orm';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { getDatabase, schema } from '../../../db/index.js';
import { JobStatus, type JobResult } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:complete-job' });

export const completeJobProcessor: Processor = {
  id: 'complete-job',
  displayName: 'Complete Job',
  statusKey: JobStatus.COMPLETED,
  io: {
    // Terminal processor: accepts any pipeline state and doesn't add new IO types.
    // Writes final result to auxiliary metadata (not tracked in IO validation).
    requires: [],
    produces: [],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, onProgress } = context;
    const db = getDatabase();

    logger.info({ jobId }, 'Completing job');

    await onProgress?.({
      status: JobStatus.COMPLETED,
      percentage: 100,
      message: 'Pipeline completed',
    });

    // Gather results
    const recommendedFrames = data.recommendedFrames || [];
    const candidateFrames = data.candidateFrames || [];
    const framesAnalyzed = (data.metadata?.framesAnalyzed as number) ?? candidateFrames.length;
    const uploadedUrls = data.uploadedUrls || [];
    const commercialImageUrls = (data.metadata?.commercialImageUrls as Record<string, Record<string, string>>) || {};

    const result: JobResult = {
      variantsDiscovered: recommendedFrames.length,
      framesAnalyzed,
      finalFrames: uploadedUrls,
      commercialImages: commercialImageUrls,
    };

    // Update job with result (if it exists in the database)
    // In test mode, the job may not exist - this is safe to ignore
    try {
      await db
        .update(schema.jobs)
        .set({
          status: JobStatus.COMPLETED,
          result,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, jobId));
    } catch (error) {
      // Log but don't fail if job doesn't exist (e.g., in test mode)
      logger.warn({ jobId, error: (error as Error).message }, 'Could not update job record - may be running in test mode');
    }

    logger.info({ jobId, variantsDiscovered: result.variantsDiscovered }, 'Pipeline completed');

    return {
      success: true,
      data: {
        metadata: {
          ...data.metadata,
          result,
        },
      },
    };
  },
};

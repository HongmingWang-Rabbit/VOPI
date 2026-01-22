/**
 * Save Frame Records Processor
 *
 * Saves frame records to the database.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { getDatabase, schema } from '../../../db/index.js';
import type { NewFrame } from '../../../db/schema.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:save-frame-records' });

export const saveFrameRecordsProcessor: Processor = {
  id: 'save-frame-records',
  displayName: 'Save Frame Records',
  statusKey: JobStatus.EXTRACTING_PRODUCT,
  io: {
    requires: ['frames'],
    produces: ['frame-records'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId } = context;
    const db = getDatabase();

    const videoId = data.video?.dbId;
    if (!videoId) {
      return { success: false, error: 'No video ID for frame records' };
    }

    // Use scoredFrames if available (classic strategy), otherwise recommendedFrames
    const allFrames = data.scoredFrames || data.frames || [];
    const recommendedFrames = data.recommendedFrames || [];
    const candidateFrames = data.candidateFrames || [];

    logger.info({
      jobId,
      totalFrames: allFrames.length,
      recommended: recommendedFrames.length,
    }, 'Saving frame records');

    // Build lookup sets
    const candidateSet = new Set(candidateFrames.map((c) => c.frameId));
    const recommendedMap = new Map(recommendedFrames.map((r) => [r.frameId, r]));

    // Prepare frame values for batch insert
    const frameValues: NewFrame[] = allFrames.map((frame) => {
      const recommended = recommendedMap.get(frame.frameId);
      return {
        jobId,
        videoId,
        frameId: frame.frameId,
        timestamp: frame.timestamp,
        localPath: frame.path,
        scores: frame.sharpness !== undefined
          ? {
              sharpness: frame.sharpness,
              motion: frame.motion ?? 0,
              combined: frame.score ?? 0,
              geminiScore: recommended?.geminiScore,
            }
          : undefined,
        productId: recommended?.productId,
        variantId: recommended?.variantId,
        angleEstimate: recommended?.angleEstimate,
        variantDescription: recommended?.variantDescription,
        obstructions: recommended?.obstructions,
        backgroundRecommendations: recommended?.backgroundRecommendations,
        isBestPerSecond: candidateSet.has(frame.frameId) || frame.isBestPerSecond,
        isFinalSelection: !!recommended || frame.isFinalSelection,
      } satisfies NewFrame;
    });

    // If no frames to save, just return
    if (frameValues.length === 0) {
      logger.info({ jobId }, 'No frames to save');
      return {
        success: true,
        data: {
          frameRecords: new Map(),
        },
      };
    }

    // Batch insert all frames
    const records = await db
      .insert(schema.frames)
      .values(frameValues)
      .returning();

    // Create frameId -> dbId mapping
    const frameRecords = new Map<string, string>();
    for (const record of records) {
      frameRecords.set(record.frameId, record.id);
    }

    logger.info({ jobId, savedCount: records.length }, 'Frame records saved');

    return {
      success: true,
      data: {
        frameRecords,
        metadata: {
          ...data.metadata,
          frameRecordCount: records.length,
        },
      },
    };
  },
};

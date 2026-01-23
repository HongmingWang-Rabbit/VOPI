/**
 * Save Frame Records Processor
 *
 * Saves frame records to the database.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
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
    produces: ['frames.dbId'],
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

    // Use metadata.frames as primary source for final selection
    const metadataFrames = data.metadata?.frames || [];

    // For saving to DB, we need all scored frames (from legacy field)
    // This ensures we save the complete frame history, not just final selections
    // Check length to avoid empty array being truthy and blocking fallback
    const allFrames = (data.scoredFrames?.length ? data.scoredFrames : null)
      || (data.frames?.length ? data.frames : null)
      || metadataFrames;

    // Build lookup for recommended frames (from metadata or legacy)
    const recommendedFrames = metadataFrames.length > 0 ? metadataFrames : (data.recommendedFrames || []);
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
          metadata: {
            ...data.metadata,
            frameRecordCount: 0,
          },
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

    // Update metadata.frames with dbIds
    const updatedFrames: FrameMetadata[] = (data.metadata?.frames || []).map((frame) => ({
      ...frame,
      dbId: frameRecords.get(frame.frameId),
    }));

    logger.info({ jobId, savedCount: records.length }, 'Frame records saved');

    return {
      success: true,
      data: {
        // Legacy field for backwards compatibility
        frameRecords,
        // New unified metadata
        metadata: {
          ...data.metadata,
          frames: updatedFrames,
          frameRecordCount: records.length,
        },
      },
    };
  },
};

/**
 * Filter By Score Processor
 *
 * Filters frames by quality score, selecting top candidates.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:filter-by-score' });

export const filterByScoreProcessor: Processor = {
  id: 'filter-by-score',
  displayName: 'Filter by Score',
  statusKey: JobStatus.SCORING,
  io: {
    requires: ['images', 'frames', 'frames.scores'],
    produces: ['images'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, effectiveConfig } = context;

    // Use metadata.frames as primary source, fall back to legacy fields
    const inputFrames = data.metadata?.frames || data.candidateFrames || data.scoredFrames;
    if (!inputFrames || inputFrames.length === 0) {
      return { success: false, error: 'No scored frames to filter. Ensure score-frames processor ran first.' };
    }

    const topKPercent = (options?.topKPercent as number) ?? effectiveConfig.topKPercent ?? 0.3;
    const minFrames = (options?.minFrames as number) ?? 1;
    const maxFrames = (options?.maxFrames as number) ?? 100;

    logger.info({ jobId, frameCount: inputFrames.length, topKPercent }, 'Filtering frames by score');

    // Sort by score descending
    const sorted = [...inputFrames].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // Calculate how many to keep
    let keepCount = Math.ceil(sorted.length * topKPercent);
    keepCount = Math.max(minFrames, Math.min(maxFrames, keepCount));

    const filtered: FrameMetadata[] = sorted.slice(0, keepCount).map((f) => ({
      ...f,
      isFinalSelection: true,
    }));

    logger.info({
      jobId,
      inputCount: inputFrames.length,
      filteredCount: filtered.length,
    }, `Frames filtered: ${inputFrames.length} → ${filtered.length}`);

    return {
      success: true,
      data: {
        images: filtered.map((f) => f.path),
        // Legacy field for backwards compatibility
        recommendedFrames: filtered,
        // New unified metadata
        metadata: {
          ...data.metadata,
          frames: filtered,
        },
      },
    };
  },
};

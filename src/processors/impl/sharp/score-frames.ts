/**
 * Score Frames Processor
 *
 * Calculates quality scores for extracted frames.
 * Removes low-scoring frames, keeping only top candidates (best per second).
 */

import { copyFile } from 'fs/promises';
import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { frameScoringService } from '../../../services/frame-scoring.service.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { PROGRESS, calculateProgress } from '../../constants.js';

const logger = createChildLogger({ service: 'processor:score-frames' });

export const scoreFramesProcessor: Processor = {
  id: 'score-frames',
  displayName: 'Score Frames',
  statusKey: JobStatus.SCORING,
  io: {
    requires: ['images', 'frames'],
    produces: ['images', 'frames.scores'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress } = context;

    // Use metadata.frames as primary source, fall back to legacy field
    const inputFrames = data.metadata?.frames || data.frames;
    if (!inputFrames || inputFrames.length === 0) {
      return { success: false, error: 'No frames to score' };
    }

    logger.info({ jobId, frameCount: inputFrames.length }, 'Scoring frames');

    await onProgress?.({
      status: JobStatus.SCORING,
      percentage: PROGRESS.SCORE_FRAMES.START,
      message: 'Scoring frames for quality',
    });

    // Convert FrameMetadata to format expected by scoring service
    const extractedFrames = inputFrames.map((f, idx) => ({
      frameId: f.frameId,
      filename: f.filename,
      path: f.path,
      timestamp: f.timestamp,
      index: f.index ?? idx,
    }));

    // Score all frames
    const scoredFrames = await frameScoringService.scoreFrames(
      extractedFrames,
      {},
      async (current, total) => {
        const percentage = calculateProgress(current - 1, total, PROGRESS.SCORE_FRAMES.START, PROGRESS.SCORE_FRAMES.END);
        await onProgress?.({
          status: JobStatus.SCORING,
          percentage,
          message: `Scoring frame ${current}/${total}`,
        });
      }
    );

    // Select best frame per second - these are the candidates to keep
    const candidateFrames = frameScoringService.selectBestFramePerSecond(scoredFrames);

    // Copy candidates to candidates directory
    await Promise.all(
      candidateFrames.map((frame) =>
        copyFile(frame.path, path.join(workDirs.candidates, frame.filename))
      )
    );

    // Build enriched metadata with scores, marking which are best per second
    const candidateSet = new Set(candidateFrames.map(c => c.frameId));

    // IMPORTANT: We filter frames here to reduce context - only keep candidates
    // This is a key simplification from the plan
    const enrichedFrames: FrameMetadata[] = candidateFrames.map((cf) => {
      const original = inputFrames.find((f) => f.frameId === cf.frameId);
      return {
        ...original,
        frameId: cf.frameId,
        filename: cf.filename,
        path: cf.path,
        timestamp: cf.timestamp,
        index: original?.index ?? 0,
        sharpness: cf.sharpness,
        motion: cf.motion,
        score: cf.score,
        isBestPerSecond: true,
      };
    });

    // Keep all scored frames for legacy compatibility (save-frame-records needs them)
    const allScoredFrames: FrameMetadata[] = scoredFrames.map((sf) => {
      const original = inputFrames.find((f) => f.frameId === sf.frameId);
      return {
        ...original,
        frameId: sf.frameId,
        filename: sf.filename,
        path: sf.path,
        timestamp: sf.timestamp,
        index: original?.index ?? 0,
        sharpness: sf.sharpness,
        motion: sf.motion,
        score: sf.score,
        isBestPerSecond: candidateSet.has(sf.frameId),
      };
    });

    logger.info({
      jobId,
      totalScored: scoredFrames.length,
      candidateCount: enrichedFrames.length,
    }, `Frame scoring complete: ${scoredFrames.length} → ${enrichedFrames.length} frames`);

    return {
      success: true,
      data: {
        // Update images to only include candidates
        images: enrichedFrames.map((f) => f.path),
        // Legacy fields for backwards compatibility
        scoredFrames: allScoredFrames,
        candidateFrames: enrichedFrames,
        frames: allScoredFrames,
        // New unified metadata - frames are now filtered to candidates only
        metadata: {
          ...data.metadata,
          frames: enrichedFrames,
        },
      },
    };
  },
};

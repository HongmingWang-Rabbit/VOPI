/**
 * Score Frames Processor
 *
 * Calculates quality scores for extracted frames.
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
    produces: ['images', 'scores'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress } = context;

    if (!data.frames || data.frames.length === 0) {
      return { success: false, error: 'No frames to score' };
    }

    logger.info({ jobId, frameCount: data.frames.length }, 'Scoring frames');

    await onProgress?.({
      status: JobStatus.SCORING,
      percentage: PROGRESS.SCORE_FRAMES.START,
      message: 'Scoring frames for quality',
    });

    // Convert FrameMetadata to format expected by scoring service
    const extractedFrames = data.frames.map((f, idx) => ({
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

    // Select best frame per second
    const candidateFrames = frameScoringService.selectBestFramePerSecond(scoredFrames);

    // Copy candidates to candidates directory
    await Promise.all(
      candidateFrames.map((frame) =>
        copyFile(frame.path, path.join(workDirs.candidates, frame.filename))
      )
    );

    // Update frame metadata with scores
    const inputFrames = data.frames;
    const scoredFrameMetadata: FrameMetadata[] = scoredFrames.map((sf) => {
      const original = inputFrames?.find((f) => f.frameId === sf.frameId);
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
        isBestPerSecond: candidateFrames.some((c) => c.frameId === sf.frameId),
      };
    });

    const candidateMetadata: FrameMetadata[] = candidateFrames.map((cf) => {
      const metadata = scoredFrameMetadata.find((f) => f.frameId === cf.frameId);
      return metadata || {
        frameId: cf.frameId,
        filename: cf.filename,
        path: cf.path,
        timestamp: cf.timestamp,
        index: 0,
        sharpness: cf.sharpness,
        motion: cf.motion,
        score: cf.score,
        isBestPerSecond: true,
      };
    });

    logger.info({ jobId, candidateCount: candidateFrames.length }, 'Frame scoring complete');

    return {
      success: true,
      data: {
        images: candidateFrames.map((f) => f.path),
        scoredFrames: scoredFrameMetadata,
        candidateFrames: candidateMetadata,
        frames: scoredFrameMetadata,
      },
    };
  },
};

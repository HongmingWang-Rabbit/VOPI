import sharp from 'sharp';
import { createChildLogger } from '../utils/logger.js';
import type { ExtractedFrame } from './video.service.js';
import type { VideoMetadata, FrameScores } from '../types/job.types.js';

const logger = createChildLogger({ service: 'frame-scoring' });

/**
 * Frame scoring constants
 */
const SCORING_CONSTANTS = {
  /** Size to resize images for motion comparison */
  MOTION_COMPARISON_SIZE: 256,
  /** Maximum pixel value for normalization */
  MAX_PIXEL_VALUE: 255,
  /** Threshold below which sharpness is considered poor */
  LOW_SHARPNESS_THRESHOLD: 5,
  /** Threshold above which motion is considered high */
  HIGH_MOTION_THRESHOLD: 0.2,
  /** Threshold below which motion is considered low */
  LOW_MOTION_THRESHOLD: 0.1,
  /** Minimum number of low motion frames for good quality */
  MIN_LOW_MOTION_FRAMES: 5,
} as const;

export interface ScoredFrame extends ExtractedFrame {
  sharpness: number;
  motion: number;
  score: number;
}

export interface ScoringConfig {
  alpha?: number;
  topK?: number;
  minTemporalGap?: number;
  minSharpnessThreshold?: number;
  motionNormalizationFactor?: number;
}

export interface QualityReport {
  video: {
    filename: string;
    duration_sec: number;
  };
  analysis: {
    total_frames_analyzed: number;
    average_sharpness: number;
    max_sharpness: number;
    average_motion: number;
    low_motion_frames: number;
  };
  tips_for_better_results: string[];
  status: string;
}

/**
 * Default scoring configuration
 */
export const DEFAULT_SCORING_CONFIG: Required<ScoringConfig> = {
  alpha: 0.2,
  topK: 24,
  minTemporalGap: 0.3,
  /** Minimum sharpness to accept a frame (rejects blurry frames) */
  minSharpnessThreshold: 5,
  motionNormalizationFactor: 255,
};

/**
 * FrameScoringService - Frame scoring and selection logic
 * Ported from smartFrameExtractor/smartFrames.js
 */
export class FrameScoringService {
  /**
   * Compute sharpness score using Laplacian variance approximation
   */
  async computeSharpness(imagePath: string): Promise<number> {
    try {
      const { data, info } = await sharp(imagePath)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { width, height } = info;

      let sum = 0;
      let sumSq = 0;
      let count = 0;

      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = y * width + x;

          const laplacian =
            -4 * data[idx] +
            data[idx - 1] +
            data[idx + 1] +
            data[idx - width] +
            data[idx + width];

          sum += laplacian;
          sumSq += laplacian * laplacian;
          count++;
        }
      }

      const mean = sum / count;
      const variance = sumSq / count - mean * mean;

      return Math.sqrt(variance);
    } catch (e) {
      logger.error({ error: e, imagePath }, 'Failed to compute sharpness');
      return 0;
    }
  }

  /**
   * Compute motion score between two consecutive frames
   */
  async computeMotion(imagePath1: string | null, imagePath2: string): Promise<number> {
    if (!imagePath1) return 0;

    try {
      const size = SCORING_CONSTANTS.MOTION_COMPARISON_SIZE;

      const [img1, img2] = await Promise.all([
        sharp(imagePath1).greyscale().resize(size, size, { fit: 'fill' }).raw().toBuffer(),
        sharp(imagePath2).greyscale().resize(size, size, { fit: 'fill' }).raw().toBuffer(),
      ]);

      let totalDiff = 0;
      for (let i = 0; i < img1.length; i++) {
        totalDiff += Math.abs(img1[i] - img2[i]);
      }

      const avgDiff = totalDiff / img1.length;
      return avgDiff / SCORING_CONSTANTS.MAX_PIXEL_VALUE;
    } catch (e) {
      logger.error({ error: e }, 'Failed to compute motion');
      return 0.5;
    }
  }

  /**
   * Score all extracted frames
   */
  async scoreFrames(
    frames: ExtractedFrame[],
    config: ScoringConfig = {},
    onProgress?: (current: number, total: number) => void
  ): Promise<ScoredFrame[]> {
    const { alpha, motionNormalizationFactor } = { ...DEFAULT_SCORING_CONFIG, ...config };

    logger.info({ count: frames.length }, 'Scoring frames');
    const scoredFrames: ScoredFrame[] = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const prevFrame = i > 0 ? frames[i - 1] : null;

      if (i % 10 === 0) {
        logger.debug({ current: i + 1, total: frames.length }, 'Scoring progress');
        onProgress?.(i + 1, frames.length);
      }

      const sharpness = await this.computeSharpness(frame.path);
      const motion = await this.computeMotion(prevFrame?.path || null, frame.path);

      const combinedScore = sharpness - alpha * motion * motionNormalizationFactor;

      scoredFrames.push({
        ...frame,
        sharpness,
        motion,
        score: combinedScore,
      });
    }

    logger.info({ count: frames.length }, 'Frame scoring completed');
    return scoredFrames;
  }

  /**
   * Select top candidate frames with temporal diversity
   */
  selectCandidates(
    scoredFrames: ScoredFrame[],
    config: ScoringConfig = {}
  ): { candidates: ScoredFrame[]; unusableReason: string | null } {
    const { topK, minTemporalGap } = { ...DEFAULT_SCORING_CONFIG, ...config };

    const usableFrames = scoredFrames;

    if (usableFrames.length === 0) {
      logger.warn('No frames available for selection');
      return { candidates: [], unusableReason: 'no_frames' };
    }

    logger.info({ count: usableFrames.length }, 'Frames available for selection');

    const sorted = [...usableFrames].sort((a, b) => b.score - a.score);

    const selected: ScoredFrame[] = [];
    const selectedTimestamps: number[] = [];

    for (const frame of sorted) {
      if (selected.length >= topK) break;

      const tooClose = selectedTimestamps.some(
        (t) => Math.abs(t - frame.timestamp) < minTemporalGap
      );

      if (!tooClose) {
        selected.push(frame);
        selectedTimestamps.push(frame.timestamp);
      }
    }

    if (selected.length < topK && selected.length < sorted.length) {
      logger.info('Relaxing temporal constraint for more candidates');
      for (const frame of sorted) {
        if (selected.length >= topK) break;
        if (!selected.includes(frame)) {
          selected.push(frame);
        }
      }
    }

    selected.sort((a, b) => a.timestamp - b.timestamp);

    logger.info({ count: selected.length }, 'Candidates selected');
    return { candidates: selected, unusableReason: null };
  }

  /**
   * Select the best frame from each second of video
   * @param scoredFrames - All scored frames
   * @param config - Optional config with minSharpnessThreshold to reject blurry frames
   */
  selectBestFramePerSecond(scoredFrames: ScoredFrame[], config: ScoringConfig = {}): ScoredFrame[] {
    const { minSharpnessThreshold } = { ...DEFAULT_SCORING_CONFIG, ...config };

    // Filter out frames below minimum sharpness threshold
    const usableFrames = scoredFrames.filter((f) => f.sharpness >= minSharpnessThreshold);
    const rejectedCount = scoredFrames.length - usableFrames.length;

    if (rejectedCount > 0) {
      logger.info(
        { rejected: rejectedCount, threshold: minSharpnessThreshold },
        `Rejected ${rejectedCount} blurry frames (sharpness < ${minSharpnessThreshold})`
      );
    }

    const framesBySecond = new Map<number, ScoredFrame[]>();

    for (const frame of usableFrames) {
      const second = Math.floor(frame.timestamp);
      if (!framesBySecond.has(second)) {
        framesBySecond.set(second, []);
      }
      framesBySecond.get(second)!.push(frame);
    }

    const selected: ScoredFrame[] = [];
    for (const [, frames] of framesBySecond) {
      const best = frames.reduce((a, b) => (a.score > b.score ? a : b));
      selected.push(best);
    }

    selected.sort((a, b) => a.timestamp - b.timestamp);

    logger.info(
      { selected: selected.length, usable: usableFrames.length, total: scoredFrames.length },
      'Best frame per second selected'
    );
    return selected;
  }

  /**
   * Generate quality report
   */
  generateQualityReport(scoredFrames: ScoredFrame[], videoMetadata: VideoMetadata): QualityReport {
    // Guard against empty arrays to prevent division by zero
    if (scoredFrames.length === 0) {
      return {
        video: {
          filename: videoMetadata.filename,
          duration_sec: videoMetadata.duration,
        },
        analysis: {
          total_frames_analyzed: 0,
          average_sharpness: 0,
          max_sharpness: 0,
          average_motion: 0,
          low_motion_frames: 0,
        },
        tips_for_better_results: ['No frames were analyzed'],
        status: 'no_frames',
      };
    }

    const sharpnessValues = scoredFrames.map((f) => f.sharpness);
    const motionValues = scoredFrames.map((f) => f.motion);

    const avgSharpness = sharpnessValues.reduce((a, b) => a + b, 0) / sharpnessValues.length;
    const maxSharpness = Math.max(...sharpnessValues);
    const avgMotion = motionValues.reduce((a, b) => a + b, 0) / motionValues.length;
    const lowMotionFrames = scoredFrames.filter((f) => f.motion < SCORING_CONSTANTS.LOW_MOTION_THRESHOLD);

    const tips: string[] = [];
    if (avgSharpness < SCORING_CONSTANTS.LOW_SHARPNESS_THRESHOLD) {
      tips.push('Better lighting would improve frame quality');
    }
    if (avgMotion > SCORING_CONSTANTS.HIGH_MOTION_THRESHOLD) {
      tips.push('Slower rotation would give sharper frames');
    }
    if (lowMotionFrames.length < SCORING_CONSTANTS.MIN_LOW_MOTION_FRAMES) {
      tips.push('Brief pauses at each angle help capture clearer frames');
    }

    return {
      video: {
        filename: videoMetadata.filename,
        duration_sec: videoMetadata.duration,
      },
      analysis: {
        total_frames_analyzed: scoredFrames.length,
        average_sharpness: Math.round(avgSharpness * 10) / 10,
        max_sharpness: Math.round(maxSharpness * 10) / 10,
        average_motion: Math.round(avgMotion * 100) / 100,
        low_motion_frames: lowMotionFrames.length,
      },
      tips_for_better_results: tips.length > 0 ? tips : ['Video quality is good!'],
      status: 'processed',
    };
  }

  /**
   * Prepare candidate metadata for Gemini
   */
  prepareCandidateMetadata(
    candidates: ScoredFrame[]
  ): Array<{
    frame_id: string;
    timestamp_sec: number;
    sequence_position: number;
    total_candidates: number;
  }> {
    return candidates.map((c, idx) => ({
      frame_id: c.frameId,
      timestamp_sec: Math.round(c.timestamp * 100) / 100,
      sequence_position: idx + 1,
      total_candidates: candidates.length,
    }));
  }

  /**
   * Convert ScoredFrame to FrameScores
   */
  toFrameScores(frame: ScoredFrame): FrameScores {
    return {
      sharpness: frame.sharpness,
      motion: frame.motion,
      combined: frame.score,
    };
  }
}

export const frameScoringService = new FrameScoringService();

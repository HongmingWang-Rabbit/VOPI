import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FrameScoringService,
  DEFAULT_SCORING_CONFIG,
  type ScoredFrame,
} from './frame-scoring.service.js';
import type { VideoMetadata } from '../types/job.types.js';

// Mock sharp module
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    greyscale: vi.fn().mockReturnThis(),
    raw: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    toBuffer: vi.fn(),
  })),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('FrameScoringService', () => {
  let service: FrameScoringService;

  beforeEach(() => {
    service = new FrameScoringService();
    vi.clearAllMocks();
  });

  describe('DEFAULT_SCORING_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_SCORING_CONFIG.alpha).toBe(0.2);
      expect(DEFAULT_SCORING_CONFIG.topK).toBe(24);
      expect(DEFAULT_SCORING_CONFIG.minTemporalGap).toBe(0.3);
      expect(DEFAULT_SCORING_CONFIG.minSharpnessThreshold).toBe(0);
      expect(DEFAULT_SCORING_CONFIG.motionNormalizationFactor).toBe(255);
    });
  });

  describe('selectCandidates', () => {
    const createScoredFrame = (
      index: number,
      timestamp: number,
      score: number
    ): ScoredFrame => ({
      filename: `frame_${index}.png`,
      path: `/tmp/frame_${index}.png`,
      index,
      timestamp,
      frameId: `frame_${String(index).padStart(5, '0')}`,
      sharpness: score,
      motion: 0.1,
      score,
    });

    it('should return empty array when no frames provided', () => {
      const result = service.selectCandidates([]);
      expect(result.candidates).toEqual([]);
      expect(result.unusableReason).toBe('no_frames');
    });

    it('should select top K frames by score', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(1, 0.0, 10),
        createScoredFrame(2, 1.0, 50),
        createScoredFrame(3, 2.0, 30),
        createScoredFrame(4, 3.0, 40),
        createScoredFrame(5, 4.0, 20),
      ];

      const result = service.selectCandidates(frames, { topK: 3, minTemporalGap: 0 });

      expect(result.candidates.length).toBe(3);
      // Sorted by timestamp after selection
      expect(result.candidates.map((f) => f.score)).toContain(50);
      expect(result.candidates.map((f) => f.score)).toContain(40);
      expect(result.candidates.map((f) => f.score)).toContain(30);
    });

    it('should enforce minimum temporal gap', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(1, 0.0, 100),
        createScoredFrame(2, 0.1, 90), // Too close to frame 1
        createScoredFrame(3, 0.2, 80), // Too close to frame 1
        createScoredFrame(4, 1.0, 70), // Far enough
        createScoredFrame(5, 1.1, 60), // Too close to frame 4
      ];

      const result = service.selectCandidates(frames, { topK: 5, minTemporalGap: 0.5 });

      // Should only select frames at 0.0 and 1.0 initially
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      expect(result.candidates.some((f) => f.timestamp === 0.0)).toBe(true);
      expect(result.candidates.some((f) => f.timestamp === 1.0)).toBe(true);
    });

    it('should relax temporal constraint if not enough candidates', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(1, 0.0, 100),
        createScoredFrame(2, 0.1, 90),
        createScoredFrame(3, 0.2, 80),
      ];

      const result = service.selectCandidates(frames, { topK: 3, minTemporalGap: 1.0 });

      // Should still return all 3 frames by relaxing constraint
      expect(result.candidates.length).toBe(3);
    });

    it('should sort final candidates by timestamp', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(1, 5.0, 10),
        createScoredFrame(2, 1.0, 50),
        createScoredFrame(3, 3.0, 30),
      ];

      const result = service.selectCandidates(frames, { topK: 3, minTemporalGap: 0 });

      expect(result.candidates[0].timestamp).toBe(1.0);
      expect(result.candidates[1].timestamp).toBe(3.0);
      expect(result.candidates[2].timestamp).toBe(5.0);
    });
  });

  describe('selectBestFramePerSecond', () => {
    const createScoredFrame = (
      index: number,
      timestamp: number,
      score: number
    ): ScoredFrame => ({
      filename: `frame_${index}.png`,
      path: `/tmp/frame_${index}.png`,
      index,
      timestamp,
      frameId: `frame_${String(index).padStart(5, '0')}`,
      sharpness: score,
      motion: 0.1,
      score,
    });

    it('should select best frame from each second', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(1, 0.0, 10),
        createScoredFrame(2, 0.5, 50), // Best in second 0
        createScoredFrame(3, 1.0, 30),
        createScoredFrame(4, 1.5, 40), // Best in second 1
        createScoredFrame(5, 2.0, 20), // Best in second 2 (only one)
      ];

      const result = service.selectBestFramePerSecond(frames);

      expect(result.length).toBe(3); // One per second
      expect(result.find((f) => Math.floor(f.timestamp) === 0)?.score).toBe(50);
      expect(result.find((f) => Math.floor(f.timestamp) === 1)?.score).toBe(40);
      expect(result.find((f) => Math.floor(f.timestamp) === 2)?.score).toBe(20);
    });

    it('should return empty array for empty input', () => {
      const result = service.selectBestFramePerSecond([]);
      expect(result).toEqual([]);
    });

    it('should sort result by timestamp', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(1, 2.5, 30),
        createScoredFrame(2, 0.5, 50),
        createScoredFrame(3, 1.5, 40),
      ];

      const result = service.selectBestFramePerSecond(frames);

      expect(result[0].timestamp).toBe(0.5);
      expect(result[1].timestamp).toBe(1.5);
      expect(result[2].timestamp).toBe(2.5);
    });
  });

  describe('generateQualityReport', () => {
    const createScoredFrame = (
      sharpness: number,
      motion: number
    ): ScoredFrame => ({
      filename: 'frame.png',
      path: '/tmp/frame.png',
      index: 1,
      timestamp: 0,
      frameId: 'frame_00001',
      sharpness,
      motion,
      score: sharpness - 0.2 * motion * 255,
    });

    const videoMetadata: VideoMetadata = {
      filename: 'test.mp4',
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
    };

    it('should handle empty frames array', () => {
      const report = service.generateQualityReport([], videoMetadata);

      expect(report.status).toBe('no_frames');
      expect(report.analysis.total_frames_analyzed).toBe(0);
      expect(report.tips_for_better_results).toContain('No frames were analyzed');
    });

    it('should calculate correct statistics', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(10, 0.1),
        createScoredFrame(20, 0.2),
        createScoredFrame(30, 0.05),
      ];

      const report = service.generateQualityReport(frames, videoMetadata);

      expect(report.analysis.total_frames_analyzed).toBe(3);
      expect(report.analysis.average_sharpness).toBe(20); // (10+20+30)/3
      expect(report.analysis.max_sharpness).toBe(30);
      // (0.1+0.2+0.05)/3 = 0.1166... rounds to 0.12
      expect(report.analysis.average_motion).toBeCloseTo(0.12, 1);
    });

    it('should provide tip for low sharpness', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(2, 0.05),
        createScoredFrame(3, 0.05),
      ];

      const report = service.generateQualityReport(frames, videoMetadata);

      expect(report.tips_for_better_results).toContain(
        'Better lighting would improve frame quality'
      );
    });

    it('should provide tip for high motion', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(50, 0.3),
        createScoredFrame(50, 0.4),
      ];

      const report = service.generateQualityReport(frames, videoMetadata);

      expect(report.tips_for_better_results).toContain(
        'Slower rotation would give sharper frames'
      );
    });

    it('should provide tip for few low-motion frames', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(50, 0.15), // Not low motion
        createScoredFrame(50, 0.2),
        createScoredFrame(50, 0.25),
      ];

      const report = service.generateQualityReport(frames, videoMetadata);

      expect(report.tips_for_better_results).toContain(
        'Brief pauses at each angle help capture clearer frames'
      );
    });

    it('should say video quality is good when no issues', () => {
      const frames: ScoredFrame[] = [
        createScoredFrame(50, 0.05),
        createScoredFrame(60, 0.05),
        createScoredFrame(55, 0.05),
        createScoredFrame(58, 0.05),
        createScoredFrame(52, 0.05),
        createScoredFrame(54, 0.05),
      ];

      const report = service.generateQualityReport(frames, videoMetadata);

      expect(report.tips_for_better_results).toContain('Video quality is good!');
    });

    it('should include video metadata in report', () => {
      const frames: ScoredFrame[] = [createScoredFrame(50, 0.05)];

      const report = service.generateQualityReport(frames, videoMetadata);

      expect(report.video.filename).toBe('test.mp4');
      expect(report.video.duration_sec).toBe(10);
    });
  });

  describe('prepareCandidateMetadata', () => {
    it('should format frame metadata correctly', () => {
      const frames: ScoredFrame[] = [
        {
          filename: 'frame_1.png',
          path: '/tmp/frame_1.png',
          index: 1,
          timestamp: 1.234,
          frameId: 'frame_00001',
          sharpness: 50,
          motion: 0.1,
          score: 45,
        },
        {
          filename: 'frame_2.png',
          path: '/tmp/frame_2.png',
          index: 2,
          timestamp: 2.567,
          frameId: 'frame_00002',
          sharpness: 60,
          motion: 0.15,
          score: 52,
        },
      ];

      const result = service.prepareCandidateMetadata(frames);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        frame_id: 'frame_00001',
        timestamp_sec: 1.23,
        sequence_position: 1,
        total_candidates: 2,
      });
      expect(result[1]).toEqual({
        frame_id: 'frame_00002',
        timestamp_sec: 2.57,
        sequence_position: 2,
        total_candidates: 2,
      });
    });

    it('should handle empty array', () => {
      const result = service.prepareCandidateMetadata([]);
      expect(result).toEqual([]);
    });
  });

  describe('toFrameScores', () => {
    it('should convert ScoredFrame to FrameScores', () => {
      const frame: ScoredFrame = {
        filename: 'frame.png',
        path: '/tmp/frame.png',
        index: 1,
        timestamp: 1.0,
        frameId: 'frame_00001',
        sharpness: 50.5,
        motion: 0.15,
        score: 42.3,
      };

      const result = service.toFrameScores(frame);

      expect(result).toEqual({
        sharpness: 50.5,
        motion: 0.15,
        combined: 42.3,
      });
    });
  });
});

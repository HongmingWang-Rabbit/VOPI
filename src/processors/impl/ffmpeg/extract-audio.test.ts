/**
 * Extract Audio Processor Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('../../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock config
vi.mock('../../../config/index.js', () => ({
  getConfig: () => ({
    ffmpeg: {
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
  }),
}));

import { extractAudioProcessor } from './extract-audio.js';
import type { ProcessorContext, PipelineData } from '../../types.js';
import type { PipelineTimer } from '../../../utils/timer.js';

describe('extractAudioProcessor', () => {
  describe('processor metadata', () => {
    it('should have correct id', () => {
      expect(extractAudioProcessor.id).toBe('extract-audio');
    });

    it('should have correct displayName', () => {
      expect(extractAudioProcessor.displayName).toBe('Extract Audio');
    });

    it('should require video input', () => {
      expect(extractAudioProcessor.io.requires).toContain('video');
    });

    it('should produce audio output', () => {
      expect(extractAudioProcessor.io.produces).toContain('audio');
    });
  });

  describe('execute', () => {
    let mockContext: ProcessorContext;
    let mockTimer: PipelineTimer;

    beforeEach(() => {
      mockTimer = {
        timeOperation: vi.fn().mockImplementation(async (_name, fn) => fn()),
        getMetrics: vi.fn(),
        reset: vi.fn(),
      } as unknown as PipelineTimer;

      mockContext = {
        job: { id: 'test-job-123' } as ProcessorContext['job'],
        jobId: 'test-job-123',
        config: {} as ProcessorContext['config'],
        workDirs: {
          root: '/tmp/test-job',
          video: '/tmp/test-job/video',
          frames: '/tmp/test-job/frames',
          candidates: '/tmp/test-job/candidates',
          extracted: '/tmp/test-job/extracted',
          final: '/tmp/test-job/final',
          commercial: '/tmp/test-job/commercial',
        },
        onProgress: vi.fn(),
        effectiveConfig: {} as ProcessorContext['effectiveConfig'],
        timer: mockTimer,
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return error when no video path provided', async () => {
      const data: PipelineData = { metadata: {} };

      const result = await extractAudioProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No video path provided');
    });

    it('should return error when video path is empty', async () => {
      const data: PipelineData = {
        video: { path: '' },
        metadata: {},
      };

      const result = await extractAudioProcessor.execute(mockContext, data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No video path provided');
    });

    it('should return success with hasAudio false when video has no audio', async () => {
      // Mock ffprobe to return no audio streams
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as ReturnType<typeof vi.fn>;

      const mockProcess = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') {
              callback(Buffer.from(JSON.stringify({ streams: [] })));
            }
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };

      mockSpawn.mockReturnValue(mockProcess);

      const data: PipelineData = {
        video: { path: '/tmp/video.mp4' },
        metadata: {},
      };

      const result = await extractAudioProcessor.execute(mockContext, data);

      expect(result.success).toBe(true);
      expect(result.data?.audio?.hasAudio).toBe(false);
      expect(result.data?.audio?.path).toBe('');
      expect(result.data?.metadata?.audioDuration).toBe(0);
    });
  });
});

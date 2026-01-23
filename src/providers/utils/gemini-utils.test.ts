/**
 * Gemini Utils Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Use vi.hoisted to create mocks that can be referenced in vi.mock callbacks
const { mockSpawn, mockUnlink, mockLogger } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process spawn
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    ffmpeg: {
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
  })),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => mockLogger),
}));

// Mock errors
vi.mock('../../utils/errors.js', () => ({
  ExternalApiError: class ExternalApiError extends Error {
    constructor(provider: string, message: string) {
      super(`${provider}: ${message}`);
      this.name = 'ExternalApiError';
    }
  },
}));

// Create mock process that emits events
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

import {
  VIDEO_MIME_TYPES,
  getVideoMimeType,
  validateCondition,
  validateDimensionUnit,
  validateWeightUnit,
  cleanJsonResponse,
  parseJsonResponse,
  extractFileNameFromUri,
  isHevcCodec,
  transcodeToH264,
  cleanupTranscodedFile,
  prepareVideoForGemini,
  VALID_CONDITIONS,
  VALID_DIMENSION_UNITS,
  VALID_WEIGHT_UNITS,
  DEFAULT_PROCESSING_TIMEOUT_MS,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_MAX_BULLET_POINTS,
  DEFAULT_MAX_FRAMES,
  TRANSCODE_PRESET,
  TRANSCODE_CRF,
  TRANSCODE_TARGET_HEIGHT,
  TRANSCODE_TIMEOUT_MS,
  TRANSCODE_AUDIO_BITRATE,
  FFPROBE_TIMEOUT_MS,
} from './gemini-utils.js';

describe('gemini-utils', () => {
  describe('constants', () => {
    it('should export default timeout values', () => {
      expect(DEFAULT_PROCESSING_TIMEOUT_MS).toBe(300_000);
      expect(DEFAULT_POLLING_INTERVAL_MS).toBe(5_000);
      expect(DEFAULT_MAX_BULLET_POINTS).toBe(5);
      expect(DEFAULT_MAX_FRAMES).toBe(10);
    });

    it('should export valid condition values', () => {
      expect(VALID_CONDITIONS).toContain('new');
      expect(VALID_CONDITIONS).toContain('used');
      expect(VALID_CONDITIONS).toContain('refurbished');
      expect(VALID_CONDITIONS).toHaveLength(3);
    });

    it('should export valid dimension units', () => {
      expect(VALID_DIMENSION_UNITS).toContain('cm');
      expect(VALID_DIMENSION_UNITS).toContain('in');
      expect(VALID_DIMENSION_UNITS).toContain('mm');
      expect(VALID_DIMENSION_UNITS).toHaveLength(3);
    });

    it('should export valid weight units', () => {
      expect(VALID_WEIGHT_UNITS).toContain('g');
      expect(VALID_WEIGHT_UNITS).toContain('kg');
      expect(VALID_WEIGHT_UNITS).toContain('oz');
      expect(VALID_WEIGHT_UNITS).toContain('lb');
      expect(VALID_WEIGHT_UNITS).toContain('pounds');
      expect(VALID_WEIGHT_UNITS).toHaveLength(5);
    });
  });

  describe('VIDEO_MIME_TYPES', () => {
    it('should include common video formats', () => {
      expect(VIDEO_MIME_TYPES.mp4).toBe('video/mp4');
      expect(VIDEO_MIME_TYPES.mov).toBe('video/quicktime');
      expect(VIDEO_MIME_TYPES.avi).toBe('video/x-msvideo');
      expect(VIDEO_MIME_TYPES.webm).toBe('video/webm');
    });
  });

  describe('getVideoMimeType', () => {
    it('should return correct MIME type for known extensions', () => {
      expect(getVideoMimeType('/path/to/video.mp4')).toBe('video/mp4');
      expect(getVideoMimeType('/path/to/video.mov')).toBe('video/quicktime');
      expect(getVideoMimeType('/path/to/video.avi')).toBe('video/x-msvideo');
      expect(getVideoMimeType('/path/to/video.webm')).toBe('video/webm');
    });

    it('should return mp4 for unknown extensions', () => {
      expect(getVideoMimeType('/path/to/video.xyz')).toBe('video/mp4');
      expect(getVideoMimeType('/path/to/video')).toBe('video/mp4');
    });

    it('should handle uppercase extensions', () => {
      expect(getVideoMimeType('/path/to/VIDEO.MP4')).toBe('video/mp4');
      expect(getVideoMimeType('/path/to/VIDEO.MOV')).toBe('video/quicktime');
    });
  });

  describe('validateCondition', () => {
    it('should return valid condition values', () => {
      expect(validateCondition('new')).toBe('new');
      expect(validateCondition('used')).toBe('used');
      expect(validateCondition('refurbished')).toBe('refurbished');
    });

    it('should return undefined for invalid values', () => {
      expect(validateCondition('invalid')).toBeUndefined();
      expect(validateCondition('NEW')).toBeUndefined(); // Case sensitive
      expect(validateCondition('')).toBeUndefined();
    });

    it('should return undefined for null/undefined', () => {
      expect(validateCondition(null)).toBeUndefined();
      expect(validateCondition(undefined)).toBeUndefined();
    });
  });

  describe('validateDimensionUnit', () => {
    it('should return valid unit values', () => {
      expect(validateDimensionUnit('cm')).toBe('cm');
      expect(validateDimensionUnit('in')).toBe('in');
      expect(validateDimensionUnit('mm')).toBe('mm');
    });

    it('should return fallback for invalid values', () => {
      expect(validateDimensionUnit('invalid')).toBe('in');
      expect(validateDimensionUnit('meters')).toBe('in');
    });

    it('should use custom fallback when provided', () => {
      expect(validateDimensionUnit('invalid', 'cm')).toBe('cm');
      expect(validateDimensionUnit(null, 'mm')).toBe('mm');
    });

    it('should return fallback for null/undefined', () => {
      expect(validateDimensionUnit(null)).toBe('in');
      expect(validateDimensionUnit(undefined)).toBe('in');
    });
  });

  describe('validateWeightUnit', () => {
    it('should return valid unit values', () => {
      expect(validateWeightUnit('g')).toBe('g');
      expect(validateWeightUnit('kg')).toBe('kg');
      expect(validateWeightUnit('oz')).toBe('oz');
      expect(validateWeightUnit('lb')).toBe('lb');
      expect(validateWeightUnit('pounds')).toBe('pounds');
    });

    it('should return fallback for invalid values', () => {
      expect(validateWeightUnit('invalid')).toBe('lb');
      expect(validateWeightUnit('kilograms')).toBe('lb');
    });

    it('should use custom fallback when provided', () => {
      expect(validateWeightUnit('invalid', 'kg')).toBe('kg');
      expect(validateWeightUnit(null, 'g')).toBe('g');
    });

    it('should return fallback for null/undefined', () => {
      expect(validateWeightUnit(null)).toBe('lb');
      expect(validateWeightUnit(undefined)).toBe('lb');
    });
  });

  describe('cleanJsonResponse', () => {
    it('should return trimmed text for plain JSON', () => {
      const input = '  {"key": "value"}  ';
      expect(cleanJsonResponse(input)).toBe('{"key": "value"}');
    });

    it('should remove ```json code blocks', () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(cleanJsonResponse(input)).toBe('{"key": "value"}');
    });

    it('should remove ``` code blocks', () => {
      const input = '```\n{"key": "value"}\n```';
      expect(cleanJsonResponse(input)).toBe('{"key": "value"}');
    });

    it('should handle nested content', () => {
      const input = '```json\n{"nested": {"key": "value"}}\n```';
      expect(cleanJsonResponse(input)).toBe('{"nested": {"key": "value"}}');
    });
  });

  describe('parseJsonResponse', () => {
    it('should parse valid JSON', () => {
      const input = '{"key": "value"}';
      expect(parseJsonResponse(input, 'test')).toEqual({ key: 'value' });
    });

    it('should handle JSON with markdown code blocks', () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(parseJsonResponse(input, 'test')).toEqual({ key: 'value' });
    });

    it('should throw on invalid JSON', () => {
      const input = 'not valid json';
      expect(() => parseJsonResponse(input, 'test response')).toThrow(
        'Failed to parse test response'
      );
    });
  });

  describe('extractFileNameFromUri', () => {
    it('should extract from simple files/name format', () => {
      expect(extractFileNameFromUri('files/abc123')).toBe('abc123');
    });

    it('should extract from full URL', () => {
      expect(extractFileNameFromUri('https://generativelanguage.googleapis.com/v1/files/abc123')).toBe('abc123');
    });

    it('should handle URL with query params', () => {
      expect(extractFileNameFromUri('https://example.com/files/abc123?key=value')).toBe('abc123');
    });

    it('should return last segment for unknown formats', () => {
      expect(extractFileNameFromUri('some/path/filename')).toBe('filename');
    });

    it('should return null for empty string', () => {
      expect(extractFileNameFromUri('')).toBeNull();
    });

    it('should handle single segment', () => {
      expect(extractFileNameFromUri('filename')).toBe('filename');
    });
  });

  describe('transcoding constants', () => {
    it('should export transcoding configuration', () => {
      expect(TRANSCODE_PRESET).toBe('ultrafast');
      expect(TRANSCODE_CRF).toBe('28');
      expect(TRANSCODE_TARGET_HEIGHT).toBe(720);
      expect(TRANSCODE_TIMEOUT_MS).toBe(600_000);
      expect(TRANSCODE_AUDIO_BITRATE).toBe('128k');
      expect(FFPROBE_TIMEOUT_MS).toBe(30_000);
    });
  });

  describe('isHevcCodec', () => {
    beforeEach(() => {
      mockSpawn.mockReset();
      mockLogger.info.mockReset();
      mockLogger.warn.mockReset();
    });

    it('should return true for HEVC codec', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = isHevcCodec('/path/to/video.mp4');

      // Simulate ffprobe output
      mockProc.stdout.emit('data', 'hevc');
      mockProc.emit('close', 0);

      const result = await promise;
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('ffprobe', expect.arrayContaining(['/path/to/video.mp4']));
    });

    it('should return true for h265 codec', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = isHevcCodec('/path/to/video.mp4');

      mockProc.stdout.emit('data', 'h265');
      mockProc.emit('close', 0);

      const result = await promise;
      expect(result).toBe(true);
    });

    it('should return false for h264 codec', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = isHevcCodec('/path/to/video.mp4');

      mockProc.stdout.emit('data', 'h264');
      mockProc.emit('close', 0);

      const result = await promise;
      expect(result).toBe(false);
    });

    it('should return false on ffprobe error', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = isHevcCodec('/path/to/video.mp4');

      mockProc.emit('close', 1);

      const result = await promise;
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should return false on spawn error', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = isHevcCodec('/path/to/video.mp4');

      mockProc.emit('error', new Error('spawn failed'));

      const result = await promise;
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should timeout and return false for hanging ffprobe', async () => {
      vi.useFakeTimers();
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = isHevcCodec('/path/to/corrupted.mp4');

      // Advance past the timeout (30 seconds default)
      vi.advanceTimersByTime(31_000);

      const result = await promise;
      expect(result).toBe(false);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 30_000 }),
        'ffprobe timed out, assuming non-HEVC'
      );

      vi.useRealTimers();
    });
  });

  describe('transcodeToH264', () => {
    beforeEach(() => {
      mockSpawn.mockReset();
      mockLogger.info.mockReset();
      mockLogger.warn.mockReset();
      mockLogger.error.mockReset();
    });

    it('should transcode successfully with audio copy', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = transcodeToH264('/input/video.mp4', 'test_prefix');

      // Simulate successful transcoding
      mockProc.emit('close', 0);

      const result = await promise;
      expect(result).toContain('test_prefix_');
      expect(result.endsWith('.mp4')).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining([
        '-i', '/input/video.mp4',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-c:a', 'copy',
      ]));
    });

    it('should fallback to AAC when audio copy fails', async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockProc1 : mockProc2;
      });

      const promise = transcodeToH264('/input/video.mp4');

      // First attempt fails (audio copy)
      mockProc1.stderr.emit('data', 'audio codec not supported');
      mockProc1.emit('close', 1);

      // Wait a tick for the retry
      await new Promise(resolve => setImmediate(resolve));

      // Second attempt succeeds (AAC)
      mockProc2.emit('close', 0);

      const result = await promise;
      expect(result.endsWith('.mp4')).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should throw on transcoding failure', async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockProc1 : mockProc2;
      });

      const promise = transcodeToH264('/input/video.mp4');

      // Both attempts fail
      mockProc1.stderr.emit('data', 'error 1');
      mockProc1.emit('close', 1);

      await new Promise(resolve => setImmediate(resolve));

      mockProc2.stderr.emit('data', 'error 2');
      mockProc2.emit('close', 1);

      await expect(promise).rejects.toThrow('Transcoding failed');
    });

    it('should throw on spawn error', async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockProc1 : mockProc2;
      });

      const promise = transcodeToH264('/input/video.mp4');

      // First spawn errors
      mockProc1.emit('error', new Error('ffmpeg not found'));

      // Wait for retry with AAC
      await new Promise(resolve => setImmediate(resolve));

      // Second spawn also errors
      mockProc2.emit('error', new Error('ffmpeg not found'));

      await expect(promise).rejects.toThrow('Failed to start FFmpeg');
    });
  });

  describe('cleanupTranscodedFile', () => {
    beforeEach(() => {
      mockUnlink.mockReset();
      mockUnlink.mockResolvedValue(undefined);
      mockLogger.debug.mockReset();
    });

    it('should delete the file', async () => {
      await cleanupTranscodedFile('/tmp/transcoded.mp4');

      expect(mockUnlink).toHaveBeenCalledWith('/tmp/transcoded.mp4');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ transcodedPath: '/tmp/transcoded.mp4' }),
        'Transcoded file cleaned up'
      );
    });

    it('should do nothing for null path', async () => {
      await cleanupTranscodedFile(null);

      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('should log but not throw on cleanup failure', async () => {
      mockUnlink.mockRejectedValue(new Error('File not found'));

      // Should not throw
      await cleanupTranscodedFile('/tmp/missing.mp4');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'File not found' }),
        'Failed to cleanup transcoded file'
      );
    });
  });

  describe('prepareVideoForGemini', () => {
    beforeEach(() => {
      mockSpawn.mockReset();
      mockUnlink.mockReset();
      mockUnlink.mockResolvedValue(undefined);
    });

    it('should return original path for non-HEVC video', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = prepareVideoForGemini('/path/to/h264.mp4');

      // ffprobe returns h264
      mockProc.stdout.emit('data', 'h264');
      mockProc.emit('close', 0);

      const result = await promise;
      expect(result.effectivePath).toBe('/path/to/h264.mp4');
      expect(result.transcodedPath).toBeNull();

      // Cleanup should be safe to call
      await result.cleanup();
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('should transcode HEVC video and provide cleanup', async () => {
      // First call is ffprobe (isHevcCodec), second is ffmpeg (transcode)
      const ffprobeProc = createMockProcess();
      const ffmpegProc = createMockProcess();
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? ffprobeProc : ffmpegProc;
      });

      const promise = prepareVideoForGemini('/path/to/hevc.mp4', 'test');

      // ffprobe detects HEVC
      ffprobeProc.stdout.emit('data', 'hevc');
      ffprobeProc.emit('close', 0);

      // Wait for transcode to start
      await new Promise(resolve => setImmediate(resolve));

      // ffmpeg succeeds
      ffmpegProc.emit('close', 0);

      const result = await promise;
      expect(result.effectivePath).toContain('test_');
      expect(result.transcodedPath).not.toBeNull();

      // Cleanup should delete the transcoded file
      await result.cleanup();
      expect(mockUnlink).toHaveBeenCalledWith(result.transcodedPath);
    });
  });
});

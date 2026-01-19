import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VideoService } from './video.service.js';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    ffmpeg: {
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
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

import { spawn } from 'child_process';
import { mkdir, readdir } from 'fs/promises';

describe('VideoService', () => {
  let service: VideoService;

  beforeEach(() => {
    service = new VideoService();
    vi.clearAllMocks();
  });

  describe('getMetadata', () => {
    it('should parse ffprobe output and return video metadata', async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            r_frame_rate: '30/1',
            codec_name: 'h264',
          },
        ],
        format: {
          duration: '10.5',
        },
      });

      const mockProcess = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from(mockOutput));
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const result = await service.getMetadata('/path/to/video.mp4');

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.fps).toBe(30);
      expect(result.codec).toBe('h264');
      expect(result.duration).toBe(10.5);
      expect(result.filename).toBe('video.mp4');
    });

    it('should handle decimal frame rate', async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 1280,
            height: 720,
            r_frame_rate: '29.97',
            codec_name: 'h264',
          },
        ],
        format: {
          duration: '5.0',
        },
      });

      const mockProcess = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from(mockOutput));
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const result = await service.getMetadata('/path/to/video.mp4');

      expect(result.fps).toBeCloseTo(29.97, 2);
    });

    it('should reject when ffprobe exits with non-zero code', async () => {
      const mockProcess = {
        stdout: {
          on: vi.fn(),
        },
        stderr: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('Error message'));
          }),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      await expect(service.getMetadata('/path/to/video.mp4')).rejects.toThrow(
        'ffprobe failed'
      );
    });

    it('should reject when no video stream found', async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: 'audio',
          },
        ],
        format: {},
      });

      const mockProcess = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from(mockOutput));
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      await expect(service.getMetadata('/path/to/video.mp4')).rejects.toThrow(
        'No video stream found'
      );
    });

    it('should reject when ffprobe is not found', async () => {
      const mockProcess = {
        stdout: {
          on: vi.fn(),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'error') callback(new Error('ENOENT'));
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      await expect(service.getMetadata('/path/to/video.mp4')).rejects.toThrow(
        'ffprobe not found'
      );
    });

    it('should reject when JSON parsing fails', async () => {
      const mockProcess = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('invalid json'));
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      await expect(service.getMetadata('/path/to/video.mp4')).rejects.toThrow(
        'Failed to parse ffprobe output'
      );
    });
  });

  describe('extractFramesDense', () => {
    it('should create output directory and extract frames', async () => {
      const mockProcess = {
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);
      vi.mocked(readdir).mockResolvedValue(['frame_00001.png', 'frame_00002.png'] as any);

      const result = await service.extractFramesDense('/path/to/video.mp4', '/output', {
        fps: 5,
      });

      expect(mkdir).toHaveBeenCalledWith('/output', { recursive: true });
      expect(result).toHaveLength(2);
      expect(result[0].frameId).toBe('frame_00001');
      expect(result[0].index).toBe(1);
      expect(result[0].timestamp).toBe(0);
      expect(result[1].frameId).toBe('frame_00002');
      expect(result[1].index).toBe(2);
      expect(result[1].timestamp).toBeCloseTo(0.2, 5); // 1/5 fps
    });

    it('should apply scale filter when provided', async () => {
      const mockProcess = {
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);
      vi.mocked(readdir).mockResolvedValue([] as any);

      await service.extractFramesDense('/path/to/video.mp4', '/output', {
        fps: 5,
        scale: '1280:720',
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).toContain('-vf');
      const vfIndex = args.indexOf('-vf');
      expect(args[vfIndex + 1]).toContain('scale=1280:720');
    });

    it('should reject when ffmpeg exits with non-zero code', async () => {
      const mockProcess = {
        stderr: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('Error'));
          }),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      await expect(
        service.extractFramesDense('/path/to/video.mp4', '/output')
      ).rejects.toThrow('ffmpeg extraction failed');
    });
  });

  describe('extractSingleFrame', () => {
    it('should extract a single frame at specified timestamp', async () => {
      const mockProcess = {
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const result = await service.extractSingleFrame(
        '/path/to/video.mp4',
        2.5,
        '/output/frame.png'
      );

      expect(result).toBe('/output/frame.png');
      expect(mkdir).toHaveBeenCalledWith('/output', { recursive: true });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).toContain('-ss');
      expect(args).toContain('-vframes');
    });

    it('should seek slightly before timestamp for accuracy', async () => {
      const mockProcess = {
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      await service.extractSingleFrame('/path/to/video.mp4', 5.0, '/output/frame.png');

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];
      const ssIndex = args.indexOf('-ss');
      // Should seek to timestamp - 0.1
      expect(parseFloat(args[ssIndex + 1])).toBeCloseTo(4.9, 1);
    });

    it('should not seek to negative timestamp', async () => {
      const mockProcess = {
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      await service.extractSingleFrame('/path/to/video.mp4', 0.05, '/output/frame.png');

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];
      const ssIndex = args.indexOf('-ss');
      expect(parseFloat(args[ssIndex + 1])).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkFfmpegInstalled', () => {
    it('should return available true when both ffmpeg and ffprobe work', async () => {
      const mockProcess = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('ffmpeg version 6.0'));
          }),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const result = await service.checkFfmpegInstalled();

      expect(result.available).toBe(true);
      expect(result.ffmpegVersion).toBe('6.0');
      expect(result.ffprobeVersion).toBe('6.0');
    });

    it('should return available false when ffmpeg is not found', async () => {
      const mockProcess = {
        stdout: {
          on: vi.fn(),
        },
        on: vi.fn((event, callback) => {
          if (event === 'error') callback(new Error('ENOENT'));
        }),
      };

      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const result = await service.checkFfmpegInstalled();

      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

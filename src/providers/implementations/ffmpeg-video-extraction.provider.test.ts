import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FFmpegVideoExtractionProvider } from './ffmpeg-video-extraction.provider.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock video service
vi.mock('../../services/video.service.js', () => ({
  videoService: {
    getMetadata: vi.fn().mockResolvedValue({
      duration: 60,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      filename: 'test.mp4',
    }),
    extractFramesDense: vi.fn().mockResolvedValue([
      {
        filename: 'frame_00001.png',
        path: '/tmp/frames/frame_00001.png',
        index: 1,
        timestamp: 0,
        frameId: 'frame_00001',
      },
      {
        filename: 'frame_00002.png',
        path: '/tmp/frames/frame_00002.png',
        index: 2,
        timestamp: 0.1,
        frameId: 'frame_00002',
      },
    ]),
  },
}));

import { execSync, spawn } from 'child_process';
import { videoService } from '../../services/video.service.js';

describe('FFmpegVideoExtractionProvider', () => {
  let provider: FFmpegVideoExtractionProvider;

  beforeEach(() => {
    provider = new FFmpegVideoExtractionProvider();
    vi.clearAllMocks();
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('ffmpeg');
    });
  });

  describe('isAvailable', () => {
    it('should return true when ffmpeg is available', () => {
      vi.mocked(execSync).mockReturnValue(Buffer.from('ffmpeg version 5.0'));

      expect(provider.isAvailable()).toBe(true);
      expect(execSync).toHaveBeenCalledWith('ffmpeg -version', { stdio: 'ignore' });
    });

    it('should return false when ffmpeg is not available', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found');
      });

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('should return video metadata', async () => {
      const metadata = await provider.getMetadata('/path/to/video.mp4');

      expect(metadata).toEqual({
        duration: 60,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'h264',
        filename: 'test.mp4',
      });
      expect(videoService.getMetadata).toHaveBeenCalledWith('/path/to/video.mp4');
    });
  });

  describe('extractFrames', () => {
    it('should extract frames at default FPS', async () => {
      const frames = await provider.extractFrames('/path/to/video.mp4', '/output/dir');

      expect(frames).toHaveLength(2);
      expect(videoService.extractFramesDense).toHaveBeenCalledWith(
        '/path/to/video.mp4',
        '/output/dir',
        { fps: 10 }
      );
    });

    it('should extract frames at custom FPS', async () => {
      await provider.extractFrames('/path/to/video.mp4', '/output/dir', { fps: 30 });

      expect(videoService.extractFramesDense).toHaveBeenCalledWith(
        '/path/to/video.mp4',
        '/output/dir',
        { fps: 30 }
      );
    });
  });

  describe('extractFrameAt', () => {
    it('should extract a single frame at specified timestamp', async () => {
      // Mock spawn to simulate successful FFmpeg execution
      const mockProcess = {
        on: vi.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
          return mockProcess;
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      const frame = await provider.extractFrameAt(
        '/path/to/video.mp4',
        '/output/frame.png',
        5.5
      );

      expect(frame.path).toBe('/output/frame.png');
      expect(frame.filename).toBe('frame.png');
      expect(frame.timestamp).toBe(5.5);
      expect(frame.frameId).toBe('frame_00005500');

      expect(spawn).toHaveBeenCalledWith('ffmpeg', [
        '-ss', '5.5',
        '-i', '/path/to/video.mp4',
        '-vframes', '1',
        '-q:v', '2',
        '-y',
        '/output/frame.png',
      ]);
    });

    it('should reject when FFmpeg exits with non-zero code', async () => {
      const mockProcess = {
        on: vi.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            setTimeout(() => callback(1), 0);
          }
          return mockProcess;
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await expect(
        provider.extractFrameAt('/path/to/video.mp4', '/output/frame.png', 5.5)
      ).rejects.toThrow('FFmpeg exited with code 1');
    });

    it('should reject when FFmpeg spawn fails', async () => {
      const mockProcess = {
        on: vi.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'error') {
            setTimeout(() => callback(new Error('Spawn error')), 0);
          }
          return mockProcess;
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await expect(
        provider.extractFrameAt('/path/to/video.mp4', '/output/frame.png', 5.5)
      ).rejects.toThrow('Spawn error');
    });

    it('should generate correct frame ID for different timestamps', async () => {
      const mockProcess = {
        on: vi.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
          return mockProcess;
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      const frame1 = await provider.extractFrameAt('/path/to/video.mp4', '/output/frame.png', 0.5);
      expect(frame1.frameId).toBe('frame_00000500');

      const frame2 = await provider.extractFrameAt('/path/to/video.mp4', '/output/frame.png', 10.123);
      expect(frame2.frameId).toBe('frame_00010123');
    });
  });
});

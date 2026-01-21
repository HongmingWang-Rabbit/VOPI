import { execSync, spawn } from 'child_process';
import path from 'path';
import { videoService } from '../../services/video.service.js';
import type {
  VideoExtractionProvider,
  ExtractedFrame,
  FrameExtractionOptions,
} from '../interfaces/video-extraction.provider.js';
import type { VideoMetadata } from '../../types/job.types.js';

/**
 * FFmpeg Video Extraction Provider
 *
 * Uses FFmpeg for video analysis and frame extraction.
 */
export class FFmpegVideoExtractionProvider implements VideoExtractionProvider {
  readonly providerId = 'ffmpeg';

  async getMetadata(videoPath: string): Promise<VideoMetadata> {
    return videoService.getMetadata(videoPath);
  }

  async extractFrames(
    videoPath: string,
    outputDir: string,
    options: FrameExtractionOptions = {}
  ): Promise<ExtractedFrame[]> {
    const { fps = 10 } = options;
    return videoService.extractFramesDense(videoPath, outputDir, { fps });
  }

  async extractFrameAt(
    videoPath: string,
    outputPath: string,
    timestamp: number
  ): Promise<ExtractedFrame> {
    const base = path.basename(outputPath);
    const frameId = `frame_${String(Math.floor(timestamp * 1000)).padStart(8, '0')}`;

    // Use FFmpeg -ss flag to seek directly to timestamp (efficient)
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-ss', timestamp.toString(),
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '2',
        '-y',
        outputPath,
      ]);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', reject);
    });

    return {
      filename: base,
      path: outputPath,
      index: 0,
      timestamp,
      frameId,
    };
  }

  isAvailable(): boolean {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

export const ffmpegVideoExtractionProvider = new FFmpegVideoExtractionProvider();

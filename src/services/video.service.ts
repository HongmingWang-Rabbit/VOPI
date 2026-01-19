import { spawn } from 'child_process';
import { mkdir, rm, readdir, rename, copyFile } from 'fs/promises';
import path from 'path';

import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import type { VideoMetadata } from '../types/job.types.js';

const logger = createChildLogger({ service: 'video' });

export interface ExtractedFrame {
  filename: string;
  path: string;
  index: number;
  timestamp: number;
  frameId: string;
}

export interface ExtractFramesOptions {
  fps?: number;
  quality?: number;
  scale?: string | null;
}

/**
 * VideoService - FFmpeg helpers for frame extraction
 * Ported from smartFrameExtractor/video.js
 */
export class VideoService {
  /**
   * Get video metadata using ffprobe
   */
  async getMetadata(videoPath: string): Promise<VideoMetadata> {
    const config = getConfig();

    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        videoPath,
      ];

      const ffprobe = spawn(config.ffmpeg.ffprobePath, args);
      let stdout = '';
      let stderr = '';

      ffprobe.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      ffprobe.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${stderr}`));
          return;
        }

        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams?.find(
            (s: { codec_type: string }) => s.codec_type === 'video'
          );

          if (!videoStream) {
            reject(new Error('No video stream found'));
            return;
          }

          // Parse frame rate (can be "30/1" or "29.97")
          let fps = 30;
          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/');
            fps = den ? parseFloat(num) / parseFloat(den) : parseFloat(num);
          }

          resolve({
            duration: parseFloat(data.format?.duration || 0),
            width: videoStream.width,
            height: videoStream.height,
            fps,
            codec: videoStream.codec_name,
            filename: path.basename(videoPath),
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${(e as Error).message}`));
        }
      });

      ffprobe.on('error', (err) => {
        reject(new Error(`ffprobe not found. Is ffmpeg installed? ${err.message}`));
      });
    });
  }

  /**
   * Extract frames at a fixed FPS rate
   */
  async extractFramesDense(
    videoPath: string,
    outputDir: string,
    options: ExtractFramesOptions = {}
  ): Promise<ExtractedFrame[]> {
    const config = getConfig();
    const { fps = 5, quality = 2, scale = null } = options;

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Clean any existing frames
    const existingFiles = await readdir(outputDir).catch(() => []);
    for (const file of existingFiles) {
      if (file.startsWith('frame_') && file.endsWith('.png')) {
        await rm(path.join(outputDir, file));
      }
    }

    return new Promise((resolve, reject) => {
      // Build ffmpeg filter chain
      const filters = [`fps=${fps}`];
      if (scale) {
        filters.push(`scale=${scale}`);
      }

      const args = [
        '-i', videoPath,
        '-vf', filters.join(','),
        '-frame_pts', '1',
        '-q:v', quality.toString(),
        path.join(outputDir, 'frame_%05d.png'),
      ];

      logger.info({ fps }, 'Extracting frames');
      const ffmpeg = spawn(config.ffmpeg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      ffmpeg.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', async (code: number | null) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg extraction failed: ${stderr}`));
          return;
        }

        try {
          const frames = await this.renameFramesWithTimestamps(outputDir, fps);
          logger.info({ count: frames.length }, 'Frames extracted');
          resolve(frames);
        } catch (e) {
          reject(e);
        }
      });

      ffmpeg.on('error', (err: Error) => {
        reject(new Error(`ffmpeg not found. Is ffmpeg installed? ${err.message}`));
      });
    });
  }

  /**
   * Rename extracted frames to include timestamp in filename
   */
  private async renameFramesWithTimestamps(
    outputDir: string,
    fps: number
  ): Promise<ExtractedFrame[]> {
    const files = await readdir(outputDir);
    const frameFiles = files.filter((f) => f.startsWith('frame_') && f.endsWith('.png')).sort();

    const frames: ExtractedFrame[] = [];

    for (let i = 0; i < frameFiles.length; i++) {
      const oldName = frameFiles[i];
      const frameIndex = i + 1;
      const timestamp = i / fps;

      const newName = `frame_${String(frameIndex).padStart(5, '0')}_t${timestamp.toFixed(2)}.png`;
      const oldPath = path.join(outputDir, oldName);
      const newPath = path.join(outputDir, newName);

      if (oldName !== newName) {
        await rename(oldPath, newPath);
      }

      frames.push({
        filename: newName,
        path: newPath,
        index: frameIndex,
        timestamp,
        frameId: `frame_${String(frameIndex).padStart(5, '0')}`,
      });
    }

    return frames;
  }

  /**
   * Extract a single high-quality frame at exact timestamp
   */
  async extractSingleFrame(
    videoPath: string,
    timestamp: number,
    outputPath: string,
    options: { quality?: number } = {}
  ): Promise<string> {
    const config = getConfig();
    const { quality = 1 } = options;

    await mkdir(path.dirname(outputPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const seekTime = Math.max(0, timestamp - 0.1).toFixed(3);
      const args = [
        '-ss', seekTime,
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', quality.toString(),
        '-y',
        outputPath,
      ];

      const ffmpeg = spawn(config.ffmpeg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      ffmpeg.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new Error(`Failed to extract frame at ${timestamp}s: ${stderr}`));
          return;
        }
        resolve(outputPath);
      });

      ffmpeg.on('error', reject);
    });
  }

  /**
   * Extract frame with local search for best quality
   */
  async extractBestFrameInWindow(
    videoPath: string,
    centerTimestamp: number,
    outputPath: string,
    scoreFunction: (path: string) => Promise<number>,
    options: { windowSize?: number; sampleCount?: number } = {}
  ): Promise<{ path: string; timestamp: number; score: number }> {
    const { windowSize = 0.2, sampleCount = 5 } = options;

    const tempDir = path.join(path.dirname(outputPath), '.temp_window');
    await mkdir(tempDir, { recursive: true });

    try {
      const timestamps: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        const t = centerTimestamp - windowSize + (2 * windowSize * i) / (sampleCount - 1);
        const roundedT = Math.round(Math.max(0, t) * 1000) / 1000;
        timestamps.push(roundedT);
      }

      let bestScore = -Infinity;
      let bestPath: string | null = null;
      let bestTimestamp = centerTimestamp;

      for (const t of timestamps) {
        const tempPath = path.join(tempDir, `window_t${t.toFixed(3)}.png`);
        await this.extractSingleFrame(videoPath, t, tempPath);

        const score = await scoreFunction(tempPath);
        if (score > bestScore) {
          bestScore = score;
          bestPath = tempPath;
          bestTimestamp = t;
        }
      }

      if (bestPath) {
        await copyFile(bestPath, outputPath);
      }

      await rm(tempDir, { recursive: true, force: true });

      return { path: outputPath, timestamp: bestTimestamp, score: bestScore };
    } catch (e) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  /**
   * Check if ffmpeg is available by running -version
   */
  async checkFfmpegInstalled(): Promise<{ available: boolean; ffmpegVersion?: string; ffprobeVersion?: string; error?: string }> {
    const config = getConfig();

    const checkVersion = (cmd: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        const proc = spawn(cmd, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        proc.on('close', (code) => {
          if (code === 0) {
            // Extract version from first line (e.g., "ffmpeg version 6.0 ...")
            const match = stdout.match(/version\s+([^\s]+)/);
            resolve(match?.[1] || 'unknown');
          } else {
            reject(new Error(`${cmd} exited with code ${code}`));
          }
        });
        proc.on('error', reject);
      });
    };

    try {
      const [ffmpegVersion, ffprobeVersion] = await Promise.all([
        checkVersion(config.ffmpeg.ffmpegPath),
        checkVersion(config.ffmpeg.ffprobePath),
      ]);
      return { available: true, ffmpegVersion, ffprobeVersion };
    } catch (error) {
      return { available: false, error: (error as Error).message };
    }
  }
}

export const videoService = new VideoService();

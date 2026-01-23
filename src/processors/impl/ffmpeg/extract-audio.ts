/**
 * Extract Audio Processor
 *
 * Extracts audio track from video using FFmpeg.
 * Outputs 16kHz mono MP3 optimized for speech recognition.
 */

import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import path from 'path';

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, AudioData } from '../../types.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { getConfig } from '../../../config/index.js';

const logger = createChildLogger({ service: 'processor:extract-audio' });

/**
 * Audio extraction options
 */
export interface ExtractAudioOptions {
  /** Output format (default: mp3) */
  format?: 'mp3' | 'wav' | 'aac';
  /** Sample rate in Hz (default: 16000 for speech recognition) */
  sampleRate?: number;
  /** Number of channels (default: 1 for mono) */
  channels?: number;
  /** Audio bitrate for lossy formats (default: 64k) */
  bitrate?: string;
}

/**
 * Audio metadata from ffprobe
 */
interface AudioStreamInfo {
  hasAudio: boolean;
  duration?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
}

/**
 * Check if video has audio stream using ffprobe
 */
async function getAudioStreamInfo(videoPath: string): Promise<AudioStreamInfo> {
  const config = getConfig();

  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'a',
      videoPath,
    ];

    const ffprobe = spawn(config.ffmpeg.ffprobePath, args);
    let stdout = '';

    ffprobe.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        resolve({ hasAudio: false });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const audioStream = data.streams?.[0];

        if (!audioStream) {
          resolve({ hasAudio: false });
          return;
        }

        resolve({
          hasAudio: true,
          duration: parseFloat(audioStream.duration || '0'),
          sampleRate: parseInt(audioStream.sample_rate || '0', 10),
          channels: audioStream.channels,
          codec: audioStream.codec_name,
        });
      } catch {
        resolve({ hasAudio: false });
      }
    });

    ffprobe.on('error', () => {
      resolve({ hasAudio: false });
    });
  });
}

/**
 * Extract audio from video using FFmpeg
 */
async function extractAudio(
  videoPath: string,
  outputPath: string,
  options: ExtractAudioOptions = {}
): Promise<void> {
  const config = getConfig();
  const {
    format = 'mp3',
    sampleRate = 16000,
    channels = 1,
    bitrate = '64k',
  } = options;

  await mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-vn',                    // No video
      '-ar', sampleRate.toString(),  // Sample rate
      '-ac', channels.toString(),     // Channels
    ];

    // Add format-specific options
    if (format === 'mp3') {
      args.push('-acodec', 'libmp3lame');
      args.push('-b:a', bitrate);
    } else if (format === 'aac') {
      args.push('-acodec', 'aac');
      args.push('-b:a', bitrate);
    } else if (format === 'wav') {
      args.push('-acodec', 'pcm_s16le');
    }

    args.push('-y', outputPath);  // Overwrite output

    logger.info({ videoPath, outputPath, format, sampleRate, channels }, 'Extracting audio');

    const ffmpeg = spawn(config.ffmpeg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code: number | null) => {
      // Handle both non-zero exit codes and null (process killed)
      if (code !== 0) {
        const errorMsg = code === null
          ? 'FFmpeg process was killed'
          : `FFmpeg audio extraction failed with code ${code}`;
        reject(new Error(`${errorMsg}: ${stderr}`));
        return;
      }
      // Log any stderr warnings even on success (useful for debugging)
      if (stderr.trim()) {
        logger.debug({ videoPath, outputPath, stderr: stderr.trim() }, 'FFmpeg audio extraction completed with warnings');
      }
      resolve();
    });

    ffmpeg.on('error', (err: Error) => {
      reject(new Error(`FFmpeg not found. Is ffmpeg installed? ${err.message}`));
    });
  });
}

export const extractAudioProcessor: Processor = {
  id: 'extract-audio',
  displayName: 'Extract Audio',
  statusKey: JobStatus.EXTRACTING,
  io: {
    requires: ['video'],
    produces: ['audio'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress, timer } = context;

    if (!data.video?.path) {
      return { success: false, error: 'No video path provided' };
    }

    const videoPath = data.video.path;

    logger.info({ jobId, videoPath }, 'Starting audio extraction');

    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: 5,
      message: 'Checking for audio track',
    });

    // Check if video has audio
    const audioInfo = await timer.timeOperation(
      'ffprobe_audio_check',
      () => getAudioStreamInfo(videoPath),
      { videoPath }
    );

    if (!audioInfo.hasAudio) {
      logger.info({ jobId }, 'Video has no audio track, skipping audio extraction');

      // Return success but with hasAudio: false
      const audioData: AudioData = {
        path: '',
        format: 'mp3',
        hasAudio: false,
      };

      return {
        success: true,
        data: {
          audio: audioData,
          metadata: {
            ...data.metadata,
            audioDuration: 0,
          },
        },
      };
    }

    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: 10,
      message: 'Extracting audio track',
    });

    // Create audio output directory
    const audioDir = path.join(workDirs.root, 'audio');
    await mkdir(audioDir, { recursive: true });

    // Extract audio options with defaults
    const audioOptions: Required<ExtractAudioOptions> = {
      format: (options?.format as ExtractAudioOptions['format']) || 'mp3',
      sampleRate: typeof options?.sampleRate === 'number' ? options.sampleRate : 16000,
      channels: typeof options?.channels === 'number' ? options.channels : 1,
      bitrate: typeof options?.bitrate === 'string' ? options.bitrate : '64k',
    };
    const { format, sampleRate, channels, bitrate } = audioOptions;

    const audioFilename = `audio.${format}`;
    const audioPath = path.join(audioDir, audioFilename);

    await timer.timeOperation(
      'ffmpeg_extract_audio',
      () => extractAudio(videoPath, audioPath, { format, sampleRate, channels, bitrate }),
      { videoPath, format, sampleRate }
    );

    logger.info({ jobId, audioPath, duration: audioInfo.duration }, 'Audio extracted successfully');

    const audioData: AudioData = {
      path: audioPath,
      format,
      duration: audioInfo.duration,
      sampleRate,
      channels,
      hasAudio: true,
    };

    return {
      success: true,
      data: {
        audio: audioData,
        metadata: {
          ...data.metadata,
          audioDuration: audioInfo.duration,
        },
      },
    };
  },
};

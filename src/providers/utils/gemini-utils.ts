/**
 * Shared Gemini Provider Utilities
 *
 * Common functions used across Gemini-based providers to avoid code duplication.
 */

import os from 'os';
import path from 'path';
import { unlink } from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import { getConfig } from '../../config/index.js';
import { ExternalApiError } from '../../utils/errors.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ service: 'gemini-utils' });

// ============================================================================
// Constants
// ============================================================================

/** Default timeout for video/audio processing (5 minutes) */
export const DEFAULT_PROCESSING_TIMEOUT_MS = 300_000;

/** Default polling interval for checking processing status */
export const DEFAULT_POLLING_INTERVAL_MS = 5_000;

/** Default max bullet points for audio analysis */
export const DEFAULT_MAX_BULLET_POINTS = 5;

/** Default max frames to select */
export const DEFAULT_MAX_FRAMES = 10;

// ============================================================================
// Transcoding Constants
// ============================================================================

/** FFmpeg preset for transcoding - ultrafast prioritizes speed over compression */
export const TRANSCODE_PRESET = 'ultrafast';

/** CRF quality value - 28 is acceptable for AI analysis (lower = better quality, slower) */
export const TRANSCODE_CRF = '28';

/** Audio bitrate for AAC encoding when audio copy fails */
export const TRANSCODE_AUDIO_BITRATE = '128k';

/** Helper to safely parse int env vars with fallback */
function parseIntEnv(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = parseInt(envVar, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Target resolution height for transcoding - 720p balances quality and speed */
export const TRANSCODE_TARGET_HEIGHT = parseIntEnv(process.env.VOPI_TRANSCODE_HEIGHT, 720);

/** Timeout for transcoding operations (default: 10 minutes) */
export const TRANSCODE_TIMEOUT_MS = parseIntEnv(process.env.VOPI_TRANSCODE_TIMEOUT_MS, 600_000);

/** Timeout for codec detection with ffprobe (default: 30 seconds) */
export const FFPROBE_TIMEOUT_MS = parseIntEnv(process.env.VOPI_FFPROBE_TIMEOUT_MS, 30_000);

// ============================================================================
// MIME Types
// ============================================================================

/**
 * Video MIME type mapping
 */
export const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
};

/**
 * Get video MIME type from file path
 */
export function getVideoMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  return VIDEO_MIME_TYPES[ext || ''] || 'video/mp4';
}

// ============================================================================
// Type Validation Helpers
// ============================================================================

/** Valid product condition values */
export const VALID_CONDITIONS = ['new', 'used', 'refurbished'] as const;
export type ProductCondition = (typeof VALID_CONDITIONS)[number];

/** Valid dimension units */
export const VALID_DIMENSION_UNITS = ['cm', 'in', 'mm'] as const;
export type DimensionUnit = (typeof VALID_DIMENSION_UNITS)[number];

/** Valid weight units */
export const VALID_WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb', 'pounds'] as const;
export type WeightUnit = (typeof VALID_WEIGHT_UNITS)[number];

/**
 * Validate and return a product condition, or undefined if invalid
 */
export function validateCondition(value: string | undefined | null): ProductCondition | undefined {
  if (!value) return undefined;
  return VALID_CONDITIONS.includes(value as ProductCondition)
    ? (value as ProductCondition)
    : undefined;
}

/**
 * Validate and return a dimension unit, with fallback
 */
export function validateDimensionUnit(value: string | undefined | null, fallback: DimensionUnit = 'in'): DimensionUnit {
  if (!value) return fallback;
  return VALID_DIMENSION_UNITS.includes(value as DimensionUnit)
    ? (value as DimensionUnit)
    : fallback;
}

/**
 * Validate and return a weight unit, with fallback
 */
export function validateWeightUnit(value: string | undefined | null, fallback: WeightUnit = 'lb'): WeightUnit {
  if (!value) return fallback;
  return VALID_WEIGHT_UNITS.includes(value as WeightUnit)
    ? (value as WeightUnit)
    : fallback;
}

// ============================================================================
// Video Codec Detection & Transcoding
// ============================================================================

/**
 * Check if video uses HEVC (H.265) codec which is not supported by Gemini.
 * Includes timeout protection against hanging on corrupted files.
 */
export async function isHevcCodec(videoPath: string): Promise<boolean> {
  const config = getConfig();
  const ffprobePath = config.ffmpeg.ffprobePath;

  return new Promise((resolve) => {
    const ffprobe = spawn(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);

    let output = '';
    let settled = false;

    // Set up timeout to prevent hanging on corrupted files
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ffprobe.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
        logger.warn({ videoPath, timeoutMs: FFPROBE_TIMEOUT_MS }, 'ffprobe timed out, assuming non-HEVC');
        resolve(false);
      }
    }, FFPROBE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
    };

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (code !== 0) {
        logger.warn({ videoPath, code }, 'Failed to detect video codec');
        resolve(false);
        return;
      }

      const codec = output.trim().toLowerCase();
      const isHevc = codec === 'hevc' || codec === 'h265';
      if (isHevc) {
        logger.info({ videoPath, codec }, 'Detected HEVC codec, will transcode to H.264');
      }
      resolve(isHevc);
    });

    ffprobe.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.warn({ videoPath, error: error.message }, 'Failed to run ffprobe');
      resolve(false);
    });
  });
}

/**
 * Kill FFmpeg process and cleanup
 */
function killFfmpegProcess(ffmpeg: ChildProcess, reason: string): void {
  try {
    ffmpeg.kill('SIGKILL');
    logger.warn({ reason }, 'FFmpeg process killed');
  } catch {
    // Process may already be dead
  }
}

/**
 * Run FFmpeg transcoding with specified audio codec
 * @returns Promise that resolves with output path or rejects with error
 */
async function runFfmpegTranscode(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  audioCodec: 'copy' | 'aac',
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', TRANSCODE_PRESET,
      '-crf', TRANSCODE_CRF,
      '-vf', `scale=-2:${TRANSCODE_TARGET_HEIGHT}`,
      '-threads', '0',
      '-c:a', audioCodec,
      ...(audioCodec === 'aac' ? ['-b:a', TRANSCODE_AUDIO_BITRATE] : []),
      '-y',
      outputPath,
    ];

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    let stderr = '';
    let settled = false;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        killFfmpegProcess(ffmpeg, 'timeout');
        reject(new ExternalApiError('FFmpeg', `Transcoding timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutId);
    };

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (code !== 0) {
        reject(new ExternalApiError('FFmpeg', `Transcoding failed with code ${code}: ${stderr.slice(-300)}`));
        return;
      }

      resolve(outputPath);
    });

    ffmpeg.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ExternalApiError('FFmpeg', `Failed to start FFmpeg: ${error.message}`));
    });
  });
}

/**
 * Transcode video to H.264 codec for Gemini compatibility.
 * Uses ultrafast preset and downscales to configurable resolution for speed.
 * Attempts to copy audio stream first, falls back to AAC encoding if incompatible.
 *
 * @param inputPath - Path to input video file
 * @param prefix - Prefix for temp file name (default: 'gemini_transcode')
 * @returns Path to transcoded file (caller is responsible for cleanup)
 * @throws ExternalApiError if transcoding fails or times out
 */
export async function transcodeToH264(inputPath: string, prefix = 'gemini_transcode'): Promise<string> {
  const config = getConfig();
  const ffmpegPath = config.ffmpeg.ffmpegPath;

  const tempDir = os.tmpdir();
  // Use timestamp + random suffix for unique filename (collision-resistant for practical purposes)
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const outputPath = path.join(tempDir, `${prefix}_${uniqueId}.mp4`);

  logger.info(
    { inputPath, outputPath, preset: TRANSCODE_PRESET, crf: TRANSCODE_CRF, targetHeight: TRANSCODE_TARGET_HEIGHT },
    'Transcoding video to H.264'
  );

  // Try with audio copy first (fastest)
  try {
    const result = await runFfmpegTranscode(ffmpegPath, inputPath, outputPath, 'copy', TRANSCODE_TIMEOUT_MS);
    logger.info({ inputPath, outputPath }, 'Video transcoded successfully with audio copy');
    return result;
  } catch (copyError) {
    // Check if it's a timeout - don't retry on timeout
    if ((copyError as Error).message.includes('timed out')) {
      throw copyError;
    }

    logger.warn(
      { inputPath, error: (copyError as Error).message },
      'Audio copy failed, retrying with AAC encoding'
    );

    // Retry with AAC encoding
    try {
      const result = await runFfmpegTranscode(ffmpegPath, inputPath, outputPath, 'aac', TRANSCODE_TIMEOUT_MS);
      logger.info({ inputPath, outputPath }, 'Video transcoded successfully with AAC audio');
      return result;
    } catch (aacError) {
      logger.error({ inputPath, error: (aacError as Error).message }, 'FFmpeg transcoding failed');
      throw aacError;
    }
  }
}

/**
 * Cleanup transcoded file (safe to call even if path is null)
 */
export async function cleanupTranscodedFile(transcodedPath: string | null): Promise<void> {
  if (!transcodedPath) return;

  try {
    await unlink(transcodedPath);
    logger.debug({ transcodedPath }, 'Transcoded file cleaned up');
  } catch (error) {
    // Log but don't throw - cleanup failures shouldn't break the flow
    logger.debug({ transcodedPath, error: (error as Error).message }, 'Failed to cleanup transcoded file');
  }
}

/**
 * Process video for Gemini - check codec and transcode if needed
 * @returns Object with effective path and cleanup function
 */
export async function prepareVideoForGemini(videoPath: string, prefix?: string): Promise<{
  effectivePath: string;
  transcodedPath: string | null;
  cleanup: () => Promise<void>;
}> {
  let effectivePath = videoPath;
  let transcodedPath: string | null = null;

  if (await isHevcCodec(videoPath)) {
    transcodedPath = await transcodeToH264(videoPath, prefix);
    effectivePath = transcodedPath;
  }

  return {
    effectivePath,
    transcodedPath,
    cleanup: () => cleanupTranscodedFile(transcodedPath),
  };
}

// ============================================================================
// Response Parsing Helpers
// ============================================================================

/**
 * Clean markdown code blocks from Gemini response
 */
export function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();

  // Remove markdown code blocks if present
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

/**
 * Parse JSON response with error handling
 */
export function parseJsonResponse<T>(text: string, errorContext: string): T {
  const cleaned = cleanJsonResponse(text);

  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new ExternalApiError(
      'Gemini',
      `Failed to parse ${errorContext}: ${(e as Error).message}`
    );
  }
}

// ============================================================================
// File URI Helpers
// ============================================================================

/**
 * Extract file name from various Gemini URI formats
 * Handles: "files/abc123", "https://...googleapis.com/.../files/abc123", etc.
 */
export function extractFileNameFromUri(uri: string): string | null {
  if (!uri) return null;

  // Try to parse as URL first
  try {
    const url = new URL(uri);
    const pathParts = url.pathname.split('/').filter(Boolean);
    // Find "files" segment and return the next one
    const filesIndex = pathParts.indexOf('files');
    if (filesIndex >= 0 && pathParts[filesIndex + 1]) {
      return pathParts[filesIndex + 1];
    }
    // Fallback to last path segment
    return pathParts[pathParts.length - 1] || null;
  } catch {
    // Not a valid URL, treat as path
  }

  // Handle simple "files/name" format
  const parts = uri.split('/').filter(Boolean);
  if (parts[0] === 'files' && parts[1]) {
    return parts[1];
  }

  // Fallback to last segment
  return parts[parts.length - 1] || null;
}

/**
 * video.js - FFmpeg helpers for frame extraction
 *
 * WHY this module exists:
 * - Centralizes all FFmpeg interactions
 * - Provides clean abstractions for frame extraction at various quality levels
 * - Handles temporary file management
 * - Extracts video metadata needed for processing decisions
 */

import { spawn } from 'child_process';
import { mkdir, rm, readdir } from 'fs/promises';
import path from 'path';

// Use bundled ffmpeg/ffprobe binaries from npm packages
// WHY: No system dependency required - works out of the box after npm install
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';

/**
 * Get video metadata using ffprobe
 *
 * WHY: We need duration, fps, and dimensions to:
 * - Calculate expected frame count
 * - Validate video is processable
 * - Include metadata in Gemini context
 */
export async function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath
    ];

    const ffprobe = spawn(ffprobePath.path, args);
    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => { stdout += data; });
    ffprobe.stderr.on('data', (data) => { stderr += data; });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const videoStream = data.streams?.find(s => s.codec_type === 'video');

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
          fps: fps,
          codec: videoStream.codec_name,
          filename: path.basename(videoPath)
        });
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
      }
    });

    ffprobe.on('error', (err) => {
      reject(new Error(`ffprobe not found. Is ffmpeg installed? ${err.message}`));
    });
  });
}

/**
 * Extract frames at a fixed FPS rate
 *
 * WHY dense extraction at fixed FPS:
 * - Uniform sampling misses brief clear moments in fast-moving video
 * - 5 fps gives us enough granularity to catch ~200ms pauses
 * - Higher fps = more candidates but more processing time
 *
 * Frame naming convention: frame_XXXXX_tY.YY.png
 * - XXXXX: zero-padded frame index (for sorting)
 * - Y.YY: timestamp in seconds (for re-extraction)
 */
export async function extractFramesDense(videoPath, outputDir, options = {}) {
  const {
    fps = 5,           // Frames per second to extract
    quality = 2,       // PNG compression (2 = good balance)
    scale = null       // Optional resize, e.g., "640:-1" for 640px width
  } = options;

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
    // WHY: We use select filter with exact frame timing for reproducible timestamps
    const filters = [`fps=${fps}`];
    if (scale) {
      filters.push(`scale=${scale}`);
    }

    const args = [
      '-i', videoPath,
      '-vf', filters.join(','),
      '-frame_pts', '1',  // Include presentation timestamp
      '-q:v', quality.toString(),
      // Output pattern with frame number
      // We'll rename files after to include timestamps
      path.join(outputDir, 'frame_%05d.png')
    ];

    console.log(`[video] Extracting frames at ${fps} fps...`);
    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => { stderr += data; });

    ffmpeg.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg extraction failed: ${stderr}`));
        return;
      }

      try {
        // Rename frames to include timestamps
        const frames = await renameFramesWithTimestamps(outputDir, fps);
        console.log(`[video] Extracted ${frames.length} frames`);
        resolve(frames);
      } catch (e) {
        reject(e);
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg not found. Is ffmpeg installed? ${err.message}`));
    });
  });
}

/**
 * Rename extracted frames to include timestamp in filename
 *
 * WHY timestamps in filename:
 * - Makes it easy to re-extract specific frames at higher quality
 * - Enables temporal diversity checks without re-parsing
 * - Human-readable for debugging
 */
async function renameFramesWithTimestamps(outputDir, fps) {
  const files = await readdir(outputDir);
  const frameFiles = files
    .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
    .sort();

  const frames = [];

  for (let i = 0; i < frameFiles.length; i++) {
    const oldName = frameFiles[i];
    const frameIndex = i + 1;  // 1-indexed from ffmpeg
    const timestamp = i / fps;

    // New format: frame_00001_t0.00.png
    const newName = `frame_${String(frameIndex).padStart(5, '0')}_t${timestamp.toFixed(2)}.png`;
    const oldPath = path.join(outputDir, oldName);
    const newPath = path.join(outputDir, newName);

    // Rename if different
    if (oldName !== newName) {
      const { rename } = await import('fs/promises');
      await rename(oldPath, newPath);
    }

    frames.push({
      filename: newName,
      path: newPath,
      index: frameIndex,
      timestamp: timestamp,
      frameId: `frame_${String(frameIndex).padStart(5, '0')}`
    });
  }

  return frames;
}

/**
 * Extract a single high-quality frame at exact timestamp
 *
 * WHY re-extract for final output:
 * - Dense extraction may use lower quality for speed
 * - We want maximum quality for the final selected frames
 * - Allows ±window search for slightly better moment
 */
export async function extractSingleFrame(videoPath, timestamp, outputPath, options = {}) {
  const {
    searchWindow = 0,  // ±seconds to search for best frame
    quality = 1        // Highest PNG quality
  } = options;

  await mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    // Seek to slightly before timestamp for accuracy
    // WHY: -ss before -i is faster but less accurate, we use after for precision
    // Use toFixed(3) to avoid floating-point precision issues (e.g., 2.77e-17)
    const seekTime = Math.max(0, timestamp - 0.1).toFixed(3);
    const args = [
      '-ss', seekTime,
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', quality.toString(),
      '-y',  // Overwrite
      outputPath
    ];

    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => { stderr += data; });

    ffmpeg.on('close', (code) => {
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
 *
 * WHY local search:
 * - The "best" frame might be ±0.2s from our candidate
 * - Motion blur can change rapidly between frames
 * - This gives us a second chance at finding the sharpest moment
 */
export async function extractBestFrameInWindow(
  videoPath,
  centerTimestamp,
  outputPath,
  scoreFunction,
  options = {}
) {
  const {
    windowSize = 0.2,   // ±seconds
    sampleCount = 5     // Frames to evaluate in window
  } = options;

  const tempDir = path.join(path.dirname(outputPath), '.temp_window');
  await mkdir(tempDir, { recursive: true });

  try {
    // Extract frames in window
    // Use toFixed to avoid floating-point precision issues
    const timestamps = [];
    for (let i = 0; i < sampleCount; i++) {
      const t = centerTimestamp - windowSize + (2 * windowSize * i / (sampleCount - 1));
      // Round to 3 decimal places to avoid floating-point artifacts
      const roundedT = Math.round(Math.max(0, t) * 1000) / 1000;
      timestamps.push(roundedT);
    }

    // Extract and score each
    let bestScore = -Infinity;
    let bestPath = null;
    let bestTimestamp = centerTimestamp;

    for (const t of timestamps) {
      const tempPath = path.join(tempDir, `window_t${t.toFixed(3)}.png`);
      await extractSingleFrame(videoPath, t, tempPath);

      const score = await scoreFunction(tempPath);
      if (score > bestScore) {
        bestScore = score;
        bestPath = tempPath;
        bestTimestamp = t;
      }
    }

    // Copy best frame to output
    const { copyFile } = await import('fs/promises');
    await copyFile(bestPath, outputPath);

    // Cleanup temp
    await rm(tempDir, { recursive: true, force: true });

    return { path: outputPath, timestamp: bestTimestamp, score: bestScore };
  } catch (e) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Check if ffmpeg is available
 * WHY: Always returns true since we bundle ffmpeg-static
 */
export function checkFfmpegInstalled() {
  return !!ffmpegPath && !!ffprobePath.path;
}

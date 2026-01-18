/**
 * smartFrames.js - Frame scoring and selection logic
 *
 * WHY this module exists:
 * - Implements the "junior product photographer" mindset
 * - Aggressively discards unusable frames before expensive Gemini calls
 * - Uses cheap CPU-based heuristics (sharpness + motion)
 * - Ensures temporal diversity in selected candidates
 *
 * Core insight: Most handheld product videos have brief "pause" moments
 * where the product is relatively still. These are our best candidates.
 */

import sharp from 'sharp';
import { readFile } from 'fs/promises';
import path from 'path';

/**
 * Configuration defaults
 *
 * WHY these values:
 * - alpha=0.5: Balance between sharpness and stillness
 * - minTemporalGap=0.5s: Prevents selecting near-duplicate frames
 * - minSharpnessThreshold=50: Below this, image is too blurry to be useful
 */
export const DEFAULT_CONFIG = {
  alpha: 0.5,                    // Motion penalty weight
  topK: 12,                      // Number of candidates to select
  minTemporalGap: 0.5,           // Seconds between selected frames
  minSharpnessThreshold: 50,     // Absolute minimum sharpness
  motionNormalizationFactor: 255 // For normalizing motion scores
};

/**
 * Compute sharpness score using Laplacian variance approximation
 *
 * WHY Laplacian variance:
 * - It's the standard approach for blur detection
 * - High variance = sharp edges = in-focus image
 * - Low variance = smooth gradients = blurry image
 *
 * Implementation:
 * - We approximate Laplacian by computing local variance
 * - This is faster than full convolution and works well enough
 *
 * @param {string} imagePath - Path to PNG image
 * @returns {Promise<number>} Sharpness score (higher = sharper)
 */
export async function computeSharpness(imagePath) {
  try {
    // Load image as grayscale for faster processing
    const { data, info } = await sharp(imagePath)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    // Compute Laplacian approximation using 3x3 kernel
    // Kernel: [0, 1, 0]
    //         [1,-4, 1]
    //         [0, 1, 0]
    //
    // WHY this kernel: Standard discrete Laplacian for edge detection
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;

        // Apply Laplacian kernel
        const laplacian =
          -4 * data[idx] +
          data[idx - 1] +           // left
          data[idx + 1] +           // right
          data[idx - width] +       // top
          data[idx + width];        // bottom

        sum += laplacian;
        sumSq += laplacian * laplacian;
        count++;
      }
    }

    // Variance = E[X^2] - E[X]^2
    const mean = sum / count;
    const variance = (sumSq / count) - (mean * mean);

    // Return variance as sharpness score
    // Higher variance = more edges = sharper image
    return Math.sqrt(variance);
  } catch (e) {
    console.error(`[sharpness] Failed to process ${imagePath}: ${e.message}`);
    return 0;
  }
}

/**
 * Compute motion score between two consecutive frames
 *
 * WHY motion scoring:
 * - High motion between frames indicates the product was moving
 * - We prefer frames where motion BEFORE and AFTER is low (pause moments)
 * - This catches the "brief stillness" even in fast-rotating videos
 *
 * Implementation:
 * - Absolute pixel difference averaged across image
 * - Normalized to 0-1 range
 *
 * @param {string} imagePath1 - Previous frame
 * @param {string} imagePath2 - Current frame
 * @returns {Promise<number>} Motion score (0 = no motion, 1 = high motion)
 */
export async function computeMotion(imagePath1, imagePath2) {
  if (!imagePath1) return 0; // First frame has no motion

  try {
    // Load both images as small grayscale for speed
    // WHY resize: Motion detection doesn't need full resolution
    const size = 256;

    const [img1, img2] = await Promise.all([
      sharp(imagePath1)
        .greyscale()
        .resize(size, size, { fit: 'fill' })
        .raw()
        .toBuffer(),
      sharp(imagePath2)
        .greyscale()
        .resize(size, size, { fit: 'fill' })
        .raw()
        .toBuffer()
    ]);

    // Compute absolute difference
    let totalDiff = 0;
    for (let i = 0; i < img1.length; i++) {
      totalDiff += Math.abs(img1[i] - img2[i]);
    }

    // Normalize to 0-1 range
    const avgDiff = totalDiff / img1.length;
    return avgDiff / 255;
  } catch (e) {
    console.error(`[motion] Failed to compare frames: ${e.message}`);
    return 0.5; // Assume moderate motion on error
  }
}

/**
 * Score all extracted frames
 *
 * WHY batch scoring:
 * - Allows progress reporting
 * - Enables motion computation (needs consecutive frames)
 * - Builds a complete picture before selection
 *
 * @param {Array} frames - Array of frame objects from extractFramesDense
 * @param {Object} config - Scoring configuration
 * @returns {Promise<Array>} Frames with scores added
 */
export async function scoreFrames(frames, config = {}) {
  const { alpha, motionNormalizationFactor } = { ...DEFAULT_CONFIG, ...config };

  console.log(`[scoring] Scoring ${frames.length} frames...`);
  const scoredFrames = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const prevFrame = i > 0 ? frames[i - 1] : null;

    // Progress indicator every 10 frames
    if (i % 10 === 0) {
      console.log(`[scoring] Processing frame ${i + 1}/${frames.length}`);
    }

    // Compute individual scores
    const sharpness = await computeSharpness(frame.path);
    const motion = await computeMotion(prevFrame?.path, frame.path);

    // Combined score: prefer sharp + still frames
    // WHY this formula:
    // - Sharpness is primary (we NEED a usable image)
    // - Motion is a penalty (we prefer stillness)
    // - Alpha controls the tradeoff
    const combinedScore = sharpness - (alpha * motion * motionNormalizationFactor);

    scoredFrames.push({
      ...frame,
      sharpness,
      motion,
      score: combinedScore
    });
  }

  console.log(`[scoring] Completed scoring ${frames.length} frames`);
  return scoredFrames;
}

/**
 * Select top candidate frames with temporal diversity
 *
 * WHY diversity constraint:
 * - Without it, we might select 12 frames all from the same 1-second pause
 * - We want coverage across the video to capture different angles
 * - minTemporalGap ensures we don't cluster too tightly
 *
 * Algorithm:
 * 1. Sort by score descending
 * 2. Greedily select top frame
 * 3. Skip frames too close to already selected
 * 4. Repeat until we have K candidates
 *
 * @param {Array} scoredFrames - Frames with scores
 * @param {Object} config - Selection configuration
 * @returns {Array} Selected candidate frames
 */
export function selectCandidates(scoredFrames, config = {}) {
  const { topK, minTemporalGap, minSharpnessThreshold } = { ...DEFAULT_CONFIG, ...config };

  // First, filter out frames below minimum sharpness
  // WHY: No point considering completely unusable frames
  const usableFrames = scoredFrames.filter(f => f.sharpness >= minSharpnessThreshold);

  if (usableFrames.length === 0) {
    console.warn('[selection] No frames meet minimum sharpness threshold!');
    return { candidates: [], unusableReason: 'all_frames_too_blurry' };
  }

  console.log(`[selection] ${usableFrames.length}/${scoredFrames.length} frames meet minimum sharpness`);

  // Sort by combined score (highest first)
  const sorted = [...usableFrames].sort((a, b) => b.score - a.score);

  // Greedy selection with temporal diversity
  const selected = [];
  const selectedTimestamps = [];

  for (const frame of sorted) {
    if (selected.length >= topK) break;

    // Check temporal distance to all selected frames
    const tooClose = selectedTimestamps.some(
      t => Math.abs(t - frame.timestamp) < minTemporalGap
    );

    if (!tooClose) {
      selected.push(frame);
      selectedTimestamps.push(frame.timestamp);
    }
  }

  // If we couldn't get enough diverse frames, relax the constraint
  // WHY: Better to have some candidates than none
  if (selected.length < topK && selected.length < sorted.length) {
    console.log(`[selection] Relaxing temporal constraint to get more candidates`);
    for (const frame of sorted) {
      if (selected.length >= topK) break;
      if (!selected.includes(frame)) {
        selected.push(frame);
      }
    }
  }

  // Sort selected by timestamp for logical ordering
  selected.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`[selection] Selected ${selected.length} candidate frames`);
  return { candidates: selected, unusableReason: null };
}

/**
 * Generate quality report for unusable videos
 *
 * WHY quality reports:
 * - User needs actionable feedback
 * - "Video unusable" is not helpful
 * - Specific suggestions enable a successful reshoot
 *
 * @param {Array} scoredFrames - All scored frames
 * @param {Object} videoMetadata - Video metadata
 * @returns {Object} Quality report with suggestions
 */
export function generateQualityReport(scoredFrames, videoMetadata) {
  const sharpnessValues = scoredFrames.map(f => f.sharpness);
  const motionValues = scoredFrames.map(f => f.motion);

  const avgSharpness = sharpnessValues.reduce((a, b) => a + b, 0) / sharpnessValues.length;
  const maxSharpness = Math.max(...sharpnessValues);
  const avgMotion = motionValues.reduce((a, b) => a + b, 0) / motionValues.length;

  const issues = [];
  const suggestions = [];

  // Analyze sharpness distribution
  if (maxSharpness < DEFAULT_CONFIG.minSharpnessThreshold) {
    issues.push('consistently_blurry');
    suggestions.push('Ensure adequate lighting (natural daylight works best)');
    suggestions.push('Clean camera lens before recording');
  }

  if (avgSharpness < DEFAULT_CONFIG.minSharpnessThreshold * 0.7) {
    issues.push('severe_blur');
    suggestions.push('Use a tripod or stabilize camera against a surface');
  }

  // Analyze motion distribution
  if (avgMotion > 0.3) {
    issues.push('excessive_motion');
    suggestions.push('Pause for 1-2 seconds at each angle before rotating');
    suggestions.push('Rotate product more slowly');
  }

  // Check for any "pause moments"
  const lowMotionFrames = scoredFrames.filter(f => f.motion < 0.1);
  if (lowMotionFrames.length < 3) {
    issues.push('no_pause_moments');
    suggestions.push('Hold product still for brief moments during recording');
  }

  // Compute overall rating
  let rating = 'poor';
  if (maxSharpness >= DEFAULT_CONFIG.minSharpnessThreshold * 2 && lowMotionFrames.length >= 5) {
    rating = 'usable';
  }
  if (avgSharpness >= DEFAULT_CONFIG.minSharpnessThreshold * 1.5 && avgMotion < 0.15) {
    rating = 'excellent';
  }

  return {
    video: {
      filename: videoMetadata.filename,
      duration_sec: videoMetadata.duration
    },
    analysis: {
      total_frames_analyzed: scoredFrames.length,
      average_sharpness: Math.round(avgSharpness * 10) / 10,
      max_sharpness: Math.round(maxSharpness * 10) / 10,
      average_motion: Math.round(avgMotion * 100) / 100,
      low_motion_frames: lowMotionFrames.length,
      sharpness_threshold: DEFAULT_CONFIG.minSharpnessThreshold
    },
    overall_quality: {
      rating,
      issues
    },
    reshoot_guidance: suggestions,
    recommendation: rating === 'poor'
      ? 'Video quality insufficient. Please reshoot following the guidance above.'
      : 'Video is processable but quality could be improved.'
  };
}

/**
 * Prepare candidate metadata for Gemini
 *
 * WHY separate metadata:
 * - Gemini needs context about each frame
 * - We don't want to send scoring details (confuses the model)
 * - Clean metadata enables better reasoning
 *
 * @param {Array} candidates - Selected candidate frames
 * @returns {Array} Clean metadata for Gemini
 */
export function prepareCandidateMetadata(candidates) {
  return candidates.map((c, idx) => ({
    frame_id: c.frameId,
    timestamp_sec: Math.round(c.timestamp * 100) / 100,
    sequence_position: idx + 1,
    total_candidates: candidates.length
  }));
}

/**
 * Main pipeline: extract, score, select
 *
 * @param {string} videoPath - Path to video file
 * @param {Object} options - Pipeline options
 * @returns {Promise<Object>} Pipeline result with candidates or quality report
 */
export async function runSmartFramePipeline(videoPath, videoMetadata, extractedFrames, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  console.log('[pipeline] Starting smart frame selection...');

  // Step 1: Score all frames
  const scoredFrames = await scoreFrames(extractedFrames, config);

  // Step 2: Select candidates
  const { candidates, unusableReason } = selectCandidates(scoredFrames, config);

  // Step 3: Handle failure case
  if (candidates.length === 0) {
    console.warn('[pipeline] Video marked as unusable');
    return {
      success: false,
      unusable: true,
      qualityReport: generateQualityReport(scoredFrames, videoMetadata)
    };
  }

  // Step 4: Prepare for Gemini
  const candidateMetadata = prepareCandidateMetadata(candidates);

  console.log('[pipeline] Smart frame selection complete');
  return {
    success: true,
    unusable: false,
    candidates,
    candidateMetadata,
    scoredFrames, // Keep for debugging
    qualityReport: generateQualityReport(scoredFrames, videoMetadata)
  };
}

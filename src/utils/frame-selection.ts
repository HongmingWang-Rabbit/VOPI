/**
 * Frame Selection Utilities
 *
 * Functions for selecting optimal frames based on quality scores
 * and angle diversity for commercial image generation.
 */

import type { FrameMetadata } from '../processors/types.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ service: 'frame-selection' });

/**
 * Select best frames for angle diversity
 *
 * Prioritizes distinct angles with highest quality scores.
 * This function:
 * 1. Groups frames by angle estimate
 * 2. Sorts frames within each group by quality score
 * 3. Selects the best frame from each unique angle
 * 4. Fills remaining slots with additional high-quality frames
 *
 * @param frames - Array of frame metadata
 * @param maxAngles - Maximum number of frames to select
 * @returns Array of selected frames with diverse angles
 *
 * @example
 * ```typescript
 * const allFrames = getInputFrames(data);
 * const selectedFrames = selectBestAngles(allFrames, 4);
 * // Returns up to 4 frames with diverse angles
 * ```
 */
export function selectBestAngles(
  frames: FrameMetadata[],
  maxAngles: number
): FrameMetadata[] {
  if (frames.length <= maxAngles) {
    return frames;
  }

  // Group frames by angle estimate
  const angleGroups = new Map<string, FrameMetadata[]>();

  for (const frame of frames) {
    const angle = frame.angleEstimate || 'unknown';
    const group = angleGroups.get(angle);
    if (group) {
      group.push(frame);
    } else {
      angleGroups.set(angle, [frame]);
    }
  }

  // Sort frames within each group by quality score (descending)
  for (const group of angleGroups.values()) {
    group.sort((a, b) => getFrameScore(b) - getFrameScore(a));
  }

  // Select best frame from each angle, prioritizing diversity
  const selected: FrameMetadata[] = [];
  const angles = Array.from(angleGroups.keys());

  // First pass: one frame per unique angle
  for (const angle of angles) {
    if (selected.length >= maxAngles) break;
    const angleFrames = angleGroups.get(angle)!;
    if (angleFrames.length > 0) {
      selected.push(angleFrames[0]);
    }
  }

  // Second pass: if we still need more, take additional high-quality frames
  if (selected.length < maxAngles) {
    const selectedIds = new Set(selected.map(f => f.frameId));
    const remaining = frames
      .filter(f => !selectedIds.has(f.frameId))
      .sort((a, b) => getFrameScore(b) - getFrameScore(a));

    for (const frame of remaining) {
      if (selected.length >= maxAngles) break;
      selected.push(frame);
    }
  }

  logger.info({
    totalFrames: frames.length,
    selectedFrames: selected.length,
    uniqueAngles: angleGroups.size,
    selectedAngles: [...new Set(selected.map(f => f.angleEstimate || 'unknown'))],
  }, 'Selected frames for angle diversity');

  return selected;
}

/**
 * Get the quality score for a frame
 *
 * Prefers geminiScore over score for consistency with AI classification.
 *
 * @param frame - Frame metadata
 * @returns Quality score (higher is better)
 */
export function getFrameScore(frame: FrameMetadata): number {
  return frame.geminiScore ?? frame.score ?? 0;
}

/**
 * Group frames by angle estimate
 *
 * @param frames - Array of frame metadata
 * @returns Map of angle to frames array
 */
export function groupFramesByAngle(frames: FrameMetadata[]): Map<string, FrameMetadata[]> {
  const groups = new Map<string, FrameMetadata[]>();

  for (const frame of frames) {
    const angle = frame.angleEstimate || 'unknown';
    const group = groups.get(angle);
    if (group) {
      group.push(frame);
    } else {
      groups.set(angle, [frame]);
    }
  }

  return groups;
}

/**
 * Get unique angles from frames
 *
 * @param frames - Array of frame metadata
 * @returns Array of unique angle estimates
 */
export function getUniqueAngles(frames: FrameMetadata[]): string[] {
  const angles = new Set<string>();
  for (const frame of frames) {
    angles.add(frame.angleEstimate || 'unknown');
  }
  return Array.from(angles);
}

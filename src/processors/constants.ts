/**
 * Processor Constants
 *
 * Centralized constants for processor implementations.
 */

import type { FrameObstructions, BackgroundRecommendations } from '../types/job.types.js';

/**
 * Default frame obstructions when not provided
 */
export const DEFAULT_FRAME_OBSTRUCTIONS: FrameObstructions = {
  has_obstruction: false,
  obstruction_types: [],
  obstruction_description: null,
  removable_by_ai: true,
};

/**
 * Default background recommendations when not provided
 */
export const DEFAULT_BACKGROUND_RECOMMENDATIONS: BackgroundRecommendations = {
  solid_color: '#FFFFFF',
  solid_color_name: 'white',
  real_life_setting: 'on a clean white surface',
  creative_shot: 'floating with soft shadow',
};

/**
 * Progress percentages for pipeline steps
 * Defines the expected progress range for each processor
 */
export const PROGRESS = {
  DOWNLOAD: {
    START: 5,
    END: 10,
  },
  EXTRACT_FRAMES: {
    START: 10,
    ANALYZING: 10,
    EXTRACTING: 15,
    END: 30,
  },
  SCORE_FRAMES: {
    START: 30,
    END: 45,
  },
  CLASSIFY: {
    START: 50,
    END: 65,
  },
  EXTRACT_PRODUCTS: {
    START: 65,
    END: 70,
  },
  UPLOAD_FRAMES: {
    START: 70,
    END: 75,
  },
  GENERATE_COMMERCIAL: {
    START: 75,
    END: 95,
  },
  COMPLETE: {
    END: 100,
  },
} as const;

/**
 * Default video filename for downloads
 */
export const DEFAULT_VIDEO_FILENAME = 'input.mp4';

/**
 * Calculate progress percentage within a range
 * @param current - Current item index (0-based)
 * @param total - Total items
 * @param startPercent - Start percentage
 * @param endPercent - End percentage
 */
export function calculateProgress(
  current: number,
  total: number,
  startPercent: number,
  endPercent: number
): number {
  if (total === 0) return startPercent;
  const range = endPercent - startPercent;
  return startPercent + Math.round(((current + 1) / total) * range);
}

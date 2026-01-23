/**
 * Shared Image Utilities
 *
 * Common utilities for image processing across providers.
 */

import { createChildLogger } from './logger.js';

const logger = createChildLogger({ service: 'image-utils' });

/**
 * Supported image MIME types
 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Known image file extensions mapped to MIME types
 */
const EXTENSION_TO_MIME: Record<string, ImageMimeType> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/**
 * Get MIME type from file extension
 *
 * @param filePath - Path to the image file
 * @returns The appropriate MIME type for the image
 */
export function getImageMimeType(filePath: string): ImageMimeType {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  const mimeType = EXTENSION_TO_MIME[ext];

  if (!mimeType) {
    logger.warn({ filePath, extension: ext }, 'Unknown image extension, defaulting to image/jpeg');
    return 'image/jpeg';
  }

  return mimeType;
}

/**
 * Maximum number of reference frames to send to Gemini APIs
 * to avoid hitting input token limits
 */
export const MAX_REFERENCE_FRAMES = 4;

/**
 * Limit reference frame paths to a reasonable number
 *
 * @param paths - Array of reference frame paths
 * @param max - Maximum number to keep (default: MAX_REFERENCE_FRAMES)
 * @returns Limited array of paths
 */
export function limitReferenceFrames(paths: string[], max: number = MAX_REFERENCE_FRAMES): string[] {
  if (paths.length <= max) {
    return paths;
  }

  // Take evenly distributed frames
  const step = paths.length / max;
  const limited: string[] = [];
  for (let i = 0; i < max; i++) {
    const index = Math.floor(i * step);
    limited.push(paths[index]);
  }

  return limited;
}

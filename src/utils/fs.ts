/**
 * File system utilities
 */

import { unlink } from 'fs/promises';
import path from 'path';

/**
 * Safely delete a file, ignoring errors if it doesn't exist
 *
 * @param filePath - Path to the file to delete
 */
export async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore errors (file may not exist)
  }
}

/**
 * Generate a variant path by appending a suffix before the extension
 *
 * @param originalPath - Original file path (e.g., "/path/to/image.png")
 * @param suffix - Suffix to append (e.g., "_prepared")
 * @returns New path with suffix (e.g., "/path/to/image_prepared.png")
 *
 * @example
 * getVariantPath('/tmp/image.png', '_prepared') // '/tmp/image_prepared.png'
 * getVariantPath('/tmp/image.PNG', '_mask')     // '/tmp/image_mask.PNG'
 */
export function getVariantPath(originalPath: string, suffix: string): string {
  const parsed = path.parse(originalPath);
  return path.format({
    dir: parsed.dir,
    name: parsed.name + suffix,
    ext: parsed.ext,
  });
}

import path from 'path';
import { randomUUID } from 'crypto';

import { createChildLogger } from './logger.js';
import { getConfig } from '../config/index.js';
import { storageService } from '../services/storage.service.js';

const logger = createChildLogger({ service: 's3-presign' });

/**
 * Result of uploading a file for presigned URL access
 */
export interface PresignedUploadResult {
  url: string;
  tempKey: string;
}

/**
 * Check if S3 endpoint is localhost (development mode)
 * Used to determine whether to use presigned URLs (production) or direct file upload (local dev)
 */
export function isLocalS3(): boolean {
  const config = getConfig();
  const endpoint = config.storage.endpoint || '';
  return endpoint.includes('localhost') || endpoint.includes('127.0.0.1') || endpoint.includes('::1');
}

/**
 * Upload file to S3 and get presigned URL for external API access
 *
 * @param imagePath - Local file path to upload
 * @param prefix - S3 key prefix (e.g., 'temp/photoroom', 'temp/claid')
 * @param expirySeconds - Presigned URL expiry in seconds (uses API_PRESIGN_EXPIRY_SECONDS config if not provided)
 * @returns Presigned URL and temp S3 key for cleanup
 */
export async function getPresignedImageUrl(
  imagePath: string,
  prefix: string,
  expirySeconds?: number
): Promise<PresignedUploadResult> {
  const config = getConfig();
  const expiry = expirySeconds ?? config.apiPresign.expirySeconds;
  const ext = path.extname(imagePath).toLowerCase();
  const tempKey = `${prefix}/${randomUUID()}${ext}`;

  await storageService.uploadFile(imagePath, tempKey);
  const url = await storageService.getPresignedUrl(tempKey, expiry);

  logger.debug({ tempKey, prefix }, 'Uploaded image with presigned URL for external API');
  return { url, tempKey };
}

/**
 * Clean up temporary S3 file
 * Silently handles errors to avoid disrupting main flow
 *
 * @param tempKey - S3 key to delete (no-op if undefined)
 */
export async function cleanupTempS3File(tempKey: string | undefined): Promise<void> {
  if (!tempKey) return;
  try {
    await storageService.deleteFile(tempKey);
    logger.debug({ tempKey }, 'Cleaned up temporary S3 file');
  } catch (err) {
    logger.warn({ tempKey, error: (err as Error).message }, 'Failed to clean up temporary S3 file');
  }
}

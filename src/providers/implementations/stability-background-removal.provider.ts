/**
 * Stability AI Background Removal Provider
 *
 * Uses Stability AI's v2beta remove-background API for background removal.
 * This provides high-quality background removal with transparent output.
 *
 * API Reference: https://platform.stability.ai/docs/api-reference#tag/Edit/paths/~1v2beta~1stable-image~1edit~1remove-background/post
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

import { createChildLogger } from '../../utils/logger.js';
import { ExternalApiError } from '../../utils/errors.js';
import { getConfig } from '../../config/index.js';
import type {
  BackgroundRemovalProvider,
  BackgroundRemovalResult,
  BackgroundRemovalOptions,
} from '../interfaces/background-removal.provider.js';

const logger = createChildLogger({ service: 'stability-bg-removal' });

/**
 * Stability AI API constants
 */
const STABILITY_CONSTANTS = {
  /** v2beta remove-background endpoint */
  REMOVE_BG_ENDPOINT: '/v2beta/stable-image/edit/remove-background',
  /** Maximum retry attempts for API calls */
  MAX_RETRIES: 3,
  /** Delay between retries in ms */
  RETRY_DELAY_MS: 1000,
  /** Maximum payload size (10MB with some margin for multipart overhead) */
  MAX_PAYLOAD_BYTES: 9 * 1024 * 1024, // 9MB to leave room for multipart headers
  /** Target width for resizing large images */
  RESIZE_TARGET_WIDTH: 2048,
} as const;

/**
 * Stability AI Background Removal Provider
 *
 * Uses Stability AI's remove-background API which provides high-quality
 * background removal with automatic subject detection.
 */
export class StabilityBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly providerId = 'stability';

  async removeBackground(
    imagePath: string,
    outputPath: string,
    _options: BackgroundRemovalOptions = {}
  ): Promise<BackgroundRemovalResult> {
    const config = getConfig();
    const apiKey = config.apis.stability;
    const apiBase = config.apis.stabilityBase;

    if (!apiKey) {
      return {
        success: false,
        error: 'Stability API key not configured (STABILITY_API_KEY)',
      };
    }

    try {
      logger.info({ imagePath: path.basename(imagePath) }, 'Removing background with Stability AI');

      // Read the image file and check size
      let imageBuffer: Buffer = await readFile(imagePath);
      const originalSize = imageBuffer.length;

      // Resize if image is too large for Stability API (10MB limit)
      if (imageBuffer.length > STABILITY_CONSTANTS.MAX_PAYLOAD_BYTES) {
        logger.info({
          originalSize,
          maxSize: STABILITY_CONSTANTS.MAX_PAYLOAD_BYTES,
          targetWidth: STABILITY_CONSTANTS.RESIZE_TARGET_WIDTH,
        }, 'Image too large, resizing before upload');

        imageBuffer = await this.resizeImageForUpload(imageBuffer);

        logger.info({
          originalSize,
          newSize: imageBuffer.length,
          reduction: `${Math.round((1 - imageBuffer.length / originalSize) * 100)}%`,
        }, 'Image resized successfully');
      }

      const ext = path.extname(imagePath).toLowerCase();
      // After resize, we always output JPEG for smaller file size
      const mimeType = imageBuffer.length < originalSize
        ? 'image/jpeg'
        : (ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
      const filename = path.basename(imagePath);

      // Build multipart form data
      // Convert Buffer to Uint8Array for Blob compatibility
      const formData = new FormData();
      formData.append('image', new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), filename);
      formData.append('output_format', 'png'); // PNG for transparency support

      // Make API request with retry logic
      const endpoint = `${apiBase}${STABILITY_CONSTANTS.REMOVE_BG_ENDPOINT}`;
      const resultBuffer = await this.makeRequestWithRetry(apiKey, endpoint, formData);

      // Write the result
      await writeFile(outputPath, resultBuffer);

      logger.info({
        outputPath: path.basename(outputPath),
        size: resultBuffer.length,
      }, 'Background removed successfully with Stability AI');

      return {
        success: true,
        outputPath,
        size: resultBuffer.length,
        method: 'stability-remove-bg',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage, imagePath }, 'Stability background removal failed');

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Make API request with retry logic
   */
  private async makeRequestWithRetry(
    apiKey: string,
    endpoint: string,
    formData: FormData,
    attempt = 1
  ): Promise<Buffer> {
    try {
      logger.debug({ endpoint, attempt }, 'Calling Stability AI remove-background API');

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'image/*',
        },
        body: formData,
      });

      if (!response.ok) {
        // Try to get error details from response
        let errorDetails = '';
        try {
          const errorBody = await response.text();
          errorDetails = errorBody;
        } catch {
          errorDetails = `HTTP ${response.status}`;
        }

        logger.error({ status: response.status, error: errorDetails, attempt }, 'Stability API error');

        // Retry on rate limit or server errors
        if ((response.status === 429 || response.status >= 500) && attempt < STABILITY_CONSTANTS.MAX_RETRIES) {
          logger.warn({ status: response.status, attempt }, 'Stability API error, retrying...');
          await this.delay(STABILITY_CONSTANTS.RETRY_DELAY_MS * attempt);
          return this.makeRequestWithRetry(apiKey, endpoint, formData, attempt + 1);
        }

        throw new ExternalApiError('Stability', `API error (HTTP ${response.status}): ${errorDetails}`);
      }

      // API returns binary image data directly
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }

      // Retry on network errors
      if (attempt < STABILITY_CONSTANTS.MAX_RETRIES) {
        logger.warn({ error: (error as Error).message, attempt }, 'Stability request failed, retrying...');
        await this.delay(STABILITY_CONSTANTS.RETRY_DELAY_MS * attempt);
        return this.makeRequestWithRetry(apiKey, endpoint, formData, attempt + 1);
      }

      throw new ExternalApiError('Stability', `Request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resize image to fit within Stability AI's payload limit
   * Uses progressive resize strategy to maintain quality while reducing file size
   */
  private async resizeImageForUpload(imageBuffer: Buffer): Promise<Buffer> {
    let currentBuffer: Buffer = imageBuffer;
    let currentWidth: number = STABILITY_CONSTANTS.RESIZE_TARGET_WIDTH;

    // Progressive resize: start at target width, reduce further if still too large
    while (currentBuffer.length > STABILITY_CONSTANTS.MAX_PAYLOAD_BYTES && currentWidth >= 512) {
      currentBuffer = await sharp(imageBuffer)
        .resize(currentWidth, null, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();

      // If still too large, try smaller width
      if (currentBuffer.length > STABILITY_CONSTANTS.MAX_PAYLOAD_BYTES) {
        currentWidth = Math.floor(currentWidth * 0.75);
      }
    }

    return currentBuffer;
  }

  isAvailable(): boolean {
    try {
      const config = getConfig();
      return !!config.apis.stability;
    } catch {
      return false;
    }
  }
}

export const stabilityBackgroundRemovalProvider = new StabilityBackgroundRemovalProvider();

import { readFile, writeFile } from 'fs/promises';
import path from 'path';

import { createChildLogger } from '../../utils/logger.js';
import { ExternalApiError } from '../../utils/errors.js';
import { getConfig } from '../../config/index.js';
import { photoroomService } from '../../services/photoroom.service.js';
import { isLocalS3, getPresignedImageUrl, cleanupTempS3File } from '../../utils/s3-presign.js';
import type {
  BackgroundRemovalProvider,
  BackgroundRemovalResult,
  BackgroundRemovalOptions,
} from '../interfaces/background-removal.provider.js';

const logger = createChildLogger({ service: 'claid-bg-removal' });

/**
 * Claid.ai API constants
 */
const CLAID_CONSTANTS = {
  /** JSON endpoint - accepts URL input */
  API_ENDPOINT_URL: 'https://api.claid.ai/v1/image/edit',
  /** Multipart upload endpoint - accepts file directly */
  API_ENDPOINT_UPLOAD: 'https://api.claid.ai/v1/image/edit/upload',
  /** Default object to keep if not specified */
  DEFAULT_OBJECT: 'product',
  /** Maximum retry attempts for API calls */
  MAX_RETRIES: 3,
  /** Delay between retries in ms */
  RETRY_DELAY_MS: 1000,
} as const;

/**
 * Claid.ai API response format
 */
interface ClaidResponse {
  data?: {
    output?: {
      tmp_url?: string;
    };
  };
  error?: {
    type?: string;
    message?: string;
  };
}

/**
 * Claid Background Removal Provider
 *
 * Uses Claid.ai API for background removal with selective object retention.
 * This provider uses the "guided background removal" feature which allows
 * specifying exactly which object to keep using text prompts.
 *
 * API Documentation: https://docs.claid.ai/image-editing-api/image-operations/background
 */
export class ClaidBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly providerId = 'claid';

  async removeBackground(
    imagePath: string,
    outputPath: string,
    options: BackgroundRemovalOptions = {}
  ): Promise<BackgroundRemovalResult> {
    const config = getConfig();
    const apiKey = config.apis.claid;

    if (!apiKey) {
      return {
        success: false,
        error: 'Claid API key not configured',
      };
    }

    // Track temporary S3 key for cleanup (only used in production mode)
    let tempS3Key: string | undefined;

    try {
      // Determine what object to keep based on options
      const objectToKeep = this.determineObjectToKeep(options);

      logger.info({ imagePath, objectToKeep }, 'Removing background with Claid.ai');

      // Check if S3 is publicly accessible (not localhost)
      const useLocalMode = isLocalS3();

      let result: ClaidResponse;

      if (useLocalMode) {
        // Development mode: Use multipart upload (localhost S3 URLs not accessible externally)
        logger.debug('Using multipart upload for Claid (local S3 detected)');
        result = await this.makeMultipartRequest(apiKey, imagePath, objectToKeep);
      } else {
        // Production mode: Upload to S3 and use presigned URL
        const presignResult = await getPresignedImageUrl(imagePath, 'temp/claid');
        tempS3Key = presignResult.tempKey;
        logger.debug({ tempS3Key }, 'Using presigned URL for Claid');

        result = await this.makeRequestWithRetry(apiKey, {
          input: presignResult.url,
          ...this.buildOperations(objectToKeep),
        });
      }

      // Download the result image
      if (result.data?.output?.tmp_url) {
        const resultBuffer = await this.downloadImage(result.data.output.tmp_url);
        await writeFile(outputPath, resultBuffer);

        logger.info({ outputPath, size: resultBuffer.length }, 'Background removed successfully with Claid.ai');

        // Check if inpainting is needed to fill holes (e.g., where hands were removed)
        // This uses Photoroom's AI expand to fill transparent gaps in the product
        if (options.useAIEdit) {
          logger.info({ outputPath }, 'Running inpainting to fill holes left by obstruction removal');

          try {
            const inpaintResult = await photoroomService.inpaintHoles(outputPath, outputPath, {
              prompt: 'Fill in any missing or transparent parts of the product to make it complete and whole',
            });

            if (inpaintResult.success) {
              logger.info({ outputPath }, 'Inpainting completed successfully');
              return {
                success: true,
                outputPath,
                size: inpaintResult.size,
                method: 'claid-selective+inpaint',
              };
            } else {
              logger.warn({ error: inpaintResult.error }, 'Inpainting failed, returning original result');
            }
          } catch (inpaintError) {
            logger.warn({ error: (inpaintError as Error).message }, 'Inpainting failed, returning original result');
          }
        }

        return {
          success: true,
          outputPath,
          size: resultBuffer.length,
          method: 'claid-selective',
        };
      }

      throw new Error('No output URL in Claid response');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage, imagePath }, 'Claid background removal failed');

      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      // Clean up temporary S3 file
      await cleanupTempS3File(tempS3Key);
    }
  }

  /**
   * Determine what object to keep based on removal options
   */
  private determineObjectToKeep(options: BackgroundRemovalOptions): string {
    // If custom prompt provided, use it as the object description
    if (options.customPrompt) {
      return options.customPrompt;
    }

    // Default to "product" for e-commerce use case
    return CLAID_CONSTANTS.DEFAULT_OBJECT;
  }

  /**
   * Build the operations object for Claid API
   */
  private buildOperations(objectToKeep: string): Record<string, unknown> {
    return {
      operations: {
        background: {
          remove: {
            selective: {
              object_to_keep: objectToKeep,
            },
            clipping: true,
          },
          color: 'transparent',
        },
      },
      output: {
        format: {
          type: 'png',
        },
      },
    };
  }

  /**
   * Make API request with retry logic
   */
  private async makeRequestWithRetry(
    apiKey: string,
    requestBody: Record<string, unknown>,
    attempt = 1
  ): Promise<ClaidResponse> {
    try {
      const response = await fetch(CLAID_CONSTANTS.API_ENDPOINT_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json() as ClaidResponse;

      if (!response.ok) {
        const errorType = data.error?.type || 'unknown';
        const errorMessage = data.error?.message || `HTTP ${response.status}`;
        const fullError = `${errorType}: ${errorMessage}`;

        logger.error({
          status: response.status,
          errorType,
          errorMessage,
          attempt,
          responseBody: JSON.stringify(data).slice(0, 500), // Log full response for debugging
        }, 'Claid API error response');

        // Retry on rate limit or server errors
        if ((response.status === 429 || response.status >= 500) && attempt < CLAID_CONSTANTS.MAX_RETRIES) {
          logger.warn({ status: response.status, attempt }, 'Claid API error, retrying...');
          await this.delay(CLAID_CONSTANTS.RETRY_DELAY_MS * attempt);
          return this.makeRequestWithRetry(apiKey, requestBody, attempt + 1);
        }

        throw new ExternalApiError('Claid', `API error (HTTP ${response.status}): ${fullError}`);
      }

      return data;
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }

      // Retry on network errors
      if (attempt < CLAID_CONSTANTS.MAX_RETRIES) {
        logger.warn({ error: (error as Error).message, attempt }, 'Claid request failed, retrying...');
        await this.delay(CLAID_CONSTANTS.RETRY_DELAY_MS * attempt);
        return this.makeRequestWithRetry(apiKey, requestBody, attempt + 1);
      }

      throw new ExternalApiError('Claid', `Request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Make multipart upload request (for development with local S3)
   * Uses the /upload endpoint which accepts file directly
   */
  private async makeMultipartRequest(
    apiKey: string,
    imagePath: string,
    objectToKeep: string,
    attempt = 1
  ): Promise<ClaidResponse> {
    try {
      const imageBuffer = await readFile(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const filename = path.basename(imagePath);

      // Create form data with file and operations
      const formData = new FormData();
      formData.append('file', new Blob([imageBuffer], { type: mimeType }), filename);
      formData.append('data', JSON.stringify(this.buildOperations(objectToKeep)));

      const response = await fetch(CLAID_CONSTANTS.API_ENDPOINT_UPLOAD, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
      });

      const data = await response.json() as ClaidResponse;

      if (!response.ok) {
        const errorType = data.error?.type || 'unknown';
        const errorMessage = data.error?.message || `HTTP ${response.status}`;
        const fullError = `${errorType}: ${errorMessage}`;

        logger.error({ status: response.status, errorType, errorMessage, attempt }, 'Claid multipart API error');

        // Retry on rate limit or server errors
        if ((response.status === 429 || response.status >= 500) && attempt < CLAID_CONSTANTS.MAX_RETRIES) {
          logger.warn({ status: response.status, attempt }, 'Claid multipart API error, retrying...');
          await this.delay(CLAID_CONSTANTS.RETRY_DELAY_MS * attempt);
          return this.makeMultipartRequest(apiKey, imagePath, objectToKeep, attempt + 1);
        }

        throw new ExternalApiError('Claid', `Multipart API error (HTTP ${response.status}): ${fullError}`);
      }

      return data;
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }

      // Retry on network errors
      if (attempt < CLAID_CONSTANTS.MAX_RETRIES) {
        logger.warn({ error: (error as Error).message, attempt }, 'Claid multipart request failed, retrying...');
        await this.delay(CLAID_CONSTANTS.RETRY_DELAY_MS * attempt);
        return this.makeMultipartRequest(apiKey, imagePath, objectToKeep, attempt + 1);
      }

      throw new ExternalApiError('Claid', `Multipart request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Download image from URL
   */
  private async downloadImage(url: string): Promise<Buffer> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new ExternalApiError('Claid', `Failed to download result: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isAvailable(): boolean {
    try {
      const config = getConfig();
      return !!config.apis.claid;
    } catch {
      return false;
    }
  }
}

export const claidBackgroundRemovalProvider = new ClaidBackgroundRemovalProvider();

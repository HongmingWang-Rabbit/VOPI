/**
 * Stability AI Upscale Provider
 *
 * Uses Stability AI's upscale API to increase image resolution.
 * Supports both conservative (4x) and creative upscaling modes.
 *
 * API Reference: https://platform.stability.ai/docs/api-reference#tag/Image-to-Image/paths/~1v2beta~1stable-image~1upscale~1conservative/post
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';

import { createChildLogger } from '../../utils/logger.js';
import { getConfig } from '../../config/index.js';
import {
  makeStabilityRequest,
  isWithinSizeLimit,
  getFileSizeError,
} from '../utils/stability-api.js';
import type {
  UpscaleProvider,
  UpscaleResult,
  UpscaleOptions,
} from '../interfaces/upscale.provider.js';

const logger = createChildLogger({ service: 'stability-upscale' });

/**
 * Stability AI upscale endpoint constants
 */
const STABILITY_UPSCALE_ENDPOINTS = {
  /** Conservative upscale endpoint (up to 4x) */
  CONSERVATIVE: '/v2beta/stable-image/upscale/conservative',
  /** Creative upscale endpoint (generative) */
  CREATIVE: '/v2beta/stable-image/upscale/creative',
  /** Fast upscale endpoint */
  FAST: '/v2beta/stable-image/upscale/fast',
} as const;

/**
 * Stability AI Upscale Provider
 *
 * Uses conservative upscaling by default for product images,
 * which provides clean 4x upscaling without generative additions.
 */
export class StabilityUpscaleProvider implements UpscaleProvider {
  readonly providerId = 'stability-upscale';

  async upscale(
    imagePath: string,
    outputPath: string,
    options: UpscaleOptions = {}
  ): Promise<UpscaleResult> {
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
      logger.info({ imagePath: path.basename(imagePath) }, 'Upscaling image with Stability AI');

      // Read the image file
      const imageBuffer = await readFile(imagePath);

      // Check file size
      if (!isWithinSizeLimit(imageBuffer.length)) {
        return {
          success: false,
          error: getFileSizeError(imageBuffer.length),
        };
      }

      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const filename = path.basename(imagePath);

      // Build multipart form data
      const formData = new FormData();
      formData.append('image', new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), filename);
      formData.append('output_format', options.outputFormat || 'png');

      // Use conservative upscale by default (clean 4x upscale)
      // Creative endpoint is for more aggressive generative upscaling (creativity > 0.5)
      const useCreativeEndpoint = options.creativity !== undefined && options.creativity > 0.5;
      const endpointPath = useCreativeEndpoint
        ? STABILITY_UPSCALE_ENDPOINTS.CREATIVE
        : STABILITY_UPSCALE_ENDPOINTS.CONSERVATIVE;
      const endpoint = `${apiBase}${endpointPath}`;

      // Prompt is required for both endpoints
      const prompt = options.prompt || 'A high quality product photo with clean details';
      formData.append('prompt', prompt);

      // Creative endpoint requires creativity parameter (0.2-1.0)
      // Conservative endpoint does NOT accept creativity parameter
      if (useCreativeEndpoint) {
        // Ensure creativity is within valid range (0.2-1.0)
        const creativity = Math.max(0.2, Math.min(1.0, options.creativity ?? 0.5));
        formData.append('creativity', String(creativity));
      }

      // Optional: negative prompt to avoid artifacts
      if (options.negativePrompt) {
        formData.append('negative_prompt', options.negativePrompt);
      }

      // Optional: seed for reproducibility (0 = random)
      if (options.seed !== undefined) {
        formData.append('seed', String(options.seed));
      }

      // Make API request with retry logic using shared utility
      const resultBuffer = await makeStabilityRequest({
        apiKey,
        endpoint,
        formData,
        operationName: 'stability-upscale',
      });

      // Write the result
      await writeFile(outputPath, resultBuffer);

      const method = useCreativeEndpoint ? 'stability-creative-upscale' : 'stability-conservative-upscale';

      logger.info({
        outputPath: path.basename(outputPath),
        inputSize: imageBuffer.length,
        outputSize: resultBuffer.length,
        method,
      }, 'Image upscaled successfully with Stability AI');

      return {
        success: true,
        outputPath,
        size: resultBuffer.length,
        method,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage, imagePath }, 'Stability upscale failed');

      return {
        success: false,
        error: errorMessage,
      };
    }
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

export const stabilityUpscaleProvider = new StabilityUpscaleProvider();

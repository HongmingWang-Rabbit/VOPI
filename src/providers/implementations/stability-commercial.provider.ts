/**
 * Stability AI Commercial Image Provider
 *
 * Generates commercial product images using Stability AI's APIs:
 * - Replace Background and Relight: AI-generated backgrounds with lighting adjustment
 *
 * API Reference: https://platform.stability.ai/docs/api-reference
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

import { createChildLogger } from '../../utils/logger.js';
import { getConfig } from '../../config/index.js';
import {
  makeStabilityAsyncRequest,
  isWithinSizeLimit,
  getFileSizeError,
  parseHexColor,
  STABILITY_API_CONSTANTS,
} from '../utils/stability-api.js';

const logger = createChildLogger({ service: 'stability-commercial' });

/**
 * Stability AI commercial image endpoint constants
 */
const STABILITY_COMMERCIAL_ENDPOINTS = {
  /** Replace Background and Relight endpoint */
  REPLACE_BG: '/v2beta/stable-image/edit/replace-background-and-relight',
  /** Outpaint endpoint */
  OUTPAINT: '/v2beta/stable-image/edit/outpaint',
} as const;

/**
 * Resize image buffer if it exceeds the max pixel limit
 * Returns the original buffer if within limits
 */
async function resizeIfNeeded(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const pixels = width * height;
  const maxPixels = STABILITY_API_CONSTANTS.MAX_PIXELS;

  if (pixels <= maxPixels) {
    return imageBuffer;
  }

  // Calculate scale factor to fit within max pixels
  const scale = Math.sqrt(maxPixels / pixels);
  const newWidth = Math.floor(width * scale);
  const newHeight = Math.floor(height * scale);

  logger.info({
    original: `${width}x${height} (${pixels.toLocaleString()} px)`,
    resized: `${newWidth}x${newHeight} (${(newWidth * newHeight).toLocaleString()} px)`,
  }, 'Resizing image to fit Stability API limits');

  return sharp(imageBuffer)
    .resize(newWidth, newHeight, { fit: 'inside' })
    .png()
    .toBuffer();
}

/**
 * Options for generating commercial image with AI background
 */
export interface CommercialBackgroundOptions {
  /** Background prompt describing the desired scene */
  backgroundPrompt: string;
  /** Foreground prompt to preserve subject attributes */
  foregroundPrompt?: string;
  /** Negative prompt for unwanted elements */
  negativePrompt?: string;
  /** Light source direction */
  lightSourceDirection?: 'above' | 'below' | 'left' | 'right';
  /** Light source strength (0.0-1.0) */
  lightSourceStrength?: number;
  /** How much to preserve original subject (0.0-1.0) */
  preserveOriginalSubject?: number;
  /** Seed for reproducibility */
  seed?: number;
  /** Output format */
  outputFormat?: 'png' | 'jpeg' | 'webp';
}

/**
 * Options for generating solid color background
 */
export interface SolidBackgroundOptions {
  /** Background color in hex format (e.g., '#FFFFFF') */
  backgroundColor: string;
  /** Padding around the product (0.0-1.0 as percentage of image size) */
  padding?: number;
  /** Output format */
  outputFormat?: 'png' | 'jpeg' | 'webp';
}

/**
 * Result of commercial image generation
 */
export interface CommercialGenerationResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  method?: string;
  bgColor?: string;
  bgPrompt?: string;
  error?: string;
}

/**
 * Stability AI Commercial Image Provider
 *
 * Generates commercial product images with various backgrounds.
 */
export class StabilityCommercialProvider {
  readonly providerId = 'stability-commercial';

  /**
   * Generate image with AI-generated background using Replace Background and Relight
   */
  async generateWithAIBackground(
    imagePath: string,
    outputPath: string,
    options: CommercialBackgroundOptions
  ): Promise<CommercialGenerationResult> {
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
      logger.info({
        imagePath: path.basename(imagePath),
        backgroundPrompt: options.backgroundPrompt.slice(0, 50),
      }, 'Generating commercial image with Stability AI');

      // Read the image file
      const rawImageBuffer = await readFile(imagePath);

      // Check file size
      if (!isWithinSizeLimit(rawImageBuffer.length)) {
        return {
          success: false,
          error: getFileSizeError(rawImageBuffer.length),
        };
      }

      // Resize if exceeds max pixel limit (API returns 400 for images > ~9.4M pixels)
      const imageBuffer = await resizeIfNeeded(rawImageBuffer);

      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const filename = path.basename(imagePath);

      // Build multipart form data
      const formData = new FormData();
      formData.append('subject_image', new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), filename);
      formData.append('background_prompt', options.backgroundPrompt);
      formData.append('output_format', options.outputFormat || 'png');

      // Optional parameters
      if (options.foregroundPrompt) {
        formData.append('foreground_prompt', options.foregroundPrompt);
      }
      if (options.negativePrompt) {
        formData.append('negative_prompt', options.negativePrompt);
      }
      if (options.lightSourceDirection) {
        formData.append('light_source_direction', options.lightSourceDirection);
      }
      if (options.lightSourceStrength !== undefined) {
        formData.append('light_source_strength', String(options.lightSourceStrength));
      }
      if (options.preserveOriginalSubject !== undefined) {
        formData.append('preserve_original_subject', String(options.preserveOriginalSubject));
      }
      if (options.seed !== undefined) {
        formData.append('seed', String(options.seed));
      }

      const endpoint = `${apiBase}${STABILITY_COMMERCIAL_ENDPOINTS.REPLACE_BG}`;

      // Make API request with retry logic using shared utility
      // This endpoint may return async (202) responses that need polling
      const resultBuffer = await makeStabilityAsyncRequest({
        apiKey,
        endpoint,
        formData,
        apiBase,
        operationName: 'stability-replace-bg',
      });

      // Write the result
      await writeFile(outputPath, resultBuffer);

      logger.info({
        outputPath: path.basename(outputPath),
        inputSize: imageBuffer.length,
        outputSize: resultBuffer.length,
        backgroundPrompt: options.backgroundPrompt.slice(0, 50),
      }, 'Commercial image generated with Stability AI');

      return {
        success: true,
        outputPath,
        size: resultBuffer.length,
        method: 'stability-replace-bg-relight',
        bgPrompt: options.backgroundPrompt,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage, imagePath }, 'Stability commercial generation failed');

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Generate image with solid color background using Sharp
   * (No API call needed - just compositing)
   */
  async generateWithSolidBackground(
    imagePath: string,
    outputPath: string,
    options: SolidBackgroundOptions
  ): Promise<CommercialGenerationResult> {
    try {
      logger.info({
        imagePath: path.basename(imagePath),
        backgroundColor: options.backgroundColor,
      }, 'Generating image with solid background');

      // Read and get metadata
      const image = sharp(imagePath);
      const metadata = await image.metadata();

      if (!metadata.width || !metadata.height) {
        return {
          success: false,
          error: 'Could not get image dimensions',
        };
      }

      // Parse hex color with validation
      const bgColor = parseHexColor(options.backgroundColor);

      // Calculate padding
      const padding = options.padding ?? 0.12;
      const paddingPx = Math.round(Math.max(metadata.width, metadata.height) * padding);

      // New dimensions with padding
      const newWidth = metadata.width + (paddingPx * 2);
      const newHeight = metadata.height + (paddingPx * 2);

      // Create background with solid color
      const background = sharp({
        create: {
          width: newWidth,
          height: newHeight,
          channels: 4,
          background: bgColor,
        },
      });

      // Composite the product image on top
      const resultBuffer = await background
        .composite([{
          input: await image.png().toBuffer(),
          top: paddingPx,
          left: paddingPx,
        }])
        .png()
        .toBuffer();

      await writeFile(outputPath, resultBuffer);

      logger.info({
        outputPath: path.basename(outputPath),
        size: resultBuffer.length,
      }, 'Solid background image generated');

      return {
        success: true,
        outputPath,
        size: resultBuffer.length,
        method: 'solid-background',
        bgColor: options.backgroundColor,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage, imagePath }, 'Solid background generation failed');

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Check if provider is available
   */
  isAvailable(): boolean {
    try {
      const config = getConfig();
      return !!config.apis.stability;
    } catch {
      return false;
    }
  }
}

export const stabilityCommercialProvider = new StabilityCommercialProvider();

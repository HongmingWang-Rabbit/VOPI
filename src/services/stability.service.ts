/**
 * Stability AI Service
 *
 * Provides inpainting capabilities using Stability AI's REST API.
 * Uses the v2beta stable-image edit API for inpainting.
 *
 * API Reference: https://platform.stability.ai/docs/api-reference
 */

import { writeFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

import { createChildLogger } from '../utils/logger.js';
import { ExternalApiError } from '../utils/errors.js';
import { getConfig } from '../config/index.js';
import { safeUnlink, getVariantPath } from '../utils/fs.js';

const logger = createChildLogger({ service: 'stability' });

// =============================================================================
// Constants
// =============================================================================

/** v2beta stable-image edit API endpoint for inpainting */
const INPAINT_ENDPOINT = '/v2beta/stable-image/edit/inpaint';

/** Maximum pixels for reasonable file size and API speed (~4MP) */
const MAX_PIXELS = 4_000_000;

/** Minimum dimension required by Stable Diffusion */
const MIN_DIMENSION = 64;

/** Dilation radius for expanding mask edges (pixels). Keep small (1-5) for performance. */
const DILATION_RADIUS = 3;

/** Gaussian blur sigma for mask edge feathering */
const MASK_BLUR_SIGMA = 4;

/** API-side mask growth for smooth transitions (0-20 range) */
const GROW_MASK_VALUE = '10';

/** Maximum retry attempts for transient API failures */
const MAX_RETRIES = 3;

/** Alpha threshold for determining transparent vs opaque pixels */
const ALPHA_THRESHOLD = 128;

export interface InpaintResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  error?: string;
}

export interface InpaintOptions {
  prompt?: string;
  negativePrompt?: string;
  /** Write debug files (_prepared.png, _inpaint_mask.png) for inspection */
  debug?: boolean;
  /** Clean up intermediate files after successful inpainting */
  cleanup?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Apply morphological dilation to a grayscale mask buffer
 * Expands white (255) areas by the specified radius
 *
 * @param mask - Input grayscale buffer (1 channel)
 * @param width - Image width
 * @param height - Image height
 * @param radius - Dilation radius in pixels
 * @returns New dilated buffer
 */
function dilateMask(mask: Buffer | Uint8Array, width: number, height: number, radius: number): Buffer {
  const dilated = Buffer.alloc(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      let maxVal = mask[idx];

      // Check all pixels within radius (square kernel)
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const nIdx = ny * width + nx;
            maxVal = Math.max(maxVal, mask[nIdx]);
          }
        }
      }
      dilated[idx] = maxVal;
    }
  }

  return dilated;
}

/**
 * StabilityService - Stability AI integration for inpainting
 */
export class StabilityService {
  /**
   * Prepare image and mask for Stability AI inpainting
   *
   * Uses MASK_IMAGE_WHITE approach (separate mask) which is more reliable:
   * - init_image: The source image (with transparent areas filled white)
   * - mask_image: Separate mask where WHITE = inpaint, BLACK = preserve
   *
   * Optimizations:
   * - Single pass over pixels for alpha extraction and init image preparation
   * - Uses shared dilation helper function
   */
  private async prepareImageAndMask(
    imagePath: string,
    maskPath: string
  ): Promise<{
    imageBuffer: Buffer;
    maskBuffer: Buffer;
    originalWidth: number;
    originalHeight: number;
    originalAlpha: Buffer;
    resizedWidth: number;
    resizedHeight: number;
  }> {
    // Load the original image
    const image = sharp(imagePath);
    const imageMetadata = await image.metadata();
    const { width, height } = imageMetadata;

    if (!width || !height) {
      throw new Error('Could not get image dimensions');
    }

    const originalWidth = width;
    const originalHeight = height;

    // Calculate resize dimensions
    let resizedWidth = width;
    let resizedHeight = height;

    if (width * height > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / (width * height));
      resizedWidth = Math.round(width * scale);
      resizedHeight = Math.round(height * scale);
    }

    // Ensure dimensions are multiples of 64 (required by Stable Diffusion)
    resizedWidth = Math.round(resizedWidth / 64) * 64;
    resizedHeight = Math.round(resizedHeight / 64) * 64;

    // Ensure minimum dimension
    resizedWidth = Math.max(resizedWidth, MIN_DIMENSION);
    resizedHeight = Math.max(resizedHeight, MIN_DIMENSION);

    logger.info({ originalWidth, originalHeight, resizedWidth, resizedHeight }, 'Preparing image for Stability AI inpainting');

    // Get raw RGBA data from resized image
    const { data: origRawData } = await sharp(imagePath)
      .resize(resizedWidth, resizedHeight, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixelCount = resizedWidth * resizedHeight;

    // Single pass: extract alpha AND prepare init image simultaneously
    const originalAlpha = Buffer.alloc(pixelCount);
    const initImageData = Buffer.alloc(pixelCount * 4);

    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = i * 4;
      const alpha = origRawData[srcIdx + 3];

      // Store original alpha for restoration
      originalAlpha[i] = alpha;

      // Prepare init image: fill transparent areas with white
      if (alpha < ALPHA_THRESHOLD) {
        // Transparent -> fill with white
        initImageData[srcIdx] = 255;
        initImageData[srcIdx + 1] = 255;
        initImageData[srcIdx + 2] = 255;
        initImageData[srcIdx + 3] = 255;
      } else {
        // Opaque -> keep original RGB, force opaque alpha
        initImageData[srcIdx] = origRawData[srcIdx];
        initImageData[srcIdx + 1] = origRawData[srcIdx + 1];
        initImageData[srcIdx + 2] = origRawData[srcIdx + 2];
        initImageData[srcIdx + 3] = 255;
      }
    }

    const imageBuffer = await sharp(initImageData, {
      raw: { width: resizedWidth, height: resizedHeight, channels: 4 },
    })
      .png()
      .toBuffer();

    // Prepare mask: Resize, dilate, and blur for smooth feathered edges
    // WHITE (255) = inpaint, BLACK (0) = preserve
    const rawMask = await sharp(maskPath)
      .resize(resizedWidth, resizedHeight, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    // Dilate mask to expand inpaint area for edge coverage
    const dilatedMask = dilateMask(rawMask, resizedWidth, resizedHeight, DILATION_RADIUS);

    // Apply blur to the mask for feathered edges
    const maskBuffer = await sharp(dilatedMask, {
      raw: { width: resizedWidth, height: resizedHeight, channels: 1 },
    })
      .blur(MASK_BLUR_SIGMA)
      .png()
      .toBuffer();

    return {
      imageBuffer,
      maskBuffer,
      originalWidth,
      originalHeight,
      originalAlpha,
      resizedWidth,
      resizedHeight,
    };
  }

  /**
   * Inpaint holes in an image using Stability AI's masking API
   *
   * @param imagePath - Path to the source image
   * @param maskPath - Path to the mask image (white = areas to inpaint)
   * @param outputPath - Path for the output image
   * @param options - Inpainting options
   */
  async inpaintHoles(
    imagePath: string,
    maskPath: string,
    outputPath: string,
    options: InpaintOptions = {}
  ): Promise<InpaintResult> {
    const config = getConfig();
    const apiKey = config.apis.stability;

    if (!apiKey) {
      return { success: false, error: 'Stability API key not configured (STABILITY_API_KEY)' };
    }

    const {
      prompt = 'Fill in the missing part of this object naturally, matching the surrounding texture and colors exactly',
      negativePrompt = 'text, bad anatomy, bad proportions, blurry, cropped, deformed, disfigured, duplicate, error, extra limbs, gross proportions, jpeg artifacts, long neck, low quality, lowres, malformed, morbid, mutated, mutilated, out of frame, ugly, worst quality',
      debug = false,
      cleanup = true,
    } = options;

    // Track intermediate files for cleanup
    const intermediateFiles: string[] = [];

    logger.info({
      imagePath: path.basename(imagePath),
      maskPath: path.basename(maskPath),
    }, 'Starting Stability AI inpainting (v2beta)');

    try {
      // Prepare image and mask (separate files, not embedded alpha)
      const {
        imageBuffer,
        maskBuffer,
        originalWidth,
        originalHeight,
        originalAlpha,
        resizedWidth,
        resizedHeight,
      } = await this.prepareImageAndMask(imagePath, maskPath);

      logger.debug({
        imageSize: imageBuffer.length,
        maskSize: maskBuffer.length,
        originalWidth,
        originalHeight,
        resizedWidth,
        resizedHeight,
      }, 'Prepared image and mask for inpainting');

      // Optionally save debug files for inspection
      const preparedImagePath = getVariantPath(outputPath, '_prepared');
      const preparedMaskPath = getVariantPath(outputPath, '_inpaint_mask');

      if (debug) {
        await writeFile(preparedImagePath, imageBuffer);
        await writeFile(preparedMaskPath, maskBuffer);
        logger.info({ preparedImagePath, preparedMaskPath }, 'Saved debug images for inpainting');
      }

      // Track for cleanup (even if not written, paths are used for tracking)
      intermediateFiles.push(preparedImagePath, preparedMaskPath);

      // Build multipart form data for v2beta API
      const formData = new FormData();

      // v2beta uses 'image' and 'mask' field names
      formData.append('image', new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' }), 'image.png');
      formData.append('mask', new Blob([new Uint8Array(maskBuffer)], { type: 'image/png' }), 'mask.png');

      // Prompt
      formData.append('prompt', prompt);

      if (negativePrompt) {
        formData.append('negative_prompt', negativePrompt);
      }

      // grow_mask helps smooth transitions (0-20 range)
      formData.append('grow_mask', GROW_MASK_VALUE);

      // Output format
      formData.append('output_format', 'png');

      // Make API request to v2beta endpoint
      const endpoint = `${config.apis.stabilityBase}${INPAINT_ENDPOINT}`;

      logger.info({ endpoint }, 'Calling Stability AI v2beta inpaint API');

      // Retry logic for transient failures
      let response: Response | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          logger.debug({ attempt, maxRetries: MAX_RETRIES }, 'Attempting Stability AI API call');
          response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Accept': 'image/*',
            },
            body: formData,
          });

          if (response.ok) {
            break; // Success, exit retry loop
          }

          // Check if error is retryable (5xx errors)
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            logger.warn({ status: response.status, attempt }, 'Retryable error, will retry');
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            continue;
          }

          // Non-retryable error
          const errorText = await response.text();
          logger.error({ status: response.status, error: errorText }, 'Stability AI API error');
          throw new ExternalApiError('Stability', `API error: HTTP ${response.status} - ${errorText}`);

        } catch (fetchError) {
          // Don't retry ExternalApiErrors (these are non-retryable like 4xx errors)
          if (fetchError instanceof ExternalApiError) {
            throw fetchError;
          }

          lastError = fetchError instanceof Error ? fetchError : new Error('Unknown fetch error');

          if (attempt < MAX_RETRIES) {
            logger.warn({ error: lastError.message, attempt }, 'Fetch failed, will retry');
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            continue;
          }

          // Use lastError.cause (we already validated lastError is an Error)
          logger.error({ error: lastError.message, cause: lastError.cause }, 'Stability AI fetch failed after retries');
          throw new ExternalApiError('Stability', `Fetch failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
        }
      }

      if (!response || !response.ok) {
        throw new ExternalApiError('Stability', 'Failed to get valid response after retries');
      }

      // v2beta returns binary image data directly
      const resultBuffer = Buffer.from(await response.arrayBuffer());

      // Restore original transparency
      // The result from Stability AI has white background where we filled it
      // We need to apply the original alpha mask to restore transparency
      logger.info('Restoring original transparency');

      // Get raw RGBA data from result (should be at resized dimensions)
      const { data: resultData } = await sharp(resultBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Load mask with dilation for alpha restoration (no blur - that spreads too much)
      const rawMaskForAlpha = await sharp(maskPath)
        .resize(resizedWidth, resizedHeight, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer();

      // Apply dilation to match what we sent to API (using shared helper)
      const dilatedMaskForAlpha = dilateMask(rawMaskForAlpha, resizedWidth, resizedHeight, DILATION_RADIUS);

      // Create buffer with restored alpha
      // Use dilated mask with threshold - holes become opaque, background stays transparent
      const pixelCount = resizedWidth * resizedHeight;
      const restoredData = Buffer.alloc(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        restoredData[srcIdx] = resultData[srcIdx];         // R
        restoredData[srcIdx + 1] = resultData[srcIdx + 1]; // G
        restoredData[srcIdx + 2] = resultData[srcIdx + 2]; // B

        // If in dilated mask area, make opaque; otherwise restore original alpha
        if (dilatedMaskForAlpha[i] > ALPHA_THRESHOLD) {
          restoredData[srcIdx + 3] = 255; // Filled hole -> opaque
        } else {
          restoredData[srcIdx + 3] = originalAlpha[i]; // Restore original alpha
        }
      }

      // Convert back to PNG at resized dimensions
      const restoredBuffer = await sharp(restoredData, {
        raw: { width: resizedWidth, height: resizedHeight, channels: 4 },
      })
        .png()
        .toBuffer();

      // Upscale back to original size
      let finalBuffer: Buffer;
      if (resizedWidth !== originalWidth || resizedHeight !== originalHeight) {
        logger.info({ originalWidth, originalHeight }, 'Upscaling result back to original size');
        finalBuffer = await sharp(restoredBuffer)
          .resize(originalWidth, originalHeight, { fit: 'fill' })
          .png()
          .toBuffer();
      } else {
        finalBuffer = restoredBuffer;
      }

      await writeFile(outputPath, finalBuffer);

      logger.info({
        outputPath: path.basename(outputPath),
        size: finalBuffer.length,
      }, 'Stability AI inpainting complete');

      // Cleanup intermediate files if requested
      if (cleanup) {
        for (const filePath of intermediateFiles) {
          await safeUnlink(filePath);
        }
        logger.debug({ cleaned: intermediateFiles.length }, 'Cleaned up intermediate files');
      }

      return {
        success: true,
        outputPath,
        size: finalBuffer.length,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage }, 'Stability AI inpainting failed');

      // Cleanup on failure too (unless debug mode)
      if (!debug) {
        for (const filePath of intermediateFiles) {
          await safeUnlink(filePath);
        }
      }

      return { success: false, error: errorMessage };
    }
  }
}

export const stabilityService = new StabilityService();

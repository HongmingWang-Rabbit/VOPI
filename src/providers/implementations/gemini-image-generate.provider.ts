/**
 * Gemini Image Generation Provider
 *
 * Uses Google Gemini's image generation capabilities to create
 * commercial product images directly from raw video frames.
 *
 * This replaces the traditional pipeline of:
 * bg-remove → fill-holes → center → commercial-generate
 *
 * With a single Gemini call that handles everything.
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { GoogleGenerativeAI, type GenerativeModel, type Part } from '@google/generative-ai';

import { createChildLogger } from '../../utils/logger.js';
import { getConfig } from '../../config/index.js';
import { DEFAULT_GEMINI_IMAGE_MODEL } from '../../types/config.types.js';
import { getImageMimeType, limitReferenceFrames, MAX_REFERENCE_FRAMES } from '../../utils/image-utils.js';
import {
  getImageGeneratePrompt,
  getReferenceIntro,
  getTargetIntro,
} from '../../templates/gemini-image-generate-prompts.js';
import type {
  GeminiImageGenerateProvider,
  GeminiImageGenerateResult,
  GeminiImageGenerateOptions,
  GeminiImageGenerateAllOptions,
  GeminiImageGenerateAllResult,
  GeminiImageVariant,
} from '../interfaces/gemini-image-generate.provider.js';

const logger = createChildLogger({ service: 'gemini-image-generate' });

/**
 * Gemini Image Generation Provider Implementation
 */
export class GeminiImageGenerateProviderImpl implements GeminiImageGenerateProvider {
  readonly providerId = 'gemini-image-generate';

  private client: GoogleGenerativeAI | null = null;

  /**
   * Initialize Gemini client
   */
  private init(): GoogleGenerativeAI {
    if (this.client) {
      return this.client;
    }

    const config = getConfig();
    this.client = new GoogleGenerativeAI(config.apis.googleAi);
    logger.info('Gemini image generation client initialized');

    return this.client;
  }

  /**
   * Get model instance for image generation
   *
   * @param modelName - Optional model name, defaults to DEFAULT_GEMINI_IMAGE_MODEL
   */
  private getModel(modelName?: string): GenerativeModel {
    const client = this.init();
    const model = modelName || DEFAULT_GEMINI_IMAGE_MODEL;

    return client.getGenerativeModel({
      model,
      generationConfig: {
        temperature: 1, // Recommended for image generation
        topP: 0.95,
        maxOutputTokens: 8192,
      },
    });
  }

  /**
   * Generate a single variant for an image
   */
  async generateVariant(
    imagePath: string,
    outputPath: string,
    options: GeminiImageGenerateOptions
  ): Promise<GeminiImageGenerateResult> {
    try {
      // Limit reference frames to avoid API limits
      const referenceFrames = options.referenceFramePaths
        ? limitReferenceFrames(options.referenceFramePaths, MAX_REFERENCE_FRAMES)
        : [];
      const hasReferenceFrames = referenceFrames.length > 0;

      logger.info({
        imagePath: path.basename(imagePath),
        variant: options.variant,
        hasProductContext: !!(options.productTitle || options.productDescription),
        referenceFrameCount: referenceFrames.length,
        originalReferenceCount: options.referenceFramePaths?.length ?? 0,
      }, 'Generating image variant with Gemini');

      // Build content parts
      const parts: Part[] = [];

      // Add reference frames first (if provided) for product context
      // Use different framing for white-studio (background removal) vs lifestyle (scene generation)
      let loadedReferenceCount = 0;
      if (hasReferenceFrames) {
        parts.push({
          text: getReferenceIntro(options.variant, referenceFrames.length),
        });

        for (let i = 0; i < referenceFrames.length; i++) {
          const refPath = referenceFrames[i];
          try {
            const refBuffer = await readFile(refPath);
            const refMimeType = getImageMimeType(refPath);
            parts.push({
              text: `Reference ${i + 1}:`,
            });
            parts.push({
              inlineData: {
                mimeType: refMimeType,
                data: refBuffer.toString('base64'),
              },
            });
            loadedReferenceCount++;
          } catch (err) {
            logger.warn({ refPath, error: (err as Error).message }, 'Failed to read reference frame');
          }
        }

        // Only add target intro if we loaded at least one reference
        if (loadedReferenceCount > 0) {
          parts.push({
            text: getTargetIntro(options.variant),
          });
        } else {
          logger.warn({
            imagePath: path.basename(imagePath),
            variant: options.variant,
          }, 'No reference frames loaded successfully, proceeding without reference context');
        }
      }

      // Add the target image
      const imageBuffer = await readFile(imagePath);
      const mimeType = getImageMimeType(imagePath);
      const base64Image = imageBuffer.toString('base64');

      parts.push({
        inlineData: {
          mimeType,
          data: base64Image,
        },
      });

      // Build and add prompt using templates
      // Note: Product context is provided via reference frames and is used
      // by the model to understand the product visually
      const prompt = getImageGeneratePrompt(options.variant);
      parts.push({ text: prompt });

      // Get model
      const model = this.getModel();

      // Generate content with image output
      // Note: responseModalities requires @google/generative-ai >= 0.21.0
      // The type definition may lag behind the actual SDK capability
      const generationConfig = {
        responseModalities: ['image', 'text'],
      } as Record<string, unknown>;

      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig,
      });

      const response = result.response;
      const candidates = response.candidates;

      if (!candidates || candidates.length === 0) {
        logger.warn({ imagePath, variant: options.variant }, 'No candidates in Gemini response');
        return {
          success: false,
          variant: options.variant,
          error: 'No image generated - empty response from Gemini',
        };
      }

      // Extract image from response
      const candidate = candidates[0];
      const content = candidate.content;

      if (!content || !content.parts) {
        logger.warn({ imagePath, variant: options.variant }, 'No content parts in Gemini response');
        return {
          success: false,
          variant: options.variant,
          error: 'No image generated - no content in response',
        };
      }

      // Find image part in response
      let imageData: string | null = null;
      let imageMimeType: string | null = null;

      for (const part of content.parts) {
        if ('inlineData' in part && part.inlineData) {
          imageData = part.inlineData.data;
          imageMimeType = part.inlineData.mimeType;
          break;
        }
      }

      if (!imageData) {
        logger.warn({
          imagePath,
          variant: options.variant,
          partTypes: content.parts.map(p => Object.keys(p)),
        }, 'No image data in Gemini response');
        return {
          success: false,
          variant: options.variant,
          error: 'No image generated - response did not contain image data',
        };
      }

      // Decode and save image
      const outputBuffer = Buffer.from(imageData, 'base64');
      await writeFile(outputPath, outputBuffer);

      logger.info({
        outputPath: path.basename(outputPath),
        variant: options.variant,
        size: outputBuffer.length,
        mimeType: imageMimeType,
      }, 'Image variant generated successfully');

      return {
        success: true,
        outputPath,
        size: outputBuffer.length,
        variant: options.variant,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({
        error: errorMessage,
        imagePath,
        variant: options.variant,
      }, 'Gemini image generation failed');

      return {
        success: false,
        variant: options.variant,
        error: errorMessage,
      };
    }
  }

  /**
   * Generate all variants for a single frame
   */
  async generateAllVariants(
    imagePath: string,
    outputDir: string,
    frameId: string,
    options?: GeminiImageGenerateAllOptions
  ): Promise<GeminiImageGenerateAllResult> {
    const variants: GeminiImageVariant[] = options?.variants ?? ['white-studio', 'lifestyle'];
    const results: Record<GeminiImageVariant, GeminiImageGenerateResult> = {} as Record<GeminiImageVariant, GeminiImageGenerateResult>;

    let successCount = 0;
    let errorCount = 0;

    for (const variant of variants) {
      const outputPath = path.join(outputDir, `${frameId}_${variant}.png`);

      const result = await this.generateVariant(imagePath, outputPath, {
        variant,
        productTitle: options?.productTitle,
        productDescription: options?.productDescription,
        productCategory: options?.productCategory,
        referenceFramePaths: options?.referenceFramePaths,
      });

      results[variant] = result;

      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }

    return {
      frameId,
      variants: results,
      successCount,
      errorCount,
    };
  }

  /**
   * Check if provider is available
   */
  isAvailable(): boolean {
    try {
      const config = getConfig();
      return !!config.apis.googleAi;
    } catch {
      return false;
    }
  }
}

export const geminiImageGenerateProvider = new GeminiImageGenerateProviderImpl();

/**
 * Gemini Quality Filter Provider
 *
 * Uses Gemini's vision capabilities to evaluate commercial image quality,
 * detect issues, and filter out unprofessional or duplicate images.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { GoogleGenerativeAI, type GenerativeModel, type Part } from '@google/generative-ai';

import { createChildLogger } from '../../utils/logger.js';
import { getConfig } from '../../config/index.js';
import { getImageMimeType, limitReferenceFrames, MAX_REFERENCE_FRAMES } from '../../utils/image-utils.js';
import { parseJsonResponse } from '../utils/gemini-utils.js';
import {
  BATCH_EVALUATION_PROMPT_WITH_REFS,
  BATCH_EVALUATION_PROMPT_NO_REFS,
  REFERENCE_IMAGES_INTRO,
  GENERATED_IMAGES_INTRO,
  buildEvaluationRules,
} from '../../templates/gemini-quality-filter-prompts.js';
import type {
  GeminiQualityFilterProvider,
  ImageQualityEvaluation,
  ImageQualityIssue,
  QualityFilterOptions,
  QualityFilterResult,
} from '../interfaces/gemini-quality-filter.provider.js';

const logger = createChildLogger({ service: 'gemini-quality-filter' });

/**
 * Default model for quality evaluation
 */
const DEFAULT_MODEL = 'gemini-2.0-flash';

/**
 * Default filter options
 */
const DEFAULT_OPTIONS: Required<QualityFilterOptions> = {
  minQualityScore: 60,
  maxPerAngle: Number.MAX_SAFE_INTEGER,  // No limit - AI decides based on quality
  maxTotal: Number.MAX_SAFE_INTEGER,     // No limit - AI decides based on quality
  allowHands: false,
  referenceImages: [],
};

/**
 * Response schema from Gemini
 */
interface GeminiBatchEvaluationResponse {
  evaluations: Array<{
    imageId: string;
    qualityScore: number;
    keep: boolean;
    reason: string;
    issues: Array<{
      type: string;
      severity: string;
      description: string;
    }>;
    category: string;
    angleType: string;
    backgroundType: string;
  }>;
  summary: {
    totalKept: number;
    totalFiltered: number;
    keptImages: string[];
    filterReasons: Record<string, number>;
  };
}

/**
 * Gemini Quality Filter Provider Implementation
 */
export class GeminiQualityFilterProviderImpl implements GeminiQualityFilterProvider {
  readonly providerId = 'gemini-quality-filter';

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
    logger.info('Gemini quality filter client initialized');

    return this.client;
  }

  /**
   * Get model instance
   */
  private getModel(modelName?: string): GenerativeModel {
    const client = this.init();
    const model = modelName || DEFAULT_MODEL;

    return client.getGenerativeModel({
      model,
      generationConfig: {
        temperature: 0.1, // Low temperature for consistent evaluation
        topP: 0.8,
        maxOutputTokens: 8192,
      },
    });
  }

  /**
   * Evaluate a single image
   */
  async evaluateImage(
    imagePath: string,
    _options?: Partial<QualityFilterOptions>
  ): Promise<ImageQualityEvaluation> {
    const result = await this.filterImages(
      [{ id: path.basename(imagePath, path.extname(imagePath)), path: imagePath, variant: 'unknown' }],
      _options
    );

    if (result.kept.length > 0) {
      return result.kept[0];
    }
    if (result.filtered.length > 0) {
      return result.filtered[0];
    }

    // Fallback
    return {
      imageId: path.basename(imagePath),
      imagePath,
      qualityScore: 0,
      keep: false,
      reason: 'Evaluation failed',
      issues: [],
      category: 'unknown',
      angleType: 'unknown',
      backgroundType: 'other',
    };
  }

  /**
   * Filter a batch of images
   */
  async filterImages(
    images: Array<{ id: string; path: string; variant: string }>,
    options?: QualityFilterOptions
  ): Promise<QualityFilterResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    if (images.length === 0) {
      return {
        kept: [],
        filtered: [],
        stats: {
          totalInput: 0,
          totalKept: 0,
          totalFiltered: 0,
          filterReasons: {},
        },
      };
    }

    // Limit reference images to avoid API limits
    const referenceImages = opts.referenceImages
      ? limitReferenceFrames(opts.referenceImages, MAX_REFERENCE_FRAMES)
      : [];
    const hasReferenceImages = referenceImages.length > 0;

    logger.info({
      imageCount: images.length,
      referenceImageCount: referenceImages.length,
      originalReferenceCount: opts.referenceImages?.length ?? 0,
      minQualityScore: opts.minQualityScore,
      maxTotal: opts.maxTotal,
    }, 'Filtering images with Gemini');

    try {
      // Build content with all images
      const parts: Part[] = [];

      // Add REFERENCE images first if provided (for product comparison)
      let loadedReferenceCount = 0;
      if (hasReferenceImages) {
        parts.push({
          text: REFERENCE_IMAGES_INTRO,
        });

        for (let i = 0; i < referenceImages.length; i++) {
          const refPath = referenceImages[i];
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
            logger.warn({ refPath, error: (err as Error).message }, 'Failed to read reference image');
          }
        }

        if (loadedReferenceCount > 0) {
          parts.push({
            text: GENERATED_IMAGES_INTRO,
          });
        } else {
          logger.warn({
            imageCount: images.length,
          }, 'No reference images loaded successfully, proceeding without reference comparison');
        }
      }

      // Add each generated image with its ID
      for (const image of images) {
        const imageBuffer = await readFile(image.path);
        const mimeType = getImageMimeType(image.path);

        parts.push({
          text: `\n--- Generated Image: ${image.id} (${image.variant}) ---\n`,
        });
        parts.push({
          inlineData: {
            mimeType,
            data: imageBuffer.toString('base64'),
          },
        });
      }

      // Add the appropriate prompt based on whether we have references
      const effectiveHasReferences = loadedReferenceCount > 0;
      const prompt = effectiveHasReferences ? BATCH_EVALUATION_PROMPT_WITH_REFS : BATCH_EVALUATION_PROMPT_NO_REFS;
      parts.push({ text: prompt });

      // Add evaluation rules
      parts.push({
        text: buildEvaluationRules(
          opts.minQualityScore,
          opts.allowHands,
          effectiveHasReferences,
          images.length
        ),
      });

      const model = this.getModel();
      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
      });

      const response = result.response;
      const text = response.text();

      const parsed = parseJsonResponse<GeminiBatchEvaluationResponse>(
        text,
        'quality filter response'
      );

      // Convert to our format
      const kept: ImageQualityEvaluation[] = [];
      const filtered: ImageQualityEvaluation[] = [];
      const filterReasons: Record<string, number> = {};

      for (const evaluation of parsed.evaluations) {
        const image = images.find(img => img.id === evaluation.imageId);
        const imagePath = image?.path || '';

        const eval_: ImageQualityEvaluation = {
          imageId: evaluation.imageId,
          imagePath,
          qualityScore: evaluation.qualityScore,
          keep: evaluation.keep,
          reason: evaluation.reason,
          issues: evaluation.issues.map(issue => ({
            type: issue.type as ImageQualityIssue['type'],
            severity: issue.severity as ImageQualityIssue['severity'],
            description: issue.description,
          })),
          category: evaluation.category,
          angleType: evaluation.angleType,
          backgroundType: evaluation.backgroundType as ImageQualityEvaluation['backgroundType'],
        };

        if (evaluation.keep) {
          kept.push(eval_);
        } else {
          filtered.push(eval_);
          // Count filter reasons
          for (const issue of evaluation.issues) {
            filterReasons[issue.type] = (filterReasons[issue.type] || 0) + 1;
          }
          if (evaluation.issues.length === 0) {
            filterReasons['low_quality'] = (filterReasons['low_quality'] || 0) + 1;
          }
        }
      }

      logger.info({
        totalInput: images.length,
        totalKept: kept.length,
        totalFiltered: filtered.length,
        filterReasons,
      }, 'Image filtering complete');

      return {
        kept,
        filtered,
        stats: {
          totalInput: images.length,
          totalKept: kept.length,
          totalFiltered: filtered.length,
          filterReasons,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({
        error: errorMessage,
        imageCount: images.length,
        referenceCount: referenceImages.length,
      }, 'Quality filtering failed - marking all images as evaluation_failed');

      // On error, fail closed - mark all images as filtered with evaluation_failed reason
      // This prevents potentially bad images from reaching production
      return {
        kept: [],
        filtered: images.map(img => ({
          imageId: img.id,
          imagePath: img.path,
          qualityScore: 0,
          keep: false,
          reason: `Evaluation failed: ${errorMessage}`,
          issues: [{
            type: 'low_quality' as const,
            severity: 'high' as const,
            description: `Quality evaluation API error: ${errorMessage}`,
          }],
          category: 'evaluation_failed',
          angleType: 'unknown',
          backgroundType: 'other' as const,
        })),
        stats: {
          totalInput: images.length,
          totalKept: 0,
          totalFiltered: images.length,
          filterReasons: { evaluation_failed: images.length },
        },
      };
    }
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

export const geminiQualityFilterProvider = new GeminiQualityFilterProviderImpl();

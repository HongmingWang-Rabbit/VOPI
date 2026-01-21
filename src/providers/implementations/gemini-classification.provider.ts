import { geminiService } from '../../services/gemini.service.js';
import { getConfig } from '../../config/index.js';
import type {
  ClassificationProvider,
  ClassificationFrame,
  ClassificationFrameMetadata,
  ClassificationResult,
  ClassificationOptions,
  ClassifiedFrame,
} from '../interfaces/classification.provider.js';
import type { VideoMetadata } from '../../types/job.types.js';

/**
 * Gemini Classification Provider
 *
 * Uses Google Gemini API for AI-based frame classification,
 * product detection, variant discovery, and rotation detection.
 */
export class GeminiClassificationProvider implements ClassificationProvider {
  readonly providerId = 'gemini';

  async classifyFrames(
    frames: ClassificationFrame[],
    metadata: ClassificationFrameMetadata[],
    videoMetadata: VideoMetadata,
    options: ClassificationOptions = {}
  ): Promise<ClassificationResult> {
    // Convert to the format expected by geminiService
    const scoredFrames = frames.map((f, idx) => ({
      filename: f.path.split('/').pop() || '',
      path: f.path,
      index: idx,
      timestamp: f.timestamp,
      frameId: f.frameId,
      sharpness: 0,
      motion: 0,
      score: 0,
    }));

    const geminiResult = await geminiService.classifyFrames(
      scoredFrames,
      metadata,
      videoMetadata,
      {
        model: options.model,
        maxRetries: options.maxRetries,
        retryDelay: options.retryDelay,
      }
    );

    // Get recommended frames
    const recommendedFrames = geminiService.getRecommendedFrames(geminiResult, scoredFrames);

    // Convert to provider interface format
    const classifiedFrames: ClassifiedFrame[] = recommendedFrames.map((rf) => ({
      frameId: rf.frameId,
      productId: rf.productId,
      variantId: rf.variantId,
      angleEstimate: rf.angleEstimate,
      qualityScore: rf.geminiScore,
      rotationAngleDeg: rf.rotationAngleDeg,
      obstructions: rf.obstructions,
      backgroundRecommendations: rf.backgroundRecommendations,
      variantDescription: rf.variantDescription,
      allFrameIds: rf.allFrameIds,
    }));

    const products = geminiResult.products_detected?.map((p) => ({
      productId: p.product_id,
      description: p.description,
      category: p.product_category,
    })) || [];

    return {
      products,
      classifiedFrames,
      rawResponse: geminiResult,
    };
  }

  isAvailable(): boolean {
    try {
      const config = getConfig();
      return !!config.apis.googleAi;
    } catch {
      return false;
    }
  }
}

export const geminiClassificationProvider = new GeminiClassificationProvider();

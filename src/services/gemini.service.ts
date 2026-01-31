import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { readFile } from 'fs/promises';

import { createChildLogger } from '../utils/logger.js';
import { ExternalApiError } from '../utils/errors.js';
import type { TokenUsageTracker } from '../utils/token-usage.js';
import { getConfig } from '../config/index.js';
import { GEMINI_SYSTEM_PROMPT } from '../templates/gemini-system-prompt.js';
import { GEMINI_OUTPUT_SCHEMA } from '../templates/gemini-output-schema.js';
import type { ScoredFrame } from './frame-scoring.service.js';
import type {
  VideoMetadata,
  FrameObstructions,
  BackgroundRecommendations,
} from '../types/job.types.js';

const logger = createChildLogger({ service: 'gemini' });

/**
 * Transcript context for enhanced frame classification
 * When audio analysis has been performed, this context helps Gemini
 * make smarter frame selections based on what the seller describes.
 */
export interface TranscriptContext {
  /** Raw transcript from audio */
  transcript: string;
  /** Product metadata extracted from audio */
  productMetadata?: {
    title?: string;
    category?: string;
    materials?: string[];
    color?: string;
    bulletPoints?: string[];
  };
  /** Key features mentioned in audio to prioritize in frame selection */
  keyFeatures?: string[];
}

/**
 * Gemini response schema for variant-based classification
 */
export interface GeminiResponse {
  video?: {
    filename: string;
    duration_sec: number;
  };
  products_detected?: Array<{
    product_id: string;
    description: string;
    product_category?: string;
  }>;
  frame_evaluation: Array<{
    frame_id: string;
    timestamp_sec: number;
    product_id: string;
    variant_id: string;
    angle_estimate: string;
    quality_score_0_100: number;
    similarity_note: string;
    rotation_angle_deg?: number;
    obstructions: FrameObstructions;
  }>;
  variants_discovered?: Array<{
    product_id: string;
    variant_id: string;
    angle_estimate: string;
    description: string;
    best_frame_id: string;
    best_frame_score: number;
    rotation_angle_deg?: number;
    all_frame_ids: string[];
    obstructions: FrameObstructions;
    background_recommendations: BackgroundRecommendations;
  }>;
}

/**
 * Recommended frame with Gemini classification
 */
export interface RecommendedFrame extends ScoredFrame {
  productId: string;
  variantId: string;
  angleEstimate: string;
  recommendedType: string;
  variantDescription?: string;
  geminiScore: number;
  rotationAngleDeg: number;
  allFrameIds: string[];
  obstructions: FrameObstructions;
  backgroundRecommendations: BackgroundRecommendations;
}


/**
 * GeminiService - Gemini API wrapper for frame classification
 * Ported from smartFrameExtractor/gemini.js
 */
export class GeminiService {
  private client: GoogleGenerativeAI | null = null;

  /**
   * Initialize Gemini client
   */
  init(): GoogleGenerativeAI {
    if (this.client) {
      return this.client;
    }

    const config = getConfig();
    this.client = new GoogleGenerativeAI(config.apis.googleAi);
    logger.info('Gemini client initialized');
    return this.client;
  }

  /**
   * Get model instance
   */
  private getModel(modelName?: string): GenerativeModel {
    // Default model - should be passed from effectiveConfig by processor
    const model = modelName || 'gemini-3-flash-preview';
    const client = this.init();
    return client.getGenerativeModel({
      model,
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 16384,
      },
    });
  }

  /**
   * Encode image as base64 for Gemini
   */
  private async encodeImage(imagePath: string): Promise<{
    inlineData: { data: string; mimeType: string };
  }> {
    const imageData = await readFile(imagePath);
    const base64 = imageData.toString('base64');

    // Detect MIME type from file extension
    const ext = imagePath.toLowerCase().split('.').pop();
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const mimeType = mimeTypes[ext || ''] || 'image/png';

    return {
      inlineData: {
        data: base64,
        mimeType,
      },
    };
  }

  /**
   * Build prompt with frame metadata
   */
  private buildPrompt(
    candidateMetadata: Array<{
      frame_id: string;
      timestamp_sec: number;
      sequence_position: number;
      total_candidates: number;
    }>,
    videoMetadata: VideoMetadata,
    transcriptContext?: TranscriptContext
  ): string {
    const metadataStr = JSON.stringify(candidateMetadata, null, 2);

    let prompt = `## Video Information
Filename: ${videoMetadata.filename}
Duration: ${videoMetadata.duration.toFixed(2)} seconds
Resolution: ${videoMetadata.width}x${videoMetadata.height}`;

    // Add transcript context if available
    if (transcriptContext?.transcript) {
      prompt += `

## Audio Context from Seller
The seller describes this product in the video. Use this information to better understand what features to look for and prioritize.

**Transcript Summary:**
${transcriptContext.transcript.slice(0, 2000)}${transcriptContext.transcript.length > 2000 ? '...' : ''}`;

      if (transcriptContext.productMetadata?.title) {
        prompt += `

**Product identified from audio:**
- Title: ${transcriptContext.productMetadata.title}`;
        if (transcriptContext.productMetadata.category) {
          prompt += `
- Category: ${transcriptContext.productMetadata.category}`;
        }
        if (transcriptContext.productMetadata.materials?.length) {
          prompt += `
- Materials: ${transcriptContext.productMetadata.materials.join(', ')}`;
        }
        if (transcriptContext.productMetadata.color) {
          prompt += `
- Color: ${transcriptContext.productMetadata.color}`;
        }
        if (transcriptContext.keyFeatures?.length) {
          prompt += `
- Key features to show: ${transcriptContext.keyFeatures.join(', ')}`;
        }
      }

      prompt += `

**Selection guidance from audio:**
- Prioritize frames that clearly show features mentioned in the transcript
- Look for views that demonstrate key selling points
- Consider the product category when evaluating angles`;
    }

    prompt += `

## Candidate Frames
The following ${candidateMetadata.length} frames have been pre-selected as the sharpest, most stable moments in the video.

Frame metadata:
${metadataStr}

## Your Task
1. Analyze each frame image provided
2. For each frame, determine its quality and suitable labels
3. Recommend the best frame for each shot type
4. Assess overall video quality

## Required Output Schema
${GEMINI_OUTPUT_SCHEMA}

Return ONLY the JSON object. No additional text.`;

    return prompt;
  }

  /**
   * Parse and validate Gemini response
   */
  private parseResponse(text: string): GeminiResponse {
    let cleaned = text.trim();

    // Remove markdown code blocks if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    let parsed: GeminiResponse;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new ExternalApiError(
        'Gemini',
        `Failed to parse response as JSON: ${(e as Error).message}`
      );
    }

    if (!parsed.frame_evaluation || !Array.isArray(parsed.frame_evaluation)) {
      throw new ExternalApiError('Gemini', 'Response missing frame_evaluation array');
    }

    const variantCount = parsed.variants_discovered?.length || 0;
    const frameCount = parsed.frame_evaluation?.length || 0;
    logger.info({ frameCount, variantCount }, 'Gemini response parsed');

    return parsed;
  }

  /**
   * Classify frames using Gemini
   *
   * @param candidates - Pre-scored candidate frames
   * @param candidateMetadata - Metadata for each candidate
   * @param videoMetadata - Video file metadata
   * @param options - Classification options
   * @param transcriptContext - Optional transcript context from audio analysis
   */
  async classifyFrames(
    candidates: ScoredFrame[],
    candidateMetadata: Array<{
      frame_id: string;
      timestamp_sec: number;
      sequence_position: number;
      total_candidates: number;
    }>,
    videoMetadata: VideoMetadata,
    options: { model?: string; maxRetries?: number; retryDelay?: number } = {},
    transcriptContext?: TranscriptContext,
    tokenUsage?: TokenUsageTracker
  ): Promise<GeminiResponse> {
    const config = getConfig();
    const {
      model = 'gemini-3-flash-preview',
      maxRetries = 3,
      retryDelay = config.worker.apiRetryDelayMs,
    } = options;

    const hasTranscript = !!transcriptContext?.transcript;
    logger.info({ count: candidates.length, model, hasTranscript }, 'Classifying frames with Gemini');

    const geminiModel = this.getModel(model);

    // Encode all images
    const imageParts = await Promise.all(candidates.map((c) => this.encodeImage(c.path)));

    const prompt = this.buildPrompt(candidateMetadata, videoMetadata, transcriptContext);

    // Build content
    const content = [
      { text: GEMINI_SYSTEM_PROMPT },
      { text: '\n\n## Candidate Frame Images\n\nImages are provided in order:\n\n' },
      ...imageParts.flatMap((img, idx) => [
        { text: `\n--- Frame ${idx + 1} (${candidateMetadata[idx].frame_id}) ---\n` },
        img,
      ]),
      { text: '\n\n' + prompt },
    ];

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info({ attempt, maxRetries }, 'Gemini classification attempt');

        const result = await geminiModel.generateContent(content);
        const response = await result.response;
        const text = response.text();

        if (tokenUsage) {
          try {
            if (response.usageMetadata) {
              tokenUsage.record(
                model,
                'gemini-classify',
                response.usageMetadata.promptTokenCount ?? 0,
                response.usageMetadata.candidatesTokenCount ?? 0,
              );
            } else {
              logger.warn({ model }, 'Gemini response missing usageMetadata - token usage not tracked');
            }
          } catch (err) {
            logger.error({ err, model }, 'Failed to record token usage');
          }
        }

        return this.parseResponse(text);
      } catch (e) {
        lastError = e as Error;
        logger.error({
          attempt,
          errorMessage: lastError.message,
          errorName: lastError.name,
          errorStack: lastError.stack?.split('\n').slice(0, 3).join('\n'),
        }, 'Gemini classification attempt failed');

        if (attempt < maxRetries) {
          logger.info({ delay: retryDelay }, 'Retrying Gemini classification');
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }

    throw new ExternalApiError(
      'Gemini',
      `Classification failed after ${maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Extract recommended frames from Gemini response
   */
  getRecommendedFrames(geminiResult: GeminiResponse, candidates: ScoredFrame[]): RecommendedFrame[] {
    const recommended: RecommendedFrame[] = [];
    const candidateMap = new Map(candidates.map((c) => [c.frameId, c]));

    // Build frame evaluation map
    const frameData = new Map<
      string,
      {
        score: number;
        variantId: string;
        angleEstimate: string;
        rotationAngleDeg: number;
        obstructions: FrameObstructions;
        similarityNote: string;
      }
    >();

    for (const evalItem of geminiResult.frame_evaluation) {
      frameData.set(evalItem.frame_id, {
        score: evalItem.quality_score_0_100 || 50,
        variantId: evalItem.variant_id,
        angleEstimate: evalItem.angle_estimate,
        rotationAngleDeg: evalItem.rotation_angle_deg ?? 0,
        obstructions: evalItem.obstructions || {
          has_obstruction: false,
          obstruction_types: [],
          obstruction_description: null,
          removable_by_ai: true,
        },
        similarityNote: evalItem.similarity_note,
      });
    }

    const variants = geminiResult.variants_discovered || [];

    if (variants.length > 0) {
      for (const variant of variants) {
        const productId = variant.product_id || 'product_1';
        const variantId = variant.variant_id;
        const frameId = variant.best_frame_id;

        if (!frameId) {
          logger.warn({ productId, variantId }, 'No frame selected for variant');
          continue;
        }

        const candidate = candidateMap.get(frameId);
        if (candidate) {
          const evalData = frameData.get(frameId);

          recommended.push({
            ...candidate,
            productId,
            variantId,
            angleEstimate: variant.angle_estimate || evalData?.angleEstimate || 'unknown',
            recommendedType: `${productId}_${variantId}`,
            variantDescription: variant.description,
            geminiScore: variant.best_frame_score || evalData?.score || 50,
            rotationAngleDeg: variant.rotation_angle_deg ?? evalData?.rotationAngleDeg ?? 0,
            allFrameIds: variant.all_frame_ids || [frameId],
            obstructions: variant.obstructions ||
              evalData?.obstructions || {
                has_obstruction: false,
                obstruction_types: [],
                obstruction_description: null,
                removable_by_ai: true,
              },
            backgroundRecommendations: variant.background_recommendations || {
              solid_color: '#FFFFFF',
              solid_color_name: 'white',
              real_life_setting: 'on a clean white surface with soft lighting',
              creative_shot: 'floating with soft shadow on gradient background',
            },
          });

          logger.debug(
            { productId, variantId, angleEstimate: variant.angle_estimate },
            'Variant recommended'
          );
        } else {
          logger.warn({ frameId }, 'Frame not found in candidates');
        }
      }
    } else {
      // Fallback: group by variant_id from frame_evaluation
      const variantBest = new Map<string, { frameId: string; score: number }>();

      for (const [frameId, data] of frameData) {
        const key = data.variantId;
        const existing = variantBest.get(key);

        if (!existing || data.score > existing.score) {
          variantBest.set(key, { frameId, score: data.score });
        }
      }

      for (const [variantId, data] of variantBest) {
        const candidate = candidateMap.get(data.frameId);
        const evalData = frameData.get(data.frameId);
        if (candidate && evalData) {
          recommended.push({
            ...candidate,
            productId: 'product_1',
            variantId,
            angleEstimate: evalData.angleEstimate || 'unknown',
            recommendedType: `product_1_${variantId}`,
            geminiScore: data.score,
            rotationAngleDeg: evalData.rotationAngleDeg ?? 0,
            allFrameIds: [data.frameId],
            obstructions: evalData.obstructions,
            backgroundRecommendations: {
              solid_color: '#FFFFFF',
              solid_color_name: 'white',
              real_life_setting: 'on a clean white surface with soft lighting',
              creative_shot: 'floating with soft shadow on gradient background',
            },
          });
        }
      }
    }

    const products = [...new Set(recommended.map((r) => r.productId))];
    const withObstructions = recommended.filter((r) => r.obstructions?.has_obstruction).length;
    logger.info(
      { variants: recommended.length, products: products.length, withObstructions },
      'Recommended frames extracted'
    );

    return recommended;
  }
}

export const geminiService = new GeminiService();

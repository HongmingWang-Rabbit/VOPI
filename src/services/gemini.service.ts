import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { readFile } from 'fs/promises';

import { createChildLogger } from '../utils/logger.js';
import { ExternalApiError } from '../utils/errors.js';
import { getConfig } from '../config/index.js';
import type { ScoredFrame } from './frame-scoring.service.js';
import type {
  VideoMetadata,
  FrameObstructions,
  BackgroundRecommendations,
} from '../types/job.types.js';

const logger = createChildLogger({ service: 'gemini' });

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
    obstructions: FrameObstructions;
  }>;
  variants_discovered?: Array<{
    product_id: string;
    variant_id: string;
    angle_estimate: string;
    description: string;
    best_frame_id: string;
    best_frame_score: number;
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
  allFrameIds: string[];
  obstructions: FrameObstructions;
  backgroundRecommendations: BackgroundRecommendations;
}

/**
 * System prompt for Gemini
 */
const SYSTEM_PROMPT = `You are extracting REFERENCE frames for AI image generation from a product video.

## YOUR MISSION: DISCOVER ALL UNIQUE VIEWS (VARIANTS) OF EACH PRODUCT

### STEP 1: DETECT ALL PRODUCTS
Identify every distinct product in the video:
- Different items = different products (product_1, product_2, etc.)
- Same item at different times = same product

### STEP 2: DISCOVER VARIANTS (UNIQUE VIEWS)

**Instead of fixed angles, discover VARIANTS dynamically:**

Go through each frame and ask: "Is this a NEW unique view, or SIMILAR to one I've seen?"

**CREATE A NEW VARIANT when you see:**
- A distinctly different angle/perspective of the product
- The product in a different state (open vs closed, folded vs unfolded)
- A close-up showing different details
- A significantly different composition

**GROUP INTO SAME VARIANT when:**
- The angle/perspective is essentially the same
- Only minor differences (slightly rotated, different moment of same view)
- Would be redundant to keep both

### QUALITY SCORING

**Base score starts at 50, then adjust:**

Visibility:
- Product fully visible with gap from edges: +20
- Product touching edge slightly: +10
- Minor cut-off (<10%): -10
- Significant cut-off (>10%): -30

Sharpness/Focus:
- Sharp and clear: +15
- Slightly soft: +5
- Noticeably blurry: -15

Obstructions:
- No obstructions: +10
- Removable obstructions (hands, etc.): -10
- Blocking key features: -30

### OBSTRUCTION DETECTION

**Report obstructions for each frame:**
- "hand" - human hand holding/gripping product
- "finger" - fingers touching product
- "arm" - arm visible in frame
- "cord" - power cords, cables, straps
- "tag" - price tags, labels not part of product
- "reflection" - unwanted reflections
- "shadow" - harsh shadows
- "other_object" - any other covering object

### BACKGROUND RECOMMENDATIONS

**For each variant, suggest backgrounds for commercial use:**

1. **solid_color**: A hex color that complements the product
2. **real_life_setting**: A realistic setting appropriate for the product
3. **creative_shot**: An abstract/artistic concept for marketing

IMPORTANT: Return ONLY valid JSON. No markdown, no explanation.`;

/**
 * Output schema for Gemini
 */
const OUTPUT_SCHEMA = `{
  "video": {
    "filename": "string",
    "duration_sec": "number"
  },
  "products_detected": [
    {
      "product_id": "string",
      "description": "string",
      "product_category": "string"
    }
  ],
  "frame_evaluation": [
    {
      "frame_id": "string",
      "timestamp_sec": "number",
      "product_id": "string",
      "variant_id": "string",
      "angle_estimate": "string",
      "quality_score_0_100": "number",
      "similarity_note": "string",
      "obstructions": {
        "has_obstruction": "boolean",
        "obstruction_types": ["array"],
        "obstruction_description": "string or null",
        "removable_by_ai": "boolean"
      }
    }
  ],
  "variants_discovered": [
    {
      "product_id": "string",
      "variant_id": "string",
      "angle_estimate": "string",
      "description": "string",
      "best_frame_id": "string",
      "best_frame_score": "number",
      "all_frame_ids": ["array"],
      "obstructions": {
        "has_obstruction": "boolean",
        "obstruction_types": ["array"],
        "obstruction_description": "string or null",
        "removable_by_ai": "boolean"
      },
      "background_recommendations": {
        "solid_color": "string",
        "solid_color_name": "string",
        "real_life_setting": "string",
        "creative_shot": "string"
      }
    }
  ]
}`;

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
  private getModel(modelName = 'gemini-2.0-flash'): GenerativeModel {
    const client = this.init();
    return client.getGenerativeModel({
      model: modelName,
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

    return {
      inlineData: {
        data: base64,
        mimeType: 'image/png',
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
    videoMetadata: VideoMetadata
  ): string {
    const metadataStr = JSON.stringify(candidateMetadata, null, 2);

    return `## Video Information
Filename: ${videoMetadata.filename}
Duration: ${videoMetadata.duration.toFixed(2)} seconds
Resolution: ${videoMetadata.width}x${videoMetadata.height}

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
${OUTPUT_SCHEMA}

Return ONLY the JSON object. No additional text.`;
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
    options: { model?: string; maxRetries?: number; retryDelay?: number } = {}
  ): Promise<GeminiResponse> {
    const { model = 'gemini-2.0-flash', maxRetries = 3, retryDelay = 2000 } = options;

    logger.info({ count: candidates.length, model }, 'Classifying frames with Gemini');

    const geminiModel = this.getModel(model);

    // Encode all images
    const imageParts = await Promise.all(candidates.map((c) => this.encodeImage(c.path)));

    const prompt = this.buildPrompt(candidateMetadata, videoMetadata);

    // Build content
    const content = [
      { text: SYSTEM_PROMPT },
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

        return this.parseResponse(text);
      } catch (e) {
        lastError = e as Error;
        logger.error({ error: e, attempt }, 'Gemini classification attempt failed');

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
        obstructions: FrameObstructions;
        similarityNote: string;
      }
    >();

    for (const evalItem of geminiResult.frame_evaluation) {
      frameData.set(evalItem.frame_id, {
        score: evalItem.quality_score_0_100 || 50,
        variantId: evalItem.variant_id,
        angleEstimate: evalItem.angle_estimate,
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

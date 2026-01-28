/**
 * Gemini Unified Video Analyzer Provider
 *
 * Uses Google Gemini's ability to process both audio and visual streams
 * simultaneously to analyze videos in a single API call.
 *
 * This combines the functionality of:
 * - extract-audio
 * - gemini-audio-analysis
 * - gemini-video-analysis (frame selection)
 *
 * Benefits:
 * - Single API call instead of multiple
 * - Cross-modal context (audio informs frame selection)
 * - More efficient (video uploaded once)
 */

import path from 'path';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { GoogleAIFileManager, FileState, type FileMetadataResponse } from '@google/generative-ai/server';
import { createChildLogger } from '../../utils/logger.js';
import { ExternalApiError } from '../../utils/errors.js';
import { getConfig } from '../../config/index.js';
import type {
  UnifiedVideoAnalyzerProvider,
  UnifiedVideoAnalysisResult,
  UnifiedAnalysisFrame,
  UnifiedVideoAnalysisOptions,
  UnifiedAudioAnalysis,
} from '../interfaces/unified-video-analyzer.provider.js';
import type { ProductMetadata } from '../../types/product-metadata.types.js';
import {
  GEMINI_UNIFIED_VIDEO_SYSTEM_PROMPT,
  buildUnifiedVideoPrompt,
} from '../../templates/gemini-unified-video-prompt.js';
import {
  DEFAULT_PROCESSING_TIMEOUT_MS,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_MAX_BULLET_POINTS,
  DEFAULT_MAX_FRAMES,
  getVideoMimeType,
  validateCondition,
  validateDimensionUnit,
  validateWeightUnit,
  prepareVideoForGemini,
  parseJsonResponse,
  extractFileNameFromUri,
} from '../utils/gemini-utils.js';

const logger = createChildLogger({ service: 'gemini-unified-video' });

/**
 * Gemini unified video analysis response schema
 */
interface GeminiUnifiedVideoResponse {
  products_detected: Array<{
    product_id: string;
    description: string;
    product_category?: string;
    mentioned_in_audio?: boolean;
  }>;
  selected_frames: Array<{
    timestamp_sec: number;
    selection_reason: string;
    product_id: string;
    variant_id: string;
    angle_estimate: string;
    quality_score_0_100: number;
    rotation_angle_deg?: number;
    variant_description?: string;
    audio_mention_timestamp?: number;
    obstructions: {
      has_obstruction: boolean;
      obstruction_types: string[];
      obstruction_description: string | null;
      removable_by_ai: boolean;
    };
    background_recommendations: {
      solid_color: string;
      solid_color_name: string;
      real_life_setting: string;
      creative_shot: string;
    };
  }>;
  video_duration_sec: number;
  frames_analyzed: number;
  audio_analysis: {
    has_audio: boolean;
    transcript: string;
    language: string;
    audio_quality_0_100: number;
    product?: {
      title: string;
      description: string;
      short_description?: string;
      bullet_points?: string[];
      brand?: string;
      category?: string;
      subcategory?: string;
      materials?: string[];
      color?: string;
      colors?: string[];
      size?: string;
      sizes?: string[];
      price?: {
        value: number;
        currency: string;
      };
      keywords?: string[];
      tags?: string[];
      condition?: string;
      dimensions?: {
        length?: number;
        width?: number;
        height?: number;
        unit?: string;
      };
      weight?: {
        value?: number;
        unit?: string;
      };
      care_instructions?: string[];
      warnings?: string[];
      gender?: string;
      target_audience?: string;
      age_group?: string;
      style?: string;
      model_number?: string;
    };
    confidence?: {
      overall: number;
      title: number;
      description: number;
      price?: number;
      attributes?: number;
    };
    relevant_excerpts?: string[];
  };
}

/**
 * Helper to extract error message from FileMetadataResponse
 */
function getFileErrorMessage(file: FileMetadataResponse): string | undefined {
  return file.error?.message;
}

export class GeminiUnifiedVideoAnalyzerProvider implements UnifiedVideoAnalyzerProvider {
  readonly providerId = 'gemini-unified-video';

  private client: GoogleGenerativeAI | null = null;
  private fileManager: GoogleAIFileManager | null = null;

  /**
   * Initialize Gemini client
   */
  private init(): { client: GoogleGenerativeAI; fileManager: GoogleAIFileManager } {
    if (this.client && this.fileManager) {
      return { client: this.client, fileManager: this.fileManager };
    }

    const config = getConfig();
    this.client = new GoogleGenerativeAI(config.apis.googleAi);
    this.fileManager = new GoogleAIFileManager(config.apis.googleAi);
    logger.info('Gemini unified video client initialized');

    return { client: this.client, fileManager: this.fileManager };
  }

  /**
   * Get model instance for video analysis
   */
  private getModel(options: {
    modelName?: string;
    temperature?: number;
    topP?: number;
  } = {}): GenerativeModel {
    // Default model - should be passed from effectiveConfig by processor
    const model = options.modelName || 'gemini-3-flash-preview';
    const { client } = this.init();

    return client.getGenerativeModel({
      model,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        topP: options.topP ?? 0.8,
        maxOutputTokens: 32768, // Larger for combined audio + video response
      },
    });
  }

  /**
   * Upload video to Gemini Files API
   */
  async uploadVideo(videoPath: string): Promise<string> {
    const { fileManager } = this.init();
    const config = getConfig();

    const processingTimeoutMs = config.audio?.processingTimeoutMs || DEFAULT_PROCESSING_TIMEOUT_MS;
    const pollingIntervalMs = config.audio?.pollingIntervalMs || DEFAULT_POLLING_INTERVAL_MS;

    logger.info({ videoPath }, 'Uploading video to Gemini Files API');

    const uploadResult = await fileManager.uploadFile(videoPath, {
      mimeType: getVideoMimeType(videoPath),
      displayName: path.basename(videoPath) || 'video',
    });

    const fileUri = uploadResult.file.uri;
    logger.info({ fileUri, state: uploadResult.file.state }, 'Video uploaded');

    // Wait for processing to complete
    let file = uploadResult.file;
    let elapsedMs = 0;
    const maxAttempts = Math.ceil(processingTimeoutMs / pollingIntervalMs);

    for (let attempts = 0; file.state === FileState.PROCESSING && attempts < maxAttempts; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs));
      elapsedMs += pollingIntervalMs;
      file = await fileManager.getFile(file.name);
      logger.debug({ state: file.state, attempts: attempts + 1, elapsedMs }, 'Waiting for video processing');
    }

    if (file.state === FileState.FAILED) {
      const errorMessage = getFileErrorMessage(file);
      logger.error(
        {
          fileName: file.name,
          displayName: file.displayName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          state: file.state,
          error: file.error,
        },
        'Gemini video processing failed'
      );
      throw new ExternalApiError(
        'Gemini',
        `Video processing failed${errorMessage ? `: ${errorMessage}` : ''}`
      );
    }

    if (file.state !== FileState.ACTIVE) {
      const elapsedSeconds = elapsedMs / 1000;
      throw new ExternalApiError(
        'Gemini',
        `Video processing timeout after ${elapsedSeconds} seconds`
      );
    }

    logger.info({ fileUri, state: file.state }, 'Video processing complete');
    return fileUri;
  }

  /**
   * Delete uploaded video
   */
  async deleteVideo(videoUri: string): Promise<void> {
    const { fileManager } = this.init();

    const fileName = extractFileNameFromUri(videoUri);
    if (!fileName) {
      logger.warn({ videoUri }, 'Could not extract file name from URI');
      return;
    }

    try {
      await fileManager.deleteFile(fileName);
      logger.info({ fileName }, 'Video deleted from Gemini Files API');
    } catch (error) {
      logger.warn({ error, fileName }, 'Failed to delete video from Gemini Files API');
    }
  }

  /**
   * Analyze video with combined audio + visual analysis
   */
  async analyzeVideo(
    videoPath: string,
    options: UnifiedVideoAnalysisOptions = {}
  ): Promise<UnifiedVideoAnalysisResult> {
    const config = getConfig();
    const {
      model = 'gemini-3-flash-preview',
      maxFrames = DEFAULT_MAX_FRAMES,
      maxRetries = 3,
      retryDelay = config.worker.apiRetryDelayMs,
      temperature,
      topP,
      maxBulletPoints = DEFAULT_MAX_BULLET_POINTS,
      focusAreas = [],
      skipAudioAnalysis = false,
    } = options;

    logger.info({
      videoPath,
      model,
      maxFrames,
      maxBulletPoints,
      skipAudioAnalysis,
    }, 'Analyzing video with Gemini unified analyzer');

    // Prepare video (check codec and transcode if needed)
    const { effectivePath, cleanup } = await prepareVideoForGemini(
      videoPath,
      'gemini_unified_transcode'
    );

    // Upload video
    const fileUri = await this.uploadVideo(effectivePath);

    try {
      const geminiModel = this.getModel({ modelName: model, temperature, topP });

      const prompt = buildUnifiedVideoPrompt({
        maxFrames,
        maxBulletPoints,
        focusAreas,
        skipAudioAnalysis,
      });

      // Build content with video file reference
      const content = [
        {
          fileData: {
            mimeType: getVideoMimeType(effectivePath),
            fileUri,
          },
        },
        { text: GEMINI_UNIFIED_VIDEO_SYSTEM_PROMPT },
        { text: prompt },
      ];

      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          logger.info({ attempt, maxRetries }, 'Gemini unified video analysis attempt');

          const result = await geminiModel.generateContent(content);
          const response = await result.response;
          const text = response.text();

          const parsed = this.parseResponse(text);
          return this.convertToResult(parsed);
        } catch (e) {
          lastError = e as Error;
          logger.error({
            attempt,
            errorMessage: lastError.message,
            errorName: lastError.name,
            errorStack: lastError.stack?.split('\n').slice(0, 3).join('\n'),
          }, 'Gemini unified video analysis attempt failed');

          if (attempt < maxRetries) {
            logger.info({ delay: retryDelay }, 'Retrying unified video analysis');
            await new Promise((r) => setTimeout(r, retryDelay));
          }
        }
      }

      throw new ExternalApiError(
        'Gemini',
        `Unified video analysis failed after ${maxRetries} attempts: ${lastError?.message}`
      );
    } finally {
      // Cleanup: delete uploaded video from Gemini
      await this.deleteVideo(fileUri);

      // Cleanup: delete transcoded file if created
      await cleanup();
    }
  }

  /**
   * Parse Gemini response
   */
  private parseResponse(text: string): GeminiUnifiedVideoResponse {
    const parsed = parseJsonResponse<GeminiUnifiedVideoResponse>(
      text,
      'unified video analysis response'
    );

    if (!parsed.selected_frames || !Array.isArray(parsed.selected_frames)) {
      throw new ExternalApiError('Gemini', 'Response missing selected_frames array');
    }

    if (!parsed.audio_analysis) {
      throw new ExternalApiError('Gemini', 'Response missing audio_analysis object');
    }

    logger.info(
      {
        products: parsed.products_detected?.length || 0,
        frames: parsed.selected_frames.length,
        duration: parsed.video_duration_sec,
        hasAudio: parsed.audio_analysis.has_audio,
        audioQuality: parsed.audio_analysis.audio_quality_0_100,
        transcriptLength: parsed.audio_analysis.transcript?.length || 0,
      },
      'Unified video analysis response parsed'
    );

    return parsed;
  }

  /**
   * Convert Gemini response to provider interface format
   */
  private convertToResult(response: GeminiUnifiedVideoResponse): UnifiedVideoAnalysisResult {
    const products = response.products_detected?.map((p) => ({
      productId: p.product_id,
      description: p.description,
      category: p.product_category,
      mentionedInAudio: p.mentioned_in_audio,
    })) || [];

    const selectedFrames: UnifiedAnalysisFrame[] = response.selected_frames.map((frame) => ({
      timestamp: frame.timestamp_sec,
      selectionReason: frame.selection_reason,
      productId: frame.product_id,
      variantId: frame.variant_id,
      angleEstimate: frame.angle_estimate,
      qualityScore: frame.quality_score_0_100,
      rotationAngleDeg: frame.rotation_angle_deg ?? 0,
      variantDescription: frame.variant_description,
      audioMentionTimestamp: frame.audio_mention_timestamp,
      obstructions: frame.obstructions || {
        has_obstruction: false,
        obstruction_types: [],
        obstruction_description: null,
        removable_by_ai: true,
      },
      backgroundRecommendations: frame.background_recommendations || {
        solid_color: '#FFFFFF',
        solid_color_name: 'white',
        real_life_setting: 'on a clean white surface with soft lighting',
        creative_shot: 'floating with soft shadow on gradient background',
      },
    }));

    // Convert audio analysis
    const audioAnalysis = this.convertAudioAnalysis(response.audio_analysis);

    return {
      products,
      selectedFrames,
      videoDuration: response.video_duration_sec,
      framesAnalyzed: response.frames_analyzed,
      audioAnalysis,
      rawResponse: response,
    };
  }

  /**
   * Convert audio analysis from response to interface format
   */
  private convertAudioAnalysis(
    audio: GeminiUnifiedVideoResponse['audio_analysis']
  ): UnifiedAudioAnalysis {
    const result: UnifiedAudioAnalysis = {
      transcript: audio.transcript || '',
      language: audio.language || 'en',
      audioQuality: audio.audio_quality_0_100 || 0,
      hasAudio: audio.has_audio,
    };

    if (audio.has_audio && audio.product) {
      const p = audio.product;

      // Build ProductMetadata with validated types
      const productMetadata: ProductMetadata = {
        title: p.title,
        description: p.description,
        shortDescription: p.short_description,
        bulletPoints: p.bullet_points || [],
        brand: p.brand,
        category: p.category,
        subcategory: p.subcategory,
        materials: p.materials,
        color: p.color,
        colors: p.colors,
        size: p.size,
        sizes: p.sizes,
        keywords: p.keywords,
        tags: p.tags,
        condition: validateCondition(p.condition),
        careInstructions: p.care_instructions,
        warnings: p.warnings,
        extractedFromAudio: true,
        transcriptExcerpts: audio.relevant_excerpts,
        confidence: audio.confidence ? {
          overall: audio.confidence.overall,
          title: audio.confidence.title,
          description: audio.confidence.description,
          price: audio.confidence.price,
          attributes: audio.confidence.attributes,
        } : {
          overall: 50,
          title: 50,
          description: 50,
        },
      };

      // Add price if present
      if (p.price?.value) {
        productMetadata.price = p.price.value;
        productMetadata.currency = p.price.currency || 'USD';
      }

      // Add dimensions if present (with validated unit)
      if (p.dimensions && (p.dimensions.length || p.dimensions.width || p.dimensions.height)) {
        productMetadata.dimensions = {
          length: p.dimensions.length,
          width: p.dimensions.width,
          height: p.dimensions.height,
          unit: validateDimensionUnit(p.dimensions.unit),
        };
      }

      // Add weight if present (with validated unit)
      if (p.weight?.value) {
        productMetadata.weight = {
          value: p.weight.value,
          unit: validateWeightUnit(p.weight.unit),
        };
      }

      // Add demographics and style fields
      if (p.gender) productMetadata.gender = p.gender;
      if (p.target_audience) productMetadata.targetAudience = p.target_audience;
      if (p.age_group) productMetadata.ageGroup = p.age_group;
      if (p.style) productMetadata.style = p.style;
      if (p.model_number) productMetadata.modelNumber = p.model_number;

      result.productMetadata = productMetadata;
      result.confidence = audio.confidence;
      result.relevantExcerpts = audio.relevant_excerpts;
    }

    return result;
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

export const geminiUnifiedVideoAnalyzerProvider = new GeminiUnifiedVideoAnalyzerProvider();

/**
 * Gemini Audio Analysis Provider
 *
 * Uses Google Gemini's audio understanding capabilities to transcribe
 * product video audio and extract structured e-commerce metadata.
 */

import path from 'path';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { GoogleAIFileManager, FileState, type FileMetadataResponse } from '@google/generative-ai/server';
import { createChildLogger } from '../../utils/logger.js';
import { ExternalApiError } from '../../utils/errors.js';
import { getConfig } from '../../config/index.js';
import { getAudioMimeType } from '../../utils/mime-types.js';
import type {
  AudioAnalysisProvider,
  AudioAnalysisResult,
  AudioAnalysisOptions,
} from '../interfaces/audio-analysis.provider.js';
import type { ProductMetadata } from '../../types/product-metadata.types.js';
import {
  type GeminiAudioAnalysisResponse,
  safeParseGeminiAudioAnalysisResponse,
} from '../../types/product-metadata.types.js';
import {
  GEMINI_AUDIO_ANALYSIS_SYSTEM_PROMPT,
  buildAudioAnalysisPrompt,
} from '../../templates/gemini-audio-analysis-prompt.js';

const logger = createChildLogger({ service: 'gemini-audio' });

/**
 * Helper to extract error message from FileMetadataResponse
 * The error field is an RpcStatus when file.state === FileState.FAILED
 */
function getFileErrorMessage(file: FileMetadataResponse): string | undefined {
  // FileMetadataResponse.error is typed as RpcStatus when present
  // RpcStatus has code: number, message: string, details: unknown[]
  return file.error?.message;
}

export class GeminiAudioAnalysisProvider implements AudioAnalysisProvider {
  readonly providerId = 'gemini-audio';

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
    logger.info('Gemini audio client initialized');

    return { client: this.client, fileManager: this.fileManager };
  }

  /**
   * Get model instance for audio analysis
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
        maxOutputTokens: 16384,
      },
    });
  }

  /**
   * Upload audio to Gemini Files API
   */
  async uploadAudio(audioPath: string): Promise<string> {
    const { fileManager } = this.init();
    const config = getConfig();

    // Use configurable timeouts
    const processingTimeoutMs = config.audio.processingTimeoutMs;
    const pollingIntervalMs = config.audio.pollingIntervalMs;

    logger.info({ audioPath }, 'Uploading audio to Gemini Files API');

    const mimeType = getAudioMimeType(audioPath);
    const uploadResult = await fileManager.uploadFile(audioPath, {
      mimeType,
      displayName: path.basename(audioPath) || 'audio',
    });

    const fileUri = uploadResult.file.uri;
    logger.info({ fileUri, state: uploadResult.file.state }, 'Audio uploaded');

    // Wait for processing to complete
    let file = uploadResult.file;
    let elapsedMs = 0;
    const maxAttempts = Math.ceil(processingTimeoutMs / pollingIntervalMs);

    for (let attempts = 0; file.state === FileState.PROCESSING && attempts < maxAttempts; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs));
      elapsedMs += pollingIntervalMs;
      file = await fileManager.getFile(file.name);
      logger.debug({ state: file.state, attempts: attempts + 1, elapsedMs }, 'Waiting for audio processing');
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
        'Gemini audio processing failed'
      );
      throw new ExternalApiError(
        'Gemini',
        `Audio processing failed${errorMessage ? `: ${errorMessage}` : ''}`
      );
    }

    if (file.state !== FileState.ACTIVE) {
      const elapsedSeconds = elapsedMs / 1000;
      throw new ExternalApiError(
        'Gemini',
        `Audio processing timeout after ${elapsedSeconds} seconds`
      );
    }

    logger.info({ fileUri, state: file.state }, 'Audio processing complete');
    return fileUri;
  }

  /**
   * Delete uploaded audio from Gemini
   */
  async deleteAudio(audioUri: string): Promise<void> {
    const { fileManager } = this.init();

    const fileName = this.extractFileName(audioUri);
    if (!fileName) {
      logger.warn({ audioUri }, 'Could not extract file name from URI');
      return;
    }

    try {
      await fileManager.deleteFile(fileName);
      logger.info({ fileName }, 'Audio deleted from Gemini Files API');
    } catch (error) {
      logger.warn({ error, fileName }, 'Failed to delete audio from Gemini Files API');
    }
  }

  /**
   * Extract file name from URI
   */
  private extractFileName(uri: string): string | null {
    if (!uri) return null;

    try {
      const url = new URL(uri);
      const pathParts = url.pathname.split('/').filter(Boolean);
      const filesIndex = pathParts.indexOf('files');
      if (filesIndex >= 0 && pathParts[filesIndex + 1]) {
        return pathParts[filesIndex + 1];
      }
      return pathParts[pathParts.length - 1] || null;
    } catch {
      // Not a valid URL, treat as path
    }

    const parts = uri.split('/').filter(Boolean);
    if (parts[0] === 'files' && parts[1]) {
      return parts[1];
    }

    return parts[parts.length - 1] || null;
  }

  /**
   * Analyze audio and extract product metadata
   */
  async analyzeAudio(
    audioPath: string,
    options: AudioAnalysisOptions = {}
  ): Promise<AudioAnalysisResult> {
    const config = getConfig();
    const {
      model = 'gemini-3-flash-preview',
      maxBulletPoints = 5,
      maxRetries = config.audio.maxRetries,
      retryDelay = config.worker.apiRetryDelayMs,
      temperature,
      topP,
      focusAreas = [],
    } = options;

    logger.info({ audioPath, model, maxBulletPoints }, 'Analyzing audio with Gemini');

    // Upload audio
    const fileUri = await this.uploadAudio(audioPath);

    try {
      const geminiModel = this.getModel({ modelName: model, temperature, topP });

      const prompt = buildAudioAnalysisPrompt({ maxBulletPoints, focusAreas });

      // Build content with audio file reference
      const content = [
        {
          fileData: {
            mimeType: getAudioMimeType(audioPath),
            fileUri,
          },
        },
        { text: GEMINI_AUDIO_ANALYSIS_SYSTEM_PROMPT },
        { text: prompt },
      ];

      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          logger.info({ attempt, maxRetries }, 'Gemini audio analysis attempt');

          const result = await geminiModel.generateContent(content);
          const response = await result.response;
          const text = response.text();

          const parsed = this.parseResponse(text);
          return this.convertToResult(parsed);
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          logger.error({ error: lastError.message, attempt }, 'Gemini audio analysis attempt failed');

          if (attempt < maxRetries) {
            logger.info({ delay: retryDelay }, 'Retrying audio analysis');
            await new Promise((r) => setTimeout(r, retryDelay));
          }
        }
      }

      throw new ExternalApiError(
        'Gemini',
        `Audio analysis failed after ${maxRetries} attempts: ${lastError?.message}`
      );
    } finally {
      // Cleanup: delete uploaded audio from Gemini
      await this.deleteAudio(fileUri);
    }
  }

  /**
   * Parse and validate Gemini response using Zod schema
   */
  private parseResponse(text: string): GeminiAudioAnalysisResponse {
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

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(cleaned);
    } catch (e) {
      throw new ExternalApiError(
        'Gemini',
        `Failed to parse audio analysis response JSON: ${(e as Error).message}`
      );
    }

    // Validate using Zod schema
    const result = safeParseGeminiAudioAnalysisResponse(rawParsed);
    if (!result.success) {
      const errorDetails = result.error.errors
        .map(err => `${err.path.join('.')}: ${err.message}`)
        .join('; ');
      logger.error(
        { errors: result.error.errors, rawResponse: rawParsed },
        'Gemini audio analysis response validation failed'
      );
      throw new ExternalApiError(
        'Gemini',
        `Audio analysis response validation failed: ${errorDetails}`
      );
    }

    const parsed = result.data;

    logger.info(
      {
        transcriptLength: parsed.transcript.length,
        language: parsed.language,
        audioQuality: parsed.audioQuality,
        title: parsed.product.title?.slice(0, 50),
      },
      'Audio analysis response parsed and validated'
    );

    return parsed;
  }

  /**
   * Convert null to undefined (Zod nullish returns null, but our types expect undefined)
   */
  private nullToUndefined<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }

  /**
   * Convert Gemini response to provider interface format
   */
  private convertToResult(response: GeminiAudioAnalysisResponse): AudioAnalysisResult {
    const { product, confidence, relevantExcerpts } = response;

    // Build ProductMetadata from response
    // Use nullToUndefined for all nullish fields from Gemini
    const productMetadata: ProductMetadata = {
      title: product.title,
      description: product.description,
      shortDescription: this.nullToUndefined(product.shortDescription),
      bulletPoints: product.bulletPoints || [],
      brand: this.nullToUndefined(product.brand),
      category: this.nullToUndefined(product.category),
      subcategory: this.nullToUndefined(product.subcategory),
      materials: this.nullToUndefined(product.materials),
      color: this.nullToUndefined(product.color),
      colors: this.nullToUndefined(product.colors),
      size: this.nullToUndefined(product.size),
      sizes: this.nullToUndefined(product.sizes),
      keywords: this.nullToUndefined(product.keywords),
      tags: this.nullToUndefined(product.tags),
      condition: this.nullToUndefined(product.condition),
      careInstructions: this.nullToUndefined(product.careInstructions),
      warnings: this.nullToUndefined(product.warnings),
      confidence: {
        overall: confidence.overall,
        title: confidence.title,
        description: confidence.description,
        price: this.nullToUndefined(confidence.price),
        attributes: this.nullToUndefined(confidence.attributes),
      },
      extractedFromAudio: true,
      transcriptExcerpts: relevantExcerpts,
    };

    // Add price if present
    if (product.price?.value) {
      productMetadata.price = product.price.value;
      productMetadata.currency = product.price.currency || 'USD';
    }

    // Add dimensions if present
    if (product.dimensions && (product.dimensions.length || product.dimensions.width || product.dimensions.height)) {
      productMetadata.dimensions = {
        length: this.nullToUndefined(product.dimensions.length),
        width: this.nullToUndefined(product.dimensions.width),
        height: this.nullToUndefined(product.dimensions.height),
        unit: (product.dimensions.unit as 'cm' | 'in' | 'mm') || 'in',
      };
    }

    // Add weight if present
    if (product.weight?.value) {
      productMetadata.weight = {
        value: product.weight.value,
        unit: (product.weight.unit as 'g' | 'kg' | 'oz' | 'lb' | 'pounds') || 'lb',
      };
    }

    return {
      transcript: response.transcript,
      language: response.language || 'en',
      audioQuality: response.audioQuality,
      productMetadata,
      confidence: {
        overall: confidence.overall,
        title: confidence.title,
        description: confidence.description,
        price: this.nullToUndefined(confidence.price),
        attributes: this.nullToUndefined(confidence.attributes),
      },
      relevantExcerpts: relevantExcerpts || [],
      rawResponse: response,
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

export const geminiAudioAnalysisProvider = new GeminiAudioAnalysisProvider();

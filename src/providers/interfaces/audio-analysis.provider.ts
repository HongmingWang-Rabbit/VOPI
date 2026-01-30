/**
 * Audio Analysis Provider Interface
 *
 * Defines the contract for audio transcription and product metadata extraction.
 */

import type { GeminiAudioAnalysisResponse, ProductMetadata, MetadataConfidence } from '../../types/product-metadata.types.js';
import type { TokenUsageTracker } from '../../utils/token-usage.js';

/**
 * Options for audio analysis
 */
export interface AudioAnalysisOptions {
  /** Gemini model to use (default: gemini-2.0-flash) */
  model?: string;
  /** Maximum number of bullet points to generate (default: 5) */
  maxBulletPoints?: number;
  /** Maximum retries for API calls (default: 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 2000) */
  retryDelay?: number;
  /** Generation temperature (default: 0.2) */
  temperature?: number;
  /** Top-P sampling (default: 0.8) */
  topP?: number;
  /** Focus areas to pay special attention to */
  focusAreas?: string[];
}

/**
 * Result from audio analysis
 */
export interface AudioAnalysisResult {
  /** Full transcript of the audio */
  transcript: string;
  /** Detected language code */
  language: string;
  /** Audio quality score 0-100 */
  audioQuality: number;
  /** Extracted product metadata */
  productMetadata: ProductMetadata;
  /** Confidence scores */
  confidence: MetadataConfidence;
  /** Key excerpts from transcript */
  relevantExcerpts: string[];
  /** Raw response from AI */
  rawResponse: GeminiAudioAnalysisResponse;
}

/**
 * Audio Analysis Provider Interface
 */
export interface AudioAnalysisProvider {
  /** Unique provider identifier */
  readonly providerId: string;

  /**
   * Check if provider is available (API key configured, etc.)
   */
  isAvailable(): boolean;

  /**
   * Analyze audio file and extract product metadata
   *
   * @param audioPath - Path to the audio file
   * @param options - Analysis options
   * @returns Analysis result with transcript and metadata
   */
  analyzeAudio(audioPath: string, options?: AudioAnalysisOptions, tokenUsage?: TokenUsageTracker): Promise<AudioAnalysisResult>;

  /**
   * Upload audio file to provider (if needed for processing)
   *
   * @param audioPath - Path to the audio file
   * @returns URI or identifier for the uploaded file
   */
  uploadAudio?(audioPath: string): Promise<string>;

  /**
   * Delete uploaded audio from provider storage
   *
   * @param audioUri - URI or identifier of the uploaded file
   */
  deleteAudio?(audioUri: string): Promise<void>;
}

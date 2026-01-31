/**
 * Gemini Video Analysis Provider
 *
 * Uses Google Gemini's video understanding capabilities to analyze videos
 * and select the best product frames directly, without needing to extract
 * all frames first.
 */

import path from 'path';
import os from 'os';
import { unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { createChildLogger } from '../../utils/logger.js';
import { ExternalApiError } from '../../utils/errors.js';
import type { TokenUsageTracker } from '../../utils/token-usage.js';
import { getConfig } from '../../config/index.js';
import type {
  VideoAnalysisProvider,
  VideoAnalysisResult,
  VideoAnalysisFrame,
  VideoAnalysisOptions,
} from '../interfaces/video-analysis.provider.js';
import { GEMINI_VIDEO_SYSTEM_PROMPT } from '../../templates/gemini-video-system-prompt.js';

const logger = createChildLogger({ service: 'gemini-video' });

/** Default timeout for video processing (5 minutes) */
const DEFAULT_PROCESSING_TIMEOUT_MS = 300_000;

/** Default polling interval for checking video processing status */
const DEFAULT_POLLING_INTERVAL_MS = 5_000;

/**
 * Gemini video analysis response schema
 */
interface GeminiVideoResponse {
  products_detected: Array<{
    product_id: string;
    description: string;
    product_category?: string;
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
}

export class GeminiVideoAnalysisProvider implements VideoAnalysisProvider {
  readonly providerId = 'gemini-video';

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
    logger.info('Gemini video client initialized');

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
        maxOutputTokens: 16384,
      },
    });
  }

  /**
   * Upload video to Gemini Files API
   */
  async uploadVideo(videoPath: string): Promise<string> {
    const { fileManager } = this.init();

    logger.info({ videoPath }, 'Uploading video to Gemini Files API');

    const uploadResult = await fileManager.uploadFile(videoPath, {
      mimeType: this.getMimeType(videoPath),
      displayName: path.basename(videoPath) || 'video',
    });

    const fileUri = uploadResult.file.uri;
    logger.info({ fileUri, state: uploadResult.file.state }, 'Video uploaded');

    // Wait for processing to complete
    let file = uploadResult.file;
    let attempts = 0;
    const maxAttempts = Math.ceil(DEFAULT_PROCESSING_TIMEOUT_MS / DEFAULT_POLLING_INTERVAL_MS);

    while (file.state === FileState.PROCESSING && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLLING_INTERVAL_MS));
      const getResult = await fileManager.getFile(file.name);
      file = getResult;
      attempts++;
      logger.debug({ state: file.state, attempts }, 'Waiting for video processing');
    }

    if (file.state === FileState.FAILED) {
      // Log all available file info for debugging
      logger.error(
        {
          fileName: file.name,
          displayName: file.displayName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          state: file.state,
          // The error field may contain details about why processing failed
          error: (file as unknown as { error?: { message?: string; code?: string } }).error,
        },
        'Gemini video processing failed'
      );
      const errorDetails = (file as unknown as { error?: { message?: string } }).error?.message;
      throw new ExternalApiError(
        'Gemini',
        `Video processing failed${errorDetails ? `: ${errorDetails}` : ''}`
      );
    }

    if (file.state !== FileState.ACTIVE) {
      throw new ExternalApiError('Gemini', `Video processing timeout after ${attempts * DEFAULT_POLLING_INTERVAL_MS / 1000} seconds`);
    }

    logger.info({ fileUri, state: file.state }, 'Video processing complete');
    return fileUri;
  }

  /**
   * Delete uploaded video
   */
  async deleteVideo(videoUri: string): Promise<void> {
    const { fileManager } = this.init();

    // Extract file name from URI (handles both "files/name" and full URL formats)
    const fileName = this.extractFileName(videoUri);
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
   * Extract file name from various URI formats
   * Handles: "files/abc123", "https://...googleapis.com/.../files/abc123", etc.
   */
  private extractFileName(uri: string): string | null {
    if (!uri) return null;

    // Try to parse as URL first
    try {
      const url = new URL(uri);
      const pathParts = url.pathname.split('/').filter(Boolean);
      // Find "files" segment and return the next one
      const filesIndex = pathParts.indexOf('files');
      if (filesIndex >= 0 && pathParts[filesIndex + 1]) {
        return pathParts[filesIndex + 1];
      }
      // Fallback to last path segment
      return pathParts[pathParts.length - 1] || null;
    } catch {
      // Not a valid URL, treat as path
    }

    // Handle simple "files/name" format
    const parts = uri.split('/').filter(Boolean);
    if (parts[0] === 'files' && parts[1]) {
      return parts[1];
    }

    // Fallback to last segment
    return parts[parts.length - 1] || null;
  }

  /**
   * Check if video uses HEVC (H.265) codec which is not supported by Gemini
   */
  private async isHevcCodec(videoPath: string): Promise<boolean> {
    const config = getConfig();
    const ffprobePath = config.ffmpeg.ffprobePath;

    return new Promise((resolve) => {
      const ffprobe = spawn(ffprobePath, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ]);

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          logger.warn({ videoPath, code }, 'Failed to detect video codec');
          resolve(false);
          return;
        }

        const codec = output.trim().toLowerCase();
        const isHevc = codec === 'hevc' || codec === 'h265';
        if (isHevc) {
          logger.info({ videoPath, codec }, 'Detected HEVC codec, will transcode to H.264');
        }
        resolve(isHevc);
      });

      ffprobe.on('error', (error) => {
        logger.warn({ videoPath, error: error.message }, 'Failed to run ffprobe');
        resolve(false);
      });
    });
  }

  /**
   * Transcode video to H.264 codec for Gemini compatibility
   */
  private async transcodeToH264(inputPath: string): Promise<string> {
    const config = getConfig();
    const ffmpegPath = config.ffmpeg.ffmpegPath;

    // Create temp output path
    const tempDir = os.tmpdir();
    const outputPath = path.join(tempDir, `gemini_transcode_${Date.now()}.mp4`);

    logger.info({ inputPath, outputPath }, 'Transcoding video to H.264');

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-y', // Overwrite output
        outputPath,
      ]);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          logger.error({ inputPath, code, stderr: stderr.slice(-500) }, 'FFmpeg transcoding failed');
          reject(new ExternalApiError('FFmpeg', `Transcoding failed with code ${code}`));
          return;
        }

        logger.info({ inputPath, outputPath }, 'Video transcoded successfully');
        resolve(outputPath);
      });

      ffmpeg.on('error', (error) => {
        logger.error({ inputPath, error: error.message }, 'FFmpeg spawn error');
        reject(new ExternalApiError('FFmpeg', `Failed to start FFmpeg: ${error.message}`));
      });
    });
  }

  /**
   * Analyze video and select best frames
   */
  async analyzeVideo(
    videoPath: string,
    options: VideoAnalysisOptions = {},
    tokenUsage?: TokenUsageTracker
  ): Promise<VideoAnalysisResult> {
    const config = getConfig();
    const {
      model = 'gemini-3-flash-preview',
      maxFrames = 10,
      maxRetries = 3,
      retryDelay = config.worker.apiRetryDelayMs,
      temperature,
      topP,
    } = options;

    logger.info({ videoPath, model, maxFrames, temperature, topP }, 'Analyzing video with Gemini');

    // Check if video needs transcoding (HEVC → H.264)
    let effectiveVideoPath = videoPath;
    let transcodedPath: string | null = null;

    if (await this.isHevcCodec(videoPath)) {
      transcodedPath = await this.transcodeToH264(videoPath);
      effectiveVideoPath = transcodedPath;
    }

    // Upload video
    const fileUri = await this.uploadVideo(effectiveVideoPath);

    try {
      const geminiModel = this.getModel({ modelName: model, temperature, topP });

      const prompt = this.buildPrompt(maxFrames);

      // Build content with video file reference
      const content = [
        {
          fileData: {
            mimeType: this.getMimeType(effectiveVideoPath),
            fileUri,
          },
        },
        { text: GEMINI_VIDEO_SYSTEM_PROMPT },
        { text: prompt },
      ];

      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          logger.info({ attempt, maxRetries }, 'Gemini video analysis attempt');

          const result = await geminiModel.generateContent(content);
          const response = await result.response;
          const text = response.text();

          if (tokenUsage) {
            if (response.usageMetadata) {
              tokenUsage.record(
                model,
                'gemini-video-analysis',
                response.usageMetadata.promptTokenCount ?? 0,
                response.usageMetadata.candidatesTokenCount ?? 0,
              );
            } else {
              logger.warn({ model }, 'Gemini response missing usageMetadata - token usage not tracked');
            }
          }

          const parsed = this.parseResponse(text);

          return this.convertToResult(parsed);
        } catch (e) {
          lastError = e as Error;
          logger.error({
            attempt,
            errorMessage: lastError.message,
            errorName: lastError.name,
            errorStack: lastError.stack?.split('\n').slice(0, 3).join('\n'),
          }, 'Gemini video analysis attempt failed');

          if (attempt < maxRetries) {
            logger.info({ delay: retryDelay }, 'Retrying video analysis');
            await new Promise((r) => setTimeout(r, retryDelay));
          }
        }
      }

      throw new ExternalApiError(
        'Gemini',
        `Video analysis failed after ${maxRetries} attempts: ${lastError?.message}`
      );
    } finally {
      // Cleanup: delete uploaded video from Gemini
      await this.deleteVideo(fileUri);

      // Cleanup: delete transcoded file if created
      if (transcodedPath) {
        try {
          await unlink(transcodedPath);
          logger.debug({ transcodedPath }, 'Transcoded file cleaned up');
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Build the analysis prompt
   */
  private buildPrompt(maxFrames: number): string {
    return `## Your Task
Analyze this product video and identify the ${maxFrames} best timestamps for product photography.

For each distinct product variant (different colors, angles, configurations), select ONE optimal timestamp.

Requirements:
- Select up to ${maxFrames} frames total
- Each frame should be from a unique variant/angle
- Prioritize clarity, lighting, and minimal obstructions
- Note any rotation needed to straighten products

Return the JSON response as specified in the system prompt.`;
  }

  /**
   * Parse Gemini response
   */
  private parseResponse(text: string): GeminiVideoResponse {
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

    let parsed: GeminiVideoResponse;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new ExternalApiError(
        'Gemini',
        `Failed to parse video analysis response: ${(e as Error).message}`
      );
    }

    if (!parsed.selected_frames || !Array.isArray(parsed.selected_frames)) {
      throw new ExternalApiError('Gemini', 'Response missing selected_frames array');
    }

    logger.info(
      {
        products: parsed.products_detected?.length || 0,
        frames: parsed.selected_frames.length,
        duration: parsed.video_duration_sec,
      },
      'Video analysis response parsed'
    );

    return parsed;
  }

  /**
   * Convert Gemini response to provider interface format
   */
  private convertToResult(response: GeminiVideoResponse): VideoAnalysisResult {
    const products = response.products_detected?.map((p) => ({
      productId: p.product_id,
      description: p.description,
      category: p.product_category,
    })) || [];

    const selectedFrames: VideoAnalysisFrame[] = response.selected_frames.map((frame) => ({
      timestamp: frame.timestamp_sec,
      selectionReason: frame.selection_reason,
      productId: frame.product_id,
      variantId: frame.variant_id,
      angleEstimate: frame.angle_estimate,
      qualityScore: frame.quality_score_0_100,
      rotationAngleDeg: frame.rotation_angle_deg ?? 0,
      variantDescription: frame.variant_description,
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

    return {
      products,
      selectedFrames,
      videoDuration: response.video_duration_sec,
      framesAnalyzed: response.frames_analyzed,
      rawResponse: response,
    };
  }

  /**
   * Get MIME type from file path
   */
  private getMimeType(filePath: string): string {
    const ext = filePath.toLowerCase().split('.').pop();
    const mimeTypes: Record<string, string> = {
      mp4: 'video/mp4',
      mpeg: 'video/mpeg',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      webm: 'video/webm',
      wmv: 'video/x-ms-wmv',
      '3gp': 'video/3gpp',
      flv: 'video/x-flv',
      mpg: 'video/mpeg',
    };
    return mimeTypes[ext || ''] || 'video/mp4';
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

export const geminiVideoAnalysisProvider = new GeminiVideoAnalysisProvider();

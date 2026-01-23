/**
 * Gemini Audio Analysis Processor
 *
 * Analyzes audio from video to transcribe and extract product metadata.
 * Uses Gemini 2.0 Flash for transcription and e-commerce metadata extraction.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, ProductMetadataOutput } from '../../types.js';
import { geminiAudioAnalysisProvider } from '../../../providers/implementations/gemini-audio-analysis.provider.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:gemini-audio-analysis' });

export const geminiAudioAnalysisProcessor: Processor = {
  id: 'gemini-audio-analysis',
  displayName: 'Analyze Audio',
  statusKey: JobStatus.CLASSIFYING,
  io: {
    requires: ['audio'],
    produces: ['transcript', 'product.metadata'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, onProgress, effectiveConfig, timer } = context;

    // Check if audio was extracted and has content
    if (!data.audio) {
      logger.info({ jobId }, 'No audio data, skipping audio analysis');
      return {
        success: true,
        data: {
          metadata: {
            ...data.metadata,
            transcript: '',
          },
        },
      };
    }

    if (!data.audio.hasAudio) {
      logger.info({ jobId }, 'Video has no audio track, skipping audio analysis');
      return {
        success: true,
        data: {
          metadata: {
            ...data.metadata,
            transcript: '',
            productMetadata: {
              title: '',
              description: '',
              bulletPoints: [],
              confidence: 0,
              extractedFromAudio: false,
            },
          },
        },
      };
    }

    const audioPath = data.audio.path;

    logger.info({ jobId, audioPath }, 'Starting audio analysis with Gemini');

    await onProgress?.({
      status: JobStatus.CLASSIFYING,
      percentage: 25,
      message: 'Analyzing audio for product information',
    });

    const model = (options?.model as string) ?? effectiveConfig.geminiModel;
    const maxBulletPoints = (options?.maxBulletPoints as number) ?? 5;
    const focusAreas = (options?.focusAreas as string[]) ?? [];

    try {
      const analysisResult = await timer.timeOperation(
        'gemini_audio_analyze',
        () => geminiAudioAnalysisProvider.analyzeAudio(audioPath, {
          model,
          maxBulletPoints,
          focusAreas,
          temperature: effectiveConfig.temperature,
          topP: effectiveConfig.topP,
        }),
        { audioPath, model }
      );

      logger.info({
        jobId,
        transcriptLength: analysisResult.transcript.length,
        language: analysisResult.language,
        audioQuality: analysisResult.audioQuality,
        title: analysisResult.productMetadata.title?.slice(0, 50),
      }, 'Audio analysis complete');

      // Convert full ProductMetadata to simplified ProductMetadataOutput
      const productMetadataOutput: ProductMetadataOutput = {
        title: analysisResult.productMetadata.title,
        description: analysisResult.productMetadata.description,
        shortDescription: analysisResult.productMetadata.shortDescription,
        bulletPoints: analysisResult.productMetadata.bulletPoints,
        brand: analysisResult.productMetadata.brand,
        category: analysisResult.productMetadata.category,
        keywords: analysisResult.productMetadata.keywords,
        tags: analysisResult.productMetadata.tags,
        color: analysisResult.productMetadata.color,
        materials: analysisResult.productMetadata.materials,
        confidence: analysisResult.confidence.overall,
        extractedFromAudio: true,
        transcriptExcerpts: analysisResult.relevantExcerpts,
      };

      await onProgress?.({
        status: JobStatus.CLASSIFYING,
        percentage: 35,
        message: 'Audio analysis complete',
      });

      return {
        success: true,
        data: {
          metadata: {
            ...data.metadata,
            transcript: analysisResult.transcript,
            productMetadata: productMetadataOutput,
            audioDuration: data.audio.duration,
            // Store full metadata in extensions for later use
            extensions: {
              ...data.metadata.extensions,
              fullProductMetadata: analysisResult.productMetadata,
              audioAnalysisRaw: analysisResult.rawResponse,
            },
          },
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ jobId, error: errorMessage }, 'Audio analysis failed');

      // Return success but with empty metadata - don't fail the whole pipeline
      // Audio analysis is supplementary to visual processing
      return {
        success: true,
        data: {
          metadata: {
            ...data.metadata,
            transcript: '',
            productMetadata: {
              title: '',
              description: '',
              bulletPoints: [],
              confidence: 0,
              extractedFromAudio: false,
            },
            audioAnalysisFailed: true,
            extensions: {
              ...data.metadata?.extensions,
              audioAnalysisError: errorMessage,
            },
          },
        },
      };
    }
  },
};

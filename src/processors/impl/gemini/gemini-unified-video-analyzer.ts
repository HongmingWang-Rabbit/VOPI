/**
 * Gemini Unified Video Analyzer Processor
 *
 * Combines the functionality of multiple processors into a single efficient step:
 * - extract-audio (audio is analyzed directly from video)
 * - gemini-audio-analysis (transcription + product metadata)
 * - extract-frames (only selected frames, not all)
 * - score-frames (scores come from Gemini)
 * - gemini-classify (classification comes from Gemini)
 * - save-frame-records (saves to database)
 *
 * Benefits:
 * - Single Gemini API call for both audio and video analysis
 * - Cross-modal context (audio informs frame selection)
 * - More efficient (no need to extract all frames, just selected ones)
 * - Single video upload to Gemini Files API
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { videoService } from '../../../services/video.service.js';
import { geminiUnifiedVideoAnalyzerProvider } from '../../../providers/implementations/gemini-unified-video-analyzer.provider.js';
import { getDatabase, schema } from '../../../db/index.js';
import type { NewFrame } from '../../../db/schema.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { PROGRESS } from '../../constants.js';
import { saveVideoRecord } from '../../utils/index.js';
import { getConcurrency } from '../../concurrency.js';
import {
  DEFAULT_MAX_BULLET_POINTS,
} from '../../../providers/utils/gemini-utils.js';
import type { UnifiedAnalysisFrame } from '../../../providers/interfaces/unified-video-analyzer.provider.js';

const logger = createChildLogger({ service: 'processor:gemini-unified-video-analyzer' });

/**
 * Build FrameMetadata from unified analysis frame
 */
function buildFrameMetadata(
  frame: UnifiedAnalysisFrame,
  index: number,
  outputPath: string
): FrameMetadata {
  const frameId = `frame_${String(index + 1).padStart(5, '0')}`;
  const filename = `${frameId}_t${frame.timestamp.toFixed(2)}.png`;

  return {
    frameId,
    filename,
    path: outputPath,
    timestamp: frame.timestamp,
    index,
    // Score fields (from Gemini analysis)
    sharpness: frame.qualityScore, // Use quality score as proxy
    motion: 0, // Not applicable for single frame analysis
    score: frame.qualityScore,
    isBestPerSecond: true,
    // Classification fields
    productId: frame.productId,
    variantId: frame.variantId,
    angleEstimate: frame.angleEstimate,
    recommendedType: `${frame.productId}_${frame.variantId}`,
    variantDescription: frame.variantDescription,
    geminiScore: frame.qualityScore,
    rotationAngleDeg: frame.rotationAngleDeg,
    allFrameIds: [frameId],
    obstructions: frame.obstructions,
    backgroundRecommendations: frame.backgroundRecommendations,
    isFinalSelection: true,
  };
}

/**
 * Build NewFrame for database insert
 */
function buildFrameRecord(
  frame: FrameMetadata,
  jobId: string,
  videoId: string
): NewFrame {
  return {
    jobId,
    videoId,
    frameId: frame.frameId,
    timestamp: frame.timestamp,
    localPath: frame.path,
    scores: {
      sharpness: frame.sharpness ?? 0,
      motion: frame.motion ?? 0,
      combined: frame.score ?? 0,
      geminiScore: frame.geminiScore,
    },
    productId: frame.productId,
    variantId: frame.variantId,
    angleEstimate: frame.angleEstimate,
    variantDescription: frame.variantDescription,
    obstructions: frame.obstructions,
    backgroundRecommendations: frame.backgroundRecommendations,
    isBestPerSecond: true,
    isFinalSelection: true,
  };
}

export const geminiUnifiedVideoAnalyzerProcessor: Processor = {
  id: 'gemini-unified-video-analyzer',
  displayName: 'Unified Video Analyzer',
  statusKey: JobStatus.CLASSIFYING,
  io: {
    requires: ['video'],
    produces: ['images', 'frames', 'frames.scores', 'frames.classifications', 'frames.dbId', 'transcript', 'product.metadata'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress, effectiveConfig, timer, job } = context;
    const db = getDatabase();

    if (!data.video?.path) {
      return { success: false, error: 'No video path provided' };
    }

    const videoPath = data.video.path;

    logger.info({ jobId, videoPath }, 'Starting unified video analysis');

    // Step 1: Get video metadata and create video record
    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: PROGRESS.EXTRACT_FRAMES.ANALYZING,
      message: 'Analyzing video',
    });

    const metadata = await videoService.getMetadata(videoPath);

    // Save video record to database
    const video = await saveVideoRecord({
      jobId,
      sourceUrl: job.videoUrl,
      localPath: videoPath,
      metadata,
    });

    // Step 2: Unified analysis with Gemini (audio + video in single call)
    await onProgress?.({
      status: JobStatus.CLASSIFYING,
      percentage: 25,
      message: 'AI analyzing video (audio + visual)',
    });

    const maxFrames = (options?.maxFrames as number) ?? effectiveConfig.geminiVideoMaxFrames;
    const maxBulletPoints = (options?.maxBulletPoints as number) ?? DEFAULT_MAX_BULLET_POINTS;
    const model = (options?.model as string) ?? effectiveConfig.geminiVideoModel;
    const skipAudioAnalysis = (options?.skipAudioAnalysis as boolean) ?? false;

    const analysisResult = await timer.timeOperation(
      'gemini_unified_analyze',
      () => geminiUnifiedVideoAnalyzerProvider.analyzeVideo(videoPath, {
        model,
        maxFrames,
        maxBulletPoints,
        skipAudioAnalysis,
        temperature: effectiveConfig.temperature,
        topP: effectiveConfig.topP,
      }),
      { videoPath, maxFrames, skipAudioAnalysis }
    );

    const { audioAnalysis } = analysisResult;

    logger.info({
      jobId,
      selectedFrames: analysisResult.selectedFrames.length,
      products: analysisResult.products.length,
      hasAudio: audioAnalysis.hasAudio,
      transcriptLength: audioAnalysis.transcript?.length || 0,
    }, 'Unified video analysis complete');

    // Step 3: Extract frames at selected timestamps (in parallel)
    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: 50,
      message: 'Extracting selected frames',
    });

    const concurrency = getConcurrency('FFMPEG_EXTRACT', options);

    // Prepare frame data with indices for parallel processing
    const frameData = analysisResult.selectedFrames.map((frame, index) => ({
      frame,
      index,
      frameId: `frame_${String(index + 1).padStart(5, '0')}`,
      filename: `frame_${String(index + 1).padStart(5, '0')}_t${frame.timestamp.toFixed(2)}.png`,
      outputPath: path.join(workDirs.frames, `frame_${String(index + 1).padStart(5, '0')}_t${frame.timestamp.toFixed(2)}.png`),
    }));

    // Extract frames in parallel
    const parallelResults = await parallelMap(
      frameData,
      async ({ frame, index, outputPath }) => {
        await timer.timeOperation(
          'ffmpeg_extract_frame',
          () => videoService.extractSingleFrame(videoPath, frame.timestamp, outputPath),
          { timestamp: frame.timestamp, frameId: frameData[index].frameId }
        );

        return buildFrameMetadata(frame, index, outputPath);
      },
      { concurrency }
    );

    // Filter out any errors and get successful frame extractions
    const recommendedFrames = parallelResults.results.filter(
      (result): result is FrameMetadata => !isParallelError(result)
    );

    if (parallelResults.errorCount > 0) {
      logger.warn(
        { jobId, errorCount: parallelResults.errorCount, successCount: parallelResults.successCount },
        'Some frames failed to extract'
      );
    }

    // Update progress after extraction
    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: 70,
      message: `Extracted ${recommendedFrames.length} frames`,
    });

    // Step 4: Save frame records to database
    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 75,
      message: 'Saving frame records',
    });

    const frameValues: NewFrame[] = recommendedFrames.map((frame) =>
      buildFrameRecord(frame, jobId, video.id)
    );

    const frameRecords = new Map<string, string>();

    if (frameValues.length > 0) {
      const records = await db
        .insert(schema.frames)
        .values(frameValues)
        .returning();

      for (const record of records) {
        frameRecords.set(record.frameId, record.id);
      }

      // Update frames with dbIds
      for (const frame of recommendedFrames) {
        frame.dbId = frameRecords.get(frame.frameId);
      }

      logger.info({ jobId, savedCount: records.length }, 'Frame records saved');
    }

    const imagePaths = recommendedFrames.map((f) => f.path);
    const productType = analysisResult.products?.[0]?.category;
    // Get actual product description for better background removal targeting
    const productDescription = analysisResult.products?.[0]?.description;

    // Build product metadata output
    const productMetadata = audioAnalysis.hasAudio && audioAnalysis.productMetadata
      ? {
          title: audioAnalysis.productMetadata.title,
          description: audioAnalysis.productMetadata.description,
          shortDescription: audioAnalysis.productMetadata.shortDescription,
          bulletPoints: audioAnalysis.productMetadata.bulletPoints || [],
          brand: audioAnalysis.productMetadata.brand,
          category: audioAnalysis.productMetadata.category || productType,
          keywords: audioAnalysis.productMetadata.keywords,
          tags: audioAnalysis.productMetadata.tags,
          color: audioAnalysis.productMetadata.color,
          materials: audioAnalysis.productMetadata.materials,
          confidence: audioAnalysis.confidence?.overall ?? 50,
          extractedFromAudio: true,
          transcriptExcerpts: audioAnalysis.relevantExcerpts,
        }
      : undefined;

    logger.info({
      jobId,
      frameCount: recommendedFrames.length,
      hasTranscript: !!audioAnalysis.transcript,
      hasProductMetadata: !!productMetadata,
    }, 'Unified video analysis processor complete');

    return {
      success: true,
      data: {
        video: {
          ...data.video,
          metadata,
          dbId: video.id,
        },
        images: imagePaths,
        // Audio data - path is empty when not extracted separately
        audio: {
          path: '', // No separate audio file extracted
          format: 'mp3',
          hasAudio: audioAnalysis.hasAudio,
          duration: analysisResult.videoDuration,
        },
        // Legacy fields for backwards compatibility
        frames: recommendedFrames,
        recommendedFrames,
        scoredFrames: recommendedFrames,
        candidateFrames: recommendedFrames,
        frameRecords,
        productType,
        // New unified metadata
        metadata: {
          ...data.metadata,
          frames: recommendedFrames,
          video: {
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height,
            fps: metadata.fps,
            codec: metadata.codec,
            filename: metadata.filename,
          },
          // Audio analysis results
          transcript: audioAnalysis.transcript,
          audioDuration: analysisResult.videoDuration,
          productMetadata,
          // Analysis metadata
          analysisResult: analysisResult.rawResponse,
          products: analysisResult.products,
          framesAnalyzed: analysisResult.framesAnalyzed,
          variantsDiscovered: recommendedFrames.length,
          productType,
          // Product description for background removal targeting (e.g., "AirPods case", "wireless earbuds")
          productDescription,
          frameRecordCount: recommendedFrames.length,
          // Extension data for audio analysis details
          extensions: {
            audioAnalysis: {
              language: audioAnalysis.language,
              audioQuality: audioAnalysis.audioQuality,
              confidence: audioAnalysis.confidence,
              relevantExcerpts: audioAnalysis.relevantExcerpts,
            },
          },
        },
      },
    };
  },
};

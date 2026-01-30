/**
 * Gemini Video Analysis Processor
 *
 * Uses Gemini AI to analyze video and select best frames.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { videoService } from '../../../services/video.service.js';
import { geminiVideoAnalysisProvider } from '../../../providers/implementations/gemini-video-analysis.provider.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { PROGRESS, calculateProgress } from '../../constants.js';
import { saveVideoRecord } from '../../utils/index.js';

const logger = createChildLogger({ service: 'processor:gemini-video-analysis' });

export const geminiVideoAnalysisProcessor: Processor = {
  id: 'gemini-video-analysis',
  displayName: 'Gemini Video Analysis',
  statusKey: JobStatus.CLASSIFYING,
  io: {
    requires: ['video'],
    produces: ['images', 'frames', 'frames.classifications'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress, effectiveConfig, timer, job } = context;

    if (!data.video?.path) {
      return { success: false, error: 'No video path provided' };
    }

    const videoPath = data.video.path;

    logger.info({ jobId, videoPath }, 'Starting Gemini video analysis');

    // Get video metadata and create video record
    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: PROGRESS.EXTRACT_FRAMES.ANALYZING,
      message: 'Analyzing video',
    });

    const metadata = await videoService.getMetadata(videoPath);

    // Save video record to database using shared utility
    const video = await saveVideoRecord({
      jobId,
      sourceUrl: job.videoUrl,
      localPath: videoPath,
      metadata,
    });

    // Analyze video with Gemini
    await onProgress?.({
      status: JobStatus.CLASSIFYING,
      percentage: PROGRESS.CLASSIFY.START - 30,
      message: 'AI analyzing video',
    });

    const maxFrames = (options?.maxFrames as number) ?? effectiveConfig.geminiVideoMaxFrames;
    const model = (options?.model as string) ?? effectiveConfig.geminiVideoModel;

    const analysisResult = await timer.timeOperation(
      'gemini_video_analyze',
      () => geminiVideoAnalysisProvider.analyzeVideo(videoPath, {
        model,
        maxFrames,
        temperature: effectiveConfig.temperature,
        topP: effectiveConfig.topP,
      }, context.tokenUsage),
      { videoPath, maxFrames }
    );

    logger.info({
      jobId,
      selectedFrames: analysisResult.selectedFrames.length,
      products: analysisResult.products.length,
    }, 'Gemini video analysis complete');

    // Extract frames at selected timestamps
    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: PROGRESS.SCORE_FRAMES.END,
      message: 'Extracting selected frames',
    });

    const recommendedFrames: FrameMetadata[] = [];

    for (let i = 0; i < analysisResult.selectedFrames.length; i++) {
      const frame = analysisResult.selectedFrames[i];
      const progress = calculateProgress(i, analysisResult.selectedFrames.length, PROGRESS.SCORE_FRAMES.END, PROGRESS.EXTRACT_PRODUCTS.START);

      await onProgress?.({
        status: JobStatus.EXTRACTING,
        percentage: progress,
        message: `Extracting frame ${i + 1}/${analysisResult.selectedFrames.length}`,
      });

      const frameId = `frame_${String(i + 1).padStart(5, '0')}`;
      const filename = `${frameId}_t${frame.timestamp.toFixed(2)}.png`;
      const outputPath = path.join(workDirs.frames, filename);

      await timer.timeOperation(
        'ffmpeg_extract_frame',
        () => videoService.extractSingleFrame(videoPath, frame.timestamp, outputPath),
        { timestamp: frame.timestamp, frameId }
      );

      recommendedFrames.push({
        frameId,
        filename,
        path: outputPath,
        timestamp: frame.timestamp,
        index: i,
        sharpness: 0,
        motion: 0,
        score: frame.qualityScore,
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
        isBestPerSecond: true,
        isFinalSelection: true,
      });
    }

    const imagePaths = recommendedFrames.map((f) => f.path);
    const productType = analysisResult.products?.[0]?.category;

    logger.info({ jobId, frameCount: recommendedFrames.length }, 'Selected frames extracted');

    return {
      success: true,
      data: {
        video: {
          ...data.video,
          metadata,
          dbId: video.id,
        },
        images: imagePaths,
        // Legacy fields for backwards compatibility
        frames: recommendedFrames,
        recommendedFrames,
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
          analysisResult: analysisResult.rawResponse,
          products: analysisResult.products,
          framesAnalyzed: analysisResult.framesAnalyzed,
          variantsDiscovered: recommendedFrames.length,
          productType,
        },
      },
    };
  },
};

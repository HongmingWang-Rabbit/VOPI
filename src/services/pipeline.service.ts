import { mkdir, rm, copyFile } from 'fs/promises';
import path from 'path';
import os from 'os';

import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { extractS3KeyFromUrl } from '../utils/s3-url.js';
import { PipelineTimer } from '../utils/timer.js';
import { getDatabase, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { videoService } from './video.service.js';
import { frameScoringService, type ScoredFrame } from './frame-scoring.service.js';
import { geminiService, type RecommendedFrame } from './gemini.service.js';
import { globalConfigService } from './global-config.service.js';
import { providerRegistry, type ProductExtractionResult } from '../providers/index.js';
import { geminiVideoAnalysisProvider } from '../providers/implementations/gemini-video-analysis.provider.js';
import type { VideoAnalysisFrame } from '../providers/interfaces/video-analysis.provider.js';
import { photoroomService } from './photoroom.service.js';
import { storageService } from './storage.service.js';
import type { Job, NewVideo, NewFrame, NewCommercialImage } from '../db/schema.js';
import { jobConfigSchema, type JobStatus, type JobProgress, type JobResult, type JobConfig } from '../types/job.types.js';
import type { VideoMetadata } from '../types/job.types.js';
import { PipelineStrategy, type EffectiveConfig } from '../types/config.types.js';

const logger = createChildLogger({ service: 'pipeline' });

export interface PipelineProgress {
  status: JobStatus;
  percentage: number;
  message?: string;
  step?: number;
  totalSteps?: number;
}

type ProgressCallback = (progress: PipelineProgress) => Promise<void>;

/**
 * Working directories for pipeline execution
 */
interface WorkDirs {
  root: string;
  video: string;
  frames: string;
  candidates: string;
  extracted: string;
  final: string;
  commercial: string;
}

/**
 * Context passed between pipeline steps
 */
interface PipelineContext {
  job: Job;
  jobId: string;
  config: JobConfig;
  workDirs: WorkDirs;
  onProgress?: ProgressCallback;
  timer: PipelineTimer;
  strategy: PipelineStrategy;
  effectiveConfig: EffectiveConfig;
}

/**
 * PipelineService - Orchestrates the full extraction pipeline
 */
export class PipelineService {
  /**
   * Run the complete pipeline for a job
   */
  async runPipeline(
    job: Job,
    onProgress?: ProgressCallback
  ): Promise<JobResult> {
    // Validate and parse config with defaults
    const config = jobConfigSchema.parse(job.config || {});
    const appConfig = getConfig();
    const jobId = job.id;

    // Get effective config from database (includes global settings)
    const effectiveConfig = await globalConfigService.getEffectiveConfig();

    // Determine pipeline strategy
    const strategy = effectiveConfig.pipelineStrategy;

    // Create timer for performance tracking
    const timer = new PipelineTimer(jobId);

    // Create temp working directories
    const workDirs = await this.createWorkDirs(jobId, appConfig.worker.tempDirName);

    const ctx: PipelineContext = {
      job,
      jobId,
      config,
      workDirs,
      onProgress,
      timer,
      strategy,
      effectiveConfig,
    };

    if (effectiveConfig.debugEnabled) {
      logger.warn({ jobId }, 'Debug mode active - temp files and S3 uploads will NOT be cleaned up');
    }
    logger.info({ jobId, strategy, debugEnabled: effectiveConfig.debugEnabled }, 'Starting pipeline with strategy');

    let result: JobResult;
    try {
      // Route to appropriate strategy
      switch (strategy) {
        case PipelineStrategy.GEMINI_VIDEO:
          result = await this.runGeminiVideoStrategy(ctx, effectiveConfig);
          break;
        case PipelineStrategy.CLASSIC:
        default:
          result = await this.runClassicStrategy(ctx);
          break;
      }

      // Only cleanup uploaded video on success (not on failure, as job may be retried)
      // Skip cleanup in debug mode to allow inspection
      if (effectiveConfig.debugEnabled) {
        logger.info({ jobId, videoUrl: ctx.job.videoUrl }, 'Debug mode: Skipping S3 video cleanup');
      } else {
        await this.cleanupUploadedVideo(ctx.job.videoUrl);
      }

      return result;
    } catch (error) {
      timer.logSummary(); // Log timing even on error
      await this.handlePipelineError(ctx, error as Error);
      throw error;
    } finally {
      // Always cleanup temp directory (can be recreated on retry)
      // Skip cleanup in debug mode to allow inspection
      if (effectiveConfig.debugEnabled) {
        logger.info({ jobId, tempDir: workDirs.root }, 'Debug mode: Preserving temp directory for inspection');
      } else {
        await rm(workDirs.root, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Classic strategy: Extract all frames → Score → Classify with Gemini
   */
  private async runClassicStrategy(ctx: PipelineContext): Promise<JobResult> {
    const { timer } = ctx;

    // Step 1: Download video
    timer.startStep('download');
    const videoPath = await this.downloadVideo(ctx);
    timer.endStep();

    // Step 2: Extract and analyze video
    timer.startStep('extract');
    const { video, metadata, frames } = await this.extractVideoFrames(ctx, videoPath);
    timer.endStep();

    // Step 3: Score frames
    timer.startStep('score');
    const { scoredFrames, candidateFrames } = await this.scoreFrames(ctx, frames);
    timer.endStep();

    // Step 4: Classify with Gemini
    timer.startStep('classify');
    const recommendedFrames = await this.classifyWithGemini(ctx, candidateFrames, metadata);
    timer.endStep();

    // Save frame records to database
    timer.startStep('save_records');
    const frameRecords = await this.saveFrameRecords(ctx, video.id, scoredFrames, candidateFrames, recommendedFrames);
    timer.endStep();

    // Step 5: Extract products (remove background, rotate, center)
    timer.startStep('extract_product');
    const extractionResults = await this.extractProducts(ctx, recommendedFrames);
    timer.endStep();

    // Step 6: Upload final frames and generate commercial images
    timer.startStep('generate');
    const finalFrameUrls = await this.uploadFinalFrames(ctx, recommendedFrames, frameRecords);
    const commercialImages = await this.generateCommercialImages(ctx, recommendedFrames, frameRecords, extractionResults);
    timer.endStep();

    // Step 7: Complete job
    timer.startStep('complete');
    const result = await this.completeJob(ctx, recommendedFrames.length, candidateFrames.length, finalFrameUrls, commercialImages);
    timer.endStep();

    // Log timing summary
    timer.logSummary();

    return result;
  }

  /**
   * Gemini Video strategy: Upload video to Gemini → AI selects timestamps → Extract specific frames
   */
  private async runGeminiVideoStrategy(
    ctx: PipelineContext,
    effectiveConfig: Awaited<ReturnType<typeof globalConfigService.getEffectiveConfig>>
  ): Promise<JobResult> {
    const { timer } = ctx;
    const db = getDatabase();

    // Step 1: Download video
    timer.startStep('download');
    const videoPath = await this.downloadVideo(ctx);
    timer.endStep();

    // Step 2: Get video metadata and create video record
    timer.startStep('analyze');
    await this.updateProgress(ctx.job, 'extracting', 10, 'Analyzing video', ctx.onProgress);
    const metadata = await videoService.getMetadata(videoPath);

    const [video] = await db
      .insert(schema.videos)
      .values({
        jobId: ctx.jobId,
        sourceUrl: ctx.job.videoUrl,
        localPath: videoPath,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        codec: metadata.codec,
        metadata,
      })
      .returning();
    timer.endStep();

    // Step 3: Analyze video with Gemini (AI selects best timestamps)
    timer.startStep('gemini_video_analysis');
    await this.updateProgress(ctx.job, 'classifying', 20, 'AI analyzing video', ctx.onProgress);

    const analysisResult = await timer.timeOperation(
      'gemini_video_analyze',
      () => geminiVideoAnalysisProvider.analyzeVideo(videoPath, {
        model: effectiveConfig.geminiVideoModel,
        maxFrames: effectiveConfig.geminiVideoMaxFrames,
        temperature: effectiveConfig.temperature,
        topP: effectiveConfig.topP,
      }),
      { videoPath, maxFrames: effectiveConfig.geminiVideoMaxFrames }
    );

    logger.info({
      jobId: ctx.jobId,
      selectedFrames: analysisResult.selectedFrames.length,
      products: analysisResult.products.length,
      duration: analysisResult.videoDuration,
    }, 'Gemini video analysis complete');
    timer.endStep();

    // Step 4: Extract specific frames at selected timestamps
    timer.startStep('extract_selected');
    await this.updateProgress(ctx.job, 'extracting', 40, 'Extracting selected frames', ctx.onProgress);

    const recommendedFrames = await this.extractSelectedFrames(
      ctx,
      videoPath,
      analysisResult.selectedFrames
    );
    timer.endStep();

    // Save frame records to database
    timer.startStep('save_records');
    const frameRecords = await this.saveGeminiVideoFrameRecords(ctx, video.id, recommendedFrames);
    timer.endStep();

    // Step 5: Extract products (remove background, rotate, center)
    timer.startStep('extract_product');
    const extractionResults = await this.extractProducts(ctx, recommendedFrames);
    timer.endStep();

    // Step 6: Upload final frames and generate commercial images
    timer.startStep('generate');
    const finalFrameUrls = await this.uploadFinalFrames(ctx, recommendedFrames, frameRecords);
    const commercialImages = await this.generateCommercialImages(ctx, recommendedFrames, frameRecords, extractionResults);
    timer.endStep();

    // Step 7: Complete job
    timer.startStep('complete');
    const result = await this.completeJob(
      ctx,
      recommendedFrames.length,
      analysisResult.framesAnalyzed,
      finalFrameUrls,
      commercialImages
    );
    timer.endStep();

    // Log timing summary
    timer.logSummary();

    return result;
  }

  /**
   * Extract specific frames at timestamps selected by Gemini video analysis
   */
  private async extractSelectedFrames(
    ctx: PipelineContext,
    videoPath: string,
    selectedFrames: VideoAnalysisFrame[]
  ): Promise<RecommendedFrame[]> {
    const recommendedFrames: RecommendedFrame[] = [];

    for (let i = 0; i < selectedFrames.length; i++) {
      const frame = selectedFrames[i];
      const progress = 40 + Math.round(((i + 1) / selectedFrames.length) * 20);

      await this.updateProgress(
        ctx.job,
        'extracting',
        progress,
        `Extracting frame ${i + 1}/${selectedFrames.length}`,
        ctx.onProgress
      );

      const frameId = `frame_${String(i + 1).padStart(5, '0')}`;
      const filename = `${frameId}_t${frame.timestamp.toFixed(2)}.png`;
      const outputPath = path.join(ctx.workDirs.frames, filename);

      // Extract single frame at timestamp
      await ctx.timer.timeOperation(
        'ffmpeg_extract_frame',
        () => videoService.extractSingleFrame(videoPath, frame.timestamp, outputPath),
        { timestamp: frame.timestamp, frameId }
      );

      // Convert VideoAnalysisFrame to RecommendedFrame format
      const recommendedFrame: RecommendedFrame = {
        filename,
        path: outputPath,
        index: i,
        timestamp: frame.timestamp,
        frameId,
        sharpness: 0, // Not calculated in video analysis strategy
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
      };

      recommendedFrames.push(recommendedFrame);
    }

    logger.info({
      jobId: ctx.jobId,
      frameCount: recommendedFrames.length,
    }, 'Selected frames extracted');

    return recommendedFrames;
  }

  /**
   * Save frame records for Gemini video strategy
   */
  private async saveGeminiVideoFrameRecords(
    ctx: PipelineContext,
    videoId: string,
    recommendedFrames: RecommendedFrame[]
  ): Promise<Map<string, string>> {
    const db = getDatabase();
    const frameRecords = new Map<string, string>();

    const frameValues: NewFrame[] = recommendedFrames.map((frame) => ({
      jobId: ctx.jobId,
      videoId,
      frameId: frame.frameId,
      timestamp: frame.timestamp,
      localPath: frame.path,
      scores: {
        sharpness: frame.sharpness,
        motion: frame.motion,
        combined: frame.score,
        geminiScore: frame.geminiScore,
      },
      productId: frame.productId,
      variantId: frame.variantId,
      angleEstimate: frame.angleEstimate,
      variantDescription: frame.variantDescription,
      obstructions: frame.obstructions,
      backgroundRecommendations: frame.backgroundRecommendations,
      isBestPerSecond: true, // All selected frames are "best"
      isFinalSelection: true,
    }));

    const records = await db
      .insert(schema.frames)
      .values(frameValues)
      .returning();

    for (const record of records) {
      frameRecords.set(record.frameId, record.id);
    }

    return frameRecords;
  }

  /**
   * Cleanup uploaded video from S3 if it was uploaded through our presigned URL endpoint
   */
  private async cleanupUploadedVideo(videoUrl: string): Promise<void> {
    try {
      const config = getConfig();
      const storageConfig = {
        bucket: config.storage.bucket,
        endpoint: config.storage.endpoint,
        region: config.storage.region,
      };

      // Check if this is an S3 URL from our bucket's uploads prefix
      const s3Key = extractS3KeyFromUrl(videoUrl, storageConfig, { allowAnyHost: true });

      if (s3Key && s3Key.startsWith('uploads/')) {
        await storageService.deleteFile(s3Key);
        logger.info({ s3Key }, 'Uploaded video cleaned up from S3');
      }
    } catch (error) {
      // Log but don't fail the job if cleanup fails
      logger.warn({ videoUrl, error: (error as Error).message }, 'Failed to cleanup uploaded video');
    }
  }

  /**
   * Create working directories for pipeline execution
   */
  private async createWorkDirs(jobId: string, tempDirName: string): Promise<WorkDirs> {
    const root = path.join(os.tmpdir(), tempDirName, jobId);
    const workDirs: WorkDirs = {
      root,
      video: path.join(root, 'video'),
      frames: path.join(root, 'frames'),
      candidates: path.join(root, 'candidates'),
      extracted: path.join(root, 'extracted'),
      final: path.join(root, 'final'),
      commercial: path.join(root, 'commercial'),
    };

    await Promise.all([
      mkdir(workDirs.video, { recursive: true }),
      mkdir(workDirs.frames, { recursive: true }),
      mkdir(workDirs.candidates, { recursive: true }),
      mkdir(workDirs.extracted, { recursive: true }),
      mkdir(workDirs.final, { recursive: true }),
      mkdir(workDirs.commercial, { recursive: true }),
    ]);

    return workDirs;
  }

  /**
   * Step 1: Download video from URL
   */
  private async downloadVideo(ctx: PipelineContext): Promise<string> {
    await this.updateProgress(ctx.job, 'downloading', 5, 'Downloading video', ctx.onProgress);
    const videoPath = path.join(ctx.workDirs.video, 'input.mp4');
    await storageService.downloadFromUrl(ctx.job.videoUrl, videoPath);
    return videoPath;
  }

  /**
   * Step 2: Extract frames from video
   */
  private async extractVideoFrames(
    ctx: PipelineContext,
    videoPath: string
  ): Promise<{
    video: { id: string };
    metadata: VideoMetadata;
    frames: Awaited<ReturnType<typeof videoService.extractFramesDense>>;
  }> {
    const db = getDatabase();

    await this.updateProgress(ctx.job, 'extracting', 10, 'Analyzing video', ctx.onProgress);
    const metadata = await videoService.getMetadata(videoPath);

    // Save video record
    const [video] = await db
      .insert(schema.videos)
      .values({
        jobId: ctx.jobId,
        sourceUrl: ctx.job.videoUrl,
        localPath: videoPath,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        codec: metadata.codec,
        metadata,
      } satisfies NewVideo)
      .returning();

    await this.updateProgress(ctx.job, 'extracting', 15, 'Extracting frames', ctx.onProgress);
    const frames = await videoService.extractFramesDense(videoPath, ctx.workDirs.frames, {
      fps: ctx.config.fps,
    });
    logger.info({ jobId: ctx.jobId, frameCount: frames.length }, 'Frames extracted');

    return { video, metadata, frames };
  }

  /**
   * Step 3: Score extracted frames
   */
  private async scoreFrames(
    ctx: PipelineContext,
    frames: Awaited<ReturnType<typeof videoService.extractFramesDense>>
  ): Promise<{
    scoredFrames: ScoredFrame[];
    candidateFrames: ScoredFrame[];
  }> {
    await this.updateProgress(ctx.job, 'scoring', 30, 'Scoring frames for quality', ctx.onProgress);

    const scoredFrames = await frameScoringService.scoreFrames(
      frames,
      {},
      async (current, total) => {
        const percentage = 30 + Math.round((current / total) * 15);
        await this.updateProgress(ctx.job, 'scoring', percentage, `Scoring frame ${current}/${total}`, ctx.onProgress);
      }
    );

    // Select best frame per second
    const candidateFrames = frameScoringService.selectBestFramePerSecond(scoredFrames);

    // Copy candidates to candidates directory
    await Promise.all(
      candidateFrames.map((frame) =>
        copyFile(frame.path, path.join(ctx.workDirs.candidates, frame.filename))
      )
    );

    return { scoredFrames, candidateFrames };
  }

  /**
   * Step 4: Classify frames with Gemini AI
   */
  private async classifyWithGemini(
    ctx: PipelineContext,
    candidateFrames: ScoredFrame[],
    metadata: VideoMetadata
  ): Promise<RecommendedFrame[]> {
    await this.updateProgress(ctx.job, 'classifying', 50, 'AI variant discovery', ctx.onProgress);

    const BATCH_SIZE = ctx.config.batchSize;
    const batches: ScoredFrame[][] = [];
    for (let i = 0; i < candidateFrames.length; i += BATCH_SIZE) {
      batches.push(candidateFrames.slice(i, i + BATCH_SIZE));
    }

    // Track best frame per variant
    const bestByVariant = new Map<string, { frame: RecommendedFrame; score: number }>();

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchProgress = 50 + Math.round(((batchIdx + 1) / batches.length) * 15);

      await this.updateProgress(
        ctx.job,
        'classifying',
        batchProgress,
        `Processing batch ${batchIdx + 1}/${batches.length}`,
        ctx.onProgress
      );

      const batchMetadata = frameScoringService.prepareCandidateMetadata(batch);

      try {
        // Time the Gemini API call
        const batchResult = await ctx.timer.timeOperation(
          'gemini_classify_batch',
          () => geminiService.classifyFrames(batch, batchMetadata, metadata, { model: ctx.config.geminiModel }),
          { batchIdx, batchSize: batch.length }
        );

        const batchWinners = geminiService.getRecommendedFrames(batchResult, batch);

        for (const winner of batchWinners) {
          const key = `${winner.productId}_${winner.variantId}`;
          const score = winner.geminiScore || 50;
          const existing = bestByVariant.get(key);

          if (!existing || score > existing.score) {
            bestByVariant.set(key, { frame: winner, score });
          }
        }
      } catch (error) {
        logger.error({ error, batchIdx, jobId: ctx.jobId }, 'Batch classification failed');
      }
    }

    return [...bestByVariant.values()].map((v) => v.frame);
  }

  /**
   * Save frame records to database
   * Uses batch insert for better performance
   */
  private async saveFrameRecords(
    ctx: PipelineContext,
    videoId: string,
    scoredFrames: ScoredFrame[],
    candidateFrames: ScoredFrame[],
    recommendedFrames: RecommendedFrame[]
  ): Promise<Map<string, string>> {
    const db = getDatabase();
    const frameRecords = new Map<string, string>(); // frameId -> db id

    // Build candidate and recommended lookup sets for O(1) access
    const candidateSet = new Set(candidateFrames.map((c) => c.frameId));
    const recommendedMap = new Map(recommendedFrames.map((r) => [r.frameId, r]));

    // Prepare all frame values for batch insert
    const frameValues: NewFrame[] = scoredFrames.map((frame) => {
      const recommended = recommendedMap.get(frame.frameId);
      return {
        jobId: ctx.jobId,
        videoId,
        frameId: frame.frameId,
        timestamp: frame.timestamp,
        localPath: frame.path,
        scores: frameScoringService.toFrameScores(frame),
        productId: recommended?.productId,
        variantId: recommended?.variantId,
        angleEstimate: recommended?.angleEstimate,
        variantDescription: recommended?.variantDescription,
        obstructions: recommended?.obstructions,
        backgroundRecommendations: recommended?.backgroundRecommendations,
        isBestPerSecond: candidateSet.has(frame.frameId),
        isFinalSelection: !!recommended,
      } satisfies NewFrame;
    });

    // Batch insert all frames at once
    const records = await db
      .insert(schema.frames)
      .values(frameValues)
      .returning();

    // Map frameId to database id
    for (const record of records) {
      frameRecords.set(record.frameId, record.id);
    }

    return frameRecords;
  }

  /**
   * Step 5: Extract products (remove background, rotate, center)
   */
  private async extractProducts(
    ctx: PipelineContext,
    recommendedFrames: RecommendedFrame[]
  ): Promise<Map<string, ProductExtractionResult>> {
    await this.updateProgress(ctx.job, 'extracting_product', 65, 'Extracting products', ctx.onProgress);

    const hasObstructions = recommendedFrames.some((f) => f.obstructions?.has_obstruction);
    const useAIEdit = ctx.config.aiCleanup && hasObstructions;

    // Get product extraction provider from registry (supports A/B testing via jobId seed)
    const { provider, providerId, abTestId } = providerRegistry.get('productExtraction', undefined, ctx.jobId);
    logger.info({ providerId, abTestId, jobId: ctx.jobId }, 'Using product extraction provider');

    // Map RecommendedFrame to ExtractionFrame interface
    const extractionFrames = recommendedFrames.map((frame) => ({
      frameId: frame.frameId,
      path: frame.path,
      rotationAngleDeg: frame.rotationAngleDeg || 0,
      obstructions: frame.obstructions,
      recommendedType: frame.recommendedType,
    }));

    // Time the entire product extraction (includes Photoroom API calls)
    const results = await ctx.timer.timeOperation(
      'product_extraction_all',
      () => provider.extractProducts(
        extractionFrames,
        ctx.workDirs.extracted,
        {
          useAIEdit,
          onProgress: async (current, total) => {
            const percentage = 65 + Math.round((current / total) * 5);
            await this.updateProgress(
              ctx.job,
              'extracting_product',
              percentage,
              `Extracting product ${current}/${total}`,
              ctx.onProgress
            );
          },
        }
      ),
      { frameCount: extractionFrames.length, useAIEdit, providerId }
    );

    const successCount = [...results.values()].filter((r) => r.success).length;
    logger.info(
      { jobId: ctx.jobId, total: recommendedFrames.length, success: successCount, providerId },
      'Product extraction complete'
    );

    return results;
  }

  /**
   * Upload final selected frames to S3
   */
  private async uploadFinalFrames(
    ctx: PipelineContext,
    recommendedFrames: RecommendedFrame[],
    frameRecords: Map<string, string>
  ): Promise<string[]> {
    const db = getDatabase();

    await this.updateProgress(ctx.job, 'generating', 70, 'Preparing final frames', ctx.onProgress);

    const finalFrameUrls: string[] = [];

    for (const frame of recommendedFrames) {
      const outputFilename = `${frame.recommendedType}_${frame.frameId}_t${frame.timestamp.toFixed(2)}.png`;
      const localPath = path.join(ctx.workDirs.final, outputFilename);
      await copyFile(frame.path, localPath);

      const s3Key = storageService.getJobKey(ctx.jobId, 'frames', outputFilename);
      // Time S3 upload for final frame
      const { url } = await ctx.timer.timeOperation(
        's3_upload_frame',
        () => storageService.uploadFile(localPath, s3Key),
        { frameId: frame.frameId }
      );
      finalFrameUrls.push(url);

      // Update frame record with S3 URL
      const frameDbId = frameRecords.get(frame.frameId);
      if (frameDbId) {
        await db
          .update(schema.frames)
          .set({ s3Url: url })
          .where(eq(schema.frames.id, frameDbId));
      }
    }

    return finalFrameUrls;
  }

  /**
   * Generate commercial images using Photoroom
   */
  private async generateCommercialImages(
    ctx: PipelineContext,
    recommendedFrames: RecommendedFrame[],
    frameRecords: Map<string, string>,
    extractionResults: Map<string, ProductExtractionResult>
  ): Promise<Record<string, Record<string, string>>> {
    const db = getDatabase();

    await this.updateProgress(ctx.job, 'generating', 75, 'Generating commercial images', ctx.onProgress);

    const commercialImages: Record<string, Record<string, string>> = {};

    for (let i = 0; i < recommendedFrames.length; i++) {
      const frame = recommendedFrames[i];
      const progress = 75 + Math.round(((i + 1) / recommendedFrames.length) * 20);

      await this.updateProgress(
        ctx.job,
        'generating',
        progress,
        `Generating images for ${frame.recommendedType}`,
        ctx.onProgress
      );

      try {
        // Use pre-extracted product if available
        const extraction = extractionResults.get(frame.frameId);
        const hasExtractedProduct = !!(extraction?.success && extraction.outputPath);

        // Time Photoroom API call for commercial image generation
        const result = await ctx.timer.timeOperation(
          'photoroom_generate_versions',
          () => photoroomService.generateAllVersions(frame, ctx.workDirs.commercial, {
            versions: ctx.config.commercialVersions,
            transparentSource: hasExtractedProduct ? extraction.outputPath : undefined,
            skipTransparent: hasExtractedProduct,
          }),
          { frameId: frame.frameId, versions: ctx.config.commercialVersions }
        );

        const variantImages: Record<string, string> = {};
        const frameDbId = frameRecords.get(frame.frameId);

        // If we have a pre-extracted product, use it as the transparent version
        if (hasExtractedProduct && ctx.config.commercialVersions.includes('transparent')) {
          const s3Key = storageService.getJobKey(
            ctx.jobId,
            'commercial',
            path.basename(extraction.outputPath!)
          );
          // Time S3 upload
          const { url } = await ctx.timer.timeOperation(
            's3_upload_commercial',
            () => storageService.uploadFile(extraction.outputPath!, s3Key),
            { version: 'transparent' }
          );
          variantImages.transparent = url;

          if (frameDbId) {
            await db.insert(schema.commercialImages).values({
              jobId: ctx.jobId,
              frameId: frameDbId,
              version: 'transparent',
              localPath: extraction.outputPath,
              s3Url: url,
              success: true,
            } satisfies NewCommercialImage);
          }
        }

        for (const [version, versionResult] of Object.entries(result.versions)) {
          if (versionResult.success && versionResult.outputPath) {
            const s3Key = storageService.getJobKey(
              ctx.jobId,
              'commercial',
              path.basename(versionResult.outputPath)
            );
            // Time S3 upload
            const { url } = await ctx.timer.timeOperation(
              's3_upload_commercial',
              () => storageService.uploadFile(versionResult.outputPath!, s3Key),
              { version }
            );
            variantImages[version] = url;

            // Save commercial image record
            if (frameDbId) {
              await db.insert(schema.commercialImages).values({
                jobId: ctx.jobId,
                frameId: frameDbId,
                version,
                localPath: versionResult.outputPath,
                s3Url: url,
                backgroundColor: versionResult.bgColor,
                backgroundPrompt: versionResult.bgPrompt,
                success: true,
              } satisfies NewCommercialImage);
            }
          } else if (frameDbId) {
            await db.insert(schema.commercialImages).values({
              jobId: ctx.jobId,
              frameId: frameDbId,
              version,
              success: false,
              error: versionResult.error,
            } satisfies NewCommercialImage);
          }
        }

        commercialImages[frame.recommendedType] = variantImages;
      } catch (error) {
        logger.error({ error, frame: frame.recommendedType, jobId: ctx.jobId }, 'Commercial generation failed');
      }
    }

    return commercialImages;
  }

  /**
   * Complete the job and save results
   */
  private async completeJob(
    ctx: PipelineContext,
    variantsDiscovered: number,
    framesAnalyzed: number,
    finalFrameUrls: string[],
    commercialImages: Record<string, Record<string, string>>
  ): Promise<JobResult> {
    const db = getDatabase();

    await this.updateProgress(ctx.job, 'completed', 100, 'Pipeline completed', ctx.onProgress);

    const result: JobResult = {
      variantsDiscovered,
      framesAnalyzed,
      finalFrames: finalFrameUrls,
      commercialImages,
    };

    // Update job with result
    await db
      .update(schema.jobs)
      .set({
        status: 'completed',
        result,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, ctx.jobId));

    logger.info({ jobId: ctx.jobId, variantsDiscovered: result.variantsDiscovered }, 'Pipeline completed');

    return result;
  }

  /**
   * Handle pipeline error
   */
  private async handlePipelineError(ctx: PipelineContext, error: Error): Promise<void> {
    const db = getDatabase();

    logger.error({
      jobId: ctx.jobId,
      errorMessage: error.message,
      errorStack: error.stack,
      errorName: error.name,
    }, 'Pipeline failed');

    await db
      .update(schema.jobs)
      .set({
        status: 'failed',
        error: error.message,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, ctx.jobId));
  }

  /**
   * Update job progress
   */
  private async updateProgress(
    job: Job,
    status: JobStatus,
    percentage: number,
    message: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const db = getDatabase();

    const progress: JobProgress = {
      step: status,
      percentage,
      message,
      totalSteps: 7,
      currentStep: this.getStepNumber(status),
    };

    await db
      .update(schema.jobs)
      .set({
        status,
        progress,
        updatedAt: new Date(),
        startedAt: status === 'downloading' ? new Date() : undefined,
      })
      .where(eq(schema.jobs.id, job.id));

    if (onProgress) {
      await onProgress({
        status,
        percentage,
        message,
        step: progress.currentStep,
        totalSteps: progress.totalSteps,
      });
    }
  }

  /**
   * Get step number for status
   */
  private getStepNumber(status: JobStatus): number {
    const steps: Record<string, number> = {
      pending: 0,
      downloading: 1,
      extracting: 2,
      scoring: 3,
      classifying: 4,
      extracting_product: 5,
      generating: 6,
      completed: 7,
      failed: -1,
      cancelled: -1,
    };
    return steps[status] || 0;
  }
}

export const pipelineService = new PipelineService();

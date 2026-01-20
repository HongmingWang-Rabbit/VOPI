import { mkdir, rm, copyFile } from 'fs/promises';
import path from 'path';
import os from 'os';

import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { videoService } from './video.service.js';
import { frameScoringService, type ScoredFrame } from './frame-scoring.service.js';
import { geminiService, type RecommendedFrame } from './gemini.service.js';
import { photoroomService } from './photoroom.service.js';
import { storageService } from './storage.service.js';
import type { Job, NewVideo, NewFrame, NewCommercialImage } from '../db/schema.js';
import { jobConfigSchema, type JobStatus, type JobProgress, type JobResult, type JobConfig } from '../types/job.types.js';
import type { VideoMetadata } from '../types/job.types.js';

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

    // Create temp working directories
    const workDirs = await this.createWorkDirs(jobId, appConfig.worker.tempDirName);

    const ctx: PipelineContext = {
      job,
      jobId,
      config,
      workDirs,
      onProgress,
    };

    try {
      // Step 1: Download video
      const videoPath = await this.downloadVideo(ctx);

      // Step 2: Extract and analyze video
      const { video, metadata, frames } = await this.extractVideoFrames(ctx, videoPath);

      // Step 3: Score frames
      const { scoredFrames, candidateFrames } = await this.scoreFrames(ctx, frames);

      // Step 4: Classify with Gemini
      const recommendedFrames = await this.classifyWithGemini(ctx, candidateFrames, metadata);

      // Save frame records to database
      const frameRecords = await this.saveFrameRecords(ctx, video.id, scoredFrames, candidateFrames, recommendedFrames);

      // Step 5: Upload final frames and generate commercial images
      const finalFrameUrls = await this.uploadFinalFrames(ctx, recommendedFrames, frameRecords);
      const commercialImages = await this.generateCommercialImages(ctx, recommendedFrames, frameRecords);

      // Step 6: Complete job
      const result = await this.completeJob(ctx, recommendedFrames.length, candidateFrames.length, finalFrameUrls, commercialImages);

      return result;
    } catch (error) {
      await this.handlePipelineError(ctx, error as Error);
      throw error;
    } finally {
      // Cleanup temp directory
      await rm(workDirs.root, { recursive: true, force: true }).catch(() => {});

      // Cleanup uploaded video from S3 if it was uploaded through our presigned URL endpoint
      await this.cleanupUploadedVideo(ctx.job.videoUrl);
    }
  }

  /**
   * Cleanup uploaded video from S3 if it was uploaded through our presigned URL endpoint
   */
  private async cleanupUploadedVideo(videoUrl: string): Promise<void> {
    try {
      const config = getConfig();

      // Check if this is an S3 URL from our bucket's uploads prefix
      const s3Key = this.extractS3KeyFromUrl(videoUrl, config.storage);

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
   * Extract S3 key from URL if it matches our bucket
   */
  private extractS3KeyFromUrl(
    url: string,
    storageConfig: { bucket: string; endpoint?: string; region: string }
  ): string | null {
    // Handle S3 protocol URLs: s3://bucket/key
    if (url.startsWith('s3://')) {
      const match = url.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (match && match[1] === storageConfig.bucket) {
        return match[2];
      }
      return null;
    }

    // Handle HTTP URLs from our bucket
    // Custom endpoint (MinIO): http://endpoint/bucket/key
    if (storageConfig.endpoint) {
      const endpoint = storageConfig.endpoint.replace(/\/$/, '');
      const pathStylePattern = new RegExp(`^${endpoint}/${storageConfig.bucket}/(.+)$`);
      const match = url.match(pathStylePattern);
      if (match) {
        return match[1];
      }
    }

    // AWS S3: https://bucket.s3.region.amazonaws.com/key
    const awsPattern = new RegExp(
      `^https?://${storageConfig.bucket}\\.s3\\.${storageConfig.region}\\.amazonaws\\.com/(.+)$`
    );
    const awsMatch = url.match(awsPattern);
    if (awsMatch) {
      return awsMatch[1];
    }

    return null;
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
      final: path.join(root, 'final'),
      commercial: path.join(root, 'commercial'),
    };

    await Promise.all([
      mkdir(workDirs.video, { recursive: true }),
      mkdir(workDirs.frames, { recursive: true }),
      mkdir(workDirs.candidates, { recursive: true }),
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
        const batchResult = await geminiService.classifyFrames(
          batch,
          batchMetadata,
          metadata,
          { model: ctx.config.geminiModel }
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

    for (const frame of scoredFrames) {
      const recommended = recommendedFrames.find((r) => r.frameId === frame.frameId);
      const isCandidate = candidateFrames.some((c) => c.frameId === frame.frameId);

      const [record] = await db
        .insert(schema.frames)
        .values({
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
          isBestPerSecond: isCandidate,
          isFinalSelection: !!recommended,
        } satisfies NewFrame)
        .returning();

      frameRecords.set(frame.frameId, record.id);
    }

    return frameRecords;
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
      const { url } = await storageService.uploadFile(localPath, s3Key);
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
    frameRecords: Map<string, string>
  ): Promise<Record<string, Record<string, string>>> {
    const db = getDatabase();

    await this.updateProgress(ctx.job, 'generating', 75, 'Generating commercial images', ctx.onProgress);

    const commercialImages: Record<string, Record<string, string>> = {};
    const hasObstructions = recommendedFrames.some((f) => f.obstructions?.has_obstruction);
    const useAIEdit = ctx.config.aiCleanup && hasObstructions;

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
        const result = await photoroomService.generateAllVersions(frame, ctx.workDirs.commercial, {
          useAIEdit,
          versions: ctx.config.commercialVersions,
        });

        const variantImages: Record<string, string> = {};
        const frameDbId = frameRecords.get(frame.frameId);

        for (const [version, versionResult] of Object.entries(result.versions)) {
          if (versionResult.success && versionResult.outputPath) {
            const s3Key = storageService.getJobKey(
              ctx.jobId,
              'commercial',
              path.basename(versionResult.outputPath)
            );
            const { url } = await storageService.uploadFile(versionResult.outputPath, s3Key);
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
      totalSteps: 6,
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
      generating: 5,
      completed: 6,
      failed: -1,
      cancelled: -1,
    };
    return steps[status] || 0;
  }
}

export const pipelineService = new PipelineService();

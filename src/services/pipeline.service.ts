import { mkdir, rm, copyFile } from 'fs/promises';
import path from 'path';
import os from 'os';

import { createChildLogger } from '../utils/logger.js';
import { getDatabase, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { videoService } from './video.service.js';
import { frameScoringService, type ScoredFrame } from './frame-scoring.service.js';
import { geminiService, type RecommendedFrame } from './gemini.service.js';
import { photoroomService } from './photoroom.service.js';
import { storageService } from './storage.service.js';
import type { Job, NewVideo, NewFrame, NewCommercialImage } from '../db/schema.js';
import type { JobStatus, JobProgress, JobResult, JobConfig } from '../types/job.types.js';

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
    const db = getDatabase();
    const config = job.config as JobConfig;
    const jobId = job.id;

    // Create temp working directory
    const workDir = path.join(os.tmpdir(), 'vopi', jobId);
    const videoDir = path.join(workDir, 'video');
    const framesDir = path.join(workDir, 'frames');
    const candidatesDir = path.join(workDir, 'candidates');
    const finalDir = path.join(workDir, 'final');
    const commercialDir = path.join(workDir, 'commercial');

    await mkdir(videoDir, { recursive: true });
    await mkdir(framesDir, { recursive: true });
    await mkdir(candidatesDir, { recursive: true });
    await mkdir(finalDir, { recursive: true });
    await mkdir(commercialDir, { recursive: true });

    try {
      // Step 1: Download video
      await this.updateProgress(job, 'downloading', 5, 'Downloading video', onProgress);
      const videoPath = path.join(videoDir, 'input.mp4');
      await storageService.downloadFromUrl(job.videoUrl, videoPath);

      // Step 2: Get metadata and extract frames
      await this.updateProgress(job, 'extracting', 10, 'Analyzing video', onProgress);
      const metadata = await videoService.getMetadata(videoPath);

      // Save video record
      const [video] = await db
        .insert(schema.videos)
        .values({
          jobId,
          sourceUrl: job.videoUrl,
          localPath: videoPath,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          fps: metadata.fps,
          codec: metadata.codec,
          metadata,
        } satisfies NewVideo)
        .returning();

      await this.updateProgress(job, 'extracting', 15, 'Extracting frames', onProgress);
      const frames = await videoService.extractFramesDense(videoPath, framesDir, {
        fps: config.fps,
      });
      logger.info({ jobId, frameCount: frames.length }, 'Frames extracted');

      // Step 3: Score frames
      await this.updateProgress(job, 'scoring', 30, 'Scoring frames for quality', onProgress);
      const scoredFrames = await frameScoringService.scoreFrames(
        frames,
        {},
        async (current, total) => {
          const percentage = 30 + Math.round((current / total) * 15);
          await this.updateProgress(job, 'scoring', percentage, `Scoring frame ${current}/${total}`, onProgress);
        }
      );

      // Select best frame per second
      const candidateFrames = frameScoringService.selectBestFramePerSecond(scoredFrames);

      // Copy candidates
      for (const frame of candidateFrames) {
        await copyFile(frame.path, path.join(candidatesDir, frame.filename));
      }

      // Step 4: Gemini classification
      await this.updateProgress(job, 'classifying', 50, 'AI variant discovery', onProgress);

      const BATCH_SIZE = config.batchSize;
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
          job,
          'classifying',
          batchProgress,
          `Processing batch ${batchIdx + 1}/${batches.length}`,
          onProgress
        );

        const batchMetadata = frameScoringService.prepareCandidateMetadata(batch);

        try {
          const batchResult = await geminiService.classifyFrames(
            batch,
            batchMetadata,
            metadata,
            { model: config.geminiModel }
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
          logger.error({ error, batchIdx, jobId }, 'Batch classification failed');
        }
      }

      // Collect recommended frames
      const recommendedFrames = [...bestByVariant.values()].map((v) => v.frame);

      // Save frame records
      const frameRecords: Map<string, string> = new Map(); // frameId -> db id
      for (const frame of scoredFrames) {
        const recommended = recommendedFrames.find((r) => r.frameId === frame.frameId);
        const isCandidate = candidateFrames.some((c) => c.frameId === frame.frameId);

        const [record] = await db
          .insert(schema.frames)
          .values({
            jobId,
            videoId: video.id,
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

      // Copy final frames and upload to S3
      await this.updateProgress(job, 'generating', 70, 'Preparing final frames', onProgress);

      const finalFrameUrls: string[] = [];
      for (const frame of recommendedFrames) {
        const outputFilename = `${frame.recommendedType}_${frame.frameId}_t${frame.timestamp.toFixed(2)}.png`;
        const localPath = path.join(finalDir, outputFilename);
        await copyFile(frame.path, localPath);

        const s3Key = storageService.getJobKey(jobId, 'frames', outputFilename);
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

      // Step 5: Generate commercial images
      await this.updateProgress(job, 'generating', 75, 'Generating commercial images', onProgress);

      const commercialImages: Record<string, Record<string, string>> = {};
      const hasObstructions = recommendedFrames.some((f) => f.obstructions?.has_obstruction);
      const useAIEdit = config.aiCleanup && hasObstructions;

      for (let i = 0; i < recommendedFrames.length; i++) {
        const frame = recommendedFrames[i];
        const progress = 75 + Math.round(((i + 1) / recommendedFrames.length) * 20);

        await this.updateProgress(
          job,
          'generating',
          progress,
          `Generating images for ${frame.recommendedType}`,
          onProgress
        );

        try {
          const result = await photoroomService.generateAllVersions(frame, commercialDir, {
            useAIEdit,
            versions: config.commercialVersions,
          });

          const variantImages: Record<string, string> = {};
          const frameDbId = frameRecords.get(frame.frameId);

          for (const [version, versionResult] of Object.entries(result.versions)) {
            if (versionResult.success && versionResult.outputPath) {
              const s3Key = storageService.getJobKey(
                jobId,
                'commercial',
                path.basename(versionResult.outputPath)
              );
              const { url } = await storageService.uploadFile(versionResult.outputPath, s3Key);
              variantImages[version] = url;

              // Save commercial image record
              if (frameDbId) {
                await db.insert(schema.commercialImages).values({
                  jobId,
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
                jobId,
                frameId: frameDbId,
                version,
                success: false,
                error: versionResult.error,
              } satisfies NewCommercialImage);
            }
          }

          commercialImages[frame.recommendedType] = variantImages;
        } catch (error) {
          logger.error({ error, frame: frame.recommendedType, jobId }, 'Commercial generation failed');
        }
      }

      // Step 6: Complete
      await this.updateProgress(job, 'completed', 100, 'Pipeline completed', onProgress);

      const result: JobResult = {
        variantsDiscovered: recommendedFrames.length,
        framesAnalyzed: candidateFrames.length,
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
        .where(eq(schema.jobs.id, jobId));

      logger.info({ jobId, variantsDiscovered: result.variantsDiscovered }, 'Pipeline completed');

      return result;
    } catch (error) {
      const err = error as Error;
      logger.error({
        jobId,
        errorMessage: err.message,
        errorStack: err.stack,
        errorName: err.name,
      }, 'Pipeline failed');

      await db
        .update(schema.jobs)
        .set({
          status: 'failed',
          error: err.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, jobId));

      throw error;
    } finally {
      // Cleanup temp directory
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
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

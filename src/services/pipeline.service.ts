import { mkdir, rm } from 'fs/promises';
import path from 'path';
import os from 'os';

import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { extractS3KeyFromUrl } from '../utils/s3-url.js';
import { PipelineTimer } from '../utils/timer.js';
import { getDatabase, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { globalConfigService } from './global-config.service.js';
import { storageService } from './storage.service.js';
import type { Job } from '../db/schema.js';
import { jobConfigSchema, type JobStatus, type JobResult, type StackConfig } from '../types/job.types.js';
import {
  stackRunner,
  getStackTemplate,
  getDefaultStackId,
  type ProcessorContext,
  type WorkDirs,
  type PipelineData,
} from '../processors/index.js';

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
 * PipelineService - Orchestrates the full extraction pipeline using composable processor stacks
 */
export class PipelineService {
  /**
   * Run the complete pipeline for a job
   *
   * Uses the composable processor stack architecture for flexible, modular execution.
   *
   * @param job - Job to process
   * @param onProgress - Progress callback
   * @param stackConfig - Optional stack configuration overrides
   * @param initialData - Optional initial pipeline data (for stacks that don't start with download)
   */
  async runPipeline(
    job: Job,
    onProgress?: ProgressCallback,
    stackConfig?: StackConfig,
    initialData?: PipelineData
  ): Promise<JobResult> {
    // Validate and parse config with defaults
    const config = jobConfigSchema.parse(job.config || {});
    const appConfig = getConfig();
    const jobId = job.id;

    // Get effective config from database
    const effectiveConfig = await globalConfigService.getEffectiveConfig();

    // Determine stack to use
    const stackId = stackConfig?.stackId || config.stack?.stackId || getDefaultStackId(effectiveConfig.pipelineStrategy);
    const stack = getStackTemplate(stackId);

    if (!stack) {
      throw new Error(`Stack template '${stackId}' not found`);
    }

    // Merge stack configs (job config takes precedence)
    const mergedStackConfig: StackConfig = {
      ...config.stack,
      ...stackConfig,
      processorSwaps: {
        ...config.stack?.processorSwaps,
        ...stackConfig?.processorSwaps,
      },
      processorOptions: {
        ...config.stack?.processorOptions,
        ...stackConfig?.processorOptions,
      },
    };

    // Create timer for performance tracking
    const timer = new PipelineTimer(jobId);

    // Create temp working directories
    const workDirs = await this.createWorkDirs(jobId, appConfig.worker.tempDirName);

    // Create processor context
    const processorContext: ProcessorContext = {
      job,
      jobId,
      config,
      workDirs,
      onProgress,
      timer,
      effectiveConfig,
    };

    if (effectiveConfig.debugEnabled) {
      logger.warn({ jobId }, 'Debug mode active - temp files and S3 uploads will NOT be cleaned up');
    }
    // Prepare initial data - inject job.videoUrl if not already provided
    const preparedInitialData: PipelineData = {
      ...initialData,
    };

    // If job has a videoUrl and initialData doesn't have video.sourceUrl, inject it
    if (job.videoUrl && !initialData?.video?.sourceUrl) {
      preparedInitialData.video = {
        ...initialData?.video,
        sourceUrl: job.videoUrl,
      };
    }

    logger.info({
      jobId,
      stackId: stack.id,
      stackName: stack.name,
      processorSwaps: mergedStackConfig.processorSwaps,
      debugEnabled: effectiveConfig.debugEnabled,
      hasInitialVideo: !!preparedInitialData.video?.sourceUrl,
    }, 'Starting pipeline with stack');

    try {
      // Execute stack
      const pipelineData = await stackRunner.execute(
        stack,
        processorContext,
        mergedStackConfig,
        preparedInitialData
      );

      // Extract result from pipeline data
      const result: JobResult = (pipelineData.metadata?.result as JobResult) || {
        variantsDiscovered: pipelineData.recommendedFrames?.length || 0,
        framesAnalyzed: pipelineData.candidateFrames?.length || pipelineData.frames?.length || 0,
        finalFrames: pipelineData.uploadedUrls || [],
        commercialImages: (pipelineData.metadata?.commercialImageUrls as Record<string, Record<string, string>>) || {},
      };

      // Log timing summary
      timer.logSummary();

      // Cleanup uploaded video on success
      if (effectiveConfig.debugEnabled) {
        logger.info({ jobId, videoUrl: job.videoUrl }, 'Debug mode: Skipping S3 video cleanup');
      } else {
        await this.cleanupUploadedVideo(job.videoUrl);
      }

      return result;
    } catch (error) {
      timer.logSummary();
      await this.handlePipelineError(jobId, error as Error);
      throw error;
    } finally {
      // Cleanup temp directory
      if (effectiveConfig.debugEnabled) {
        logger.info({ jobId, tempDir: workDirs.root }, 'Debug mode: Preserving temp directory for inspection');
      } else {
        await rm(workDirs.root, { recursive: true, force: true }).catch(() => {});
      }
    }
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
   * Handle pipeline error
   */
  private async handlePipelineError(jobId: string, error: Error): Promise<void> {
    const db = getDatabase();

    logger.error({
      jobId,
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
      .where(eq(schema.jobs.id, jobId));
  }

}

export const pipelineService = new PipelineService();

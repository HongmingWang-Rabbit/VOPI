import { Worker, type Job as BullJob } from 'bullmq';
import { getRedis } from '../queues/redis.js';
import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { pipelineService } from '../services/pipeline.service.js';
import type { PipelineJobData } from '../queues/pipeline.queue.js';

const logger = createChildLogger({ service: 'pipeline-worker' });

const QUEUE_NAME = 'pipeline';

let worker: Worker<PipelineJobData> | null = null;

/**
 * Process pipeline job
 */
async function processJob(bullJob: BullJob<PipelineJobData>): Promise<void> {
  const { jobId } = bullJob.data;
  const db = getDatabase();

  logger.info({ jobId, bullJobId: bullJob.id }, 'Processing pipeline job');

  // Get job from database
  const [job] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);

  if (!job) {
    logger.error({ jobId }, 'Job not found in database');
    throw new Error(`Job ${jobId} not found`);
  }

  // Check if job is already processed or cancelled
  if (job.status === 'completed' || job.status === 'cancelled') {
    logger.info({ jobId, status: job.status }, 'Job already processed, skipping');
    return;
  }

  // Run pipeline
  await pipelineService.runPipeline(job, async (progress) => {
    await bullJob.updateProgress(progress.percentage);
    logger.debug({ jobId, ...progress }, 'Pipeline progress');
  });

  // Send callback if configured
  if (job.callbackUrl) {
    try {
      const [updatedJob] = await db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, jobId))
        .limit(1);

      await fetch(job.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          status: updatedJob?.status,
          result: updatedJob?.result,
        }),
      });

      logger.info({ jobId, callbackUrl: job.callbackUrl }, 'Callback sent');
    } catch (error) {
      logger.error({ error, jobId, callbackUrl: job.callbackUrl }, 'Callback failed');
    }
  }
}

/**
 * Start pipeline worker
 */
export function startPipelineWorker(): Worker<PipelineJobData> {
  if (worker) {
    return worker;
  }

  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const config = getConfig();

  worker = new Worker<PipelineJobData>(QUEUE_NAME, processJob, {
    connection: redis,
    concurrency: config.worker.concurrency,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 1000 },
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.data.jobId, bullJobId: job.id }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { error, jobId: job?.data.jobId, bullJobId: job?.id },
      'Job failed'
    );
  });

  worker.on('error', (error) => {
    logger.error({ error }, 'Worker error');
  });

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId }, 'Job stalled');
  });

  logger.info(
    { queueName: QUEUE_NAME, concurrency: config.worker.concurrency },
    'Pipeline worker started'
  );

  return worker;
}

/**
 * Stop pipeline worker
 */
export async function stopPipelineWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Pipeline worker stopped');
  }
}

/**
 * Get worker instance
 */
export function getPipelineWorker(): Worker<PipelineJobData> | null {
  return worker;
}

import { Worker, type Job as BullJob } from 'bullmq';
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
    await sendCallbackWithRetry(jobId, job.callbackUrl, db);
  }
}

/**
 * Send callback with timeout and retry logic
 */
async function sendCallbackWithRetry(
  jobId: string,
  callbackUrl: string,
  db: ReturnType<typeof getDatabase>
): Promise<void> {
  const config = getConfig();
  const { callbackTimeoutMs, callbackMaxRetries, apiRetryDelayMs } = config.worker;

  const [updatedJob] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);

  const payload = JSON.stringify({
    jobId,
    status: updatedJob?.status,
    result: updatedJob?.result,
  });

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= callbackMaxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), callbackTimeoutMs);

      try {
        const response = await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Callback returned status ${response.status}`);
        }

        logger.info({ jobId, callbackUrl, attempt }, 'Callback sent successfully');
        return;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      lastError = error as Error;
      const isAbortError = (error as Error).name === 'AbortError';
      const errorMessage = isAbortError ? 'Callback timed out' : (error as Error).message;

      logger.warn(
        { jobId, callbackUrl, attempt, maxRetries: callbackMaxRetries, error: errorMessage },
        'Callback attempt failed'
      );

      if (attempt < callbackMaxRetries) {
        const delay = apiRetryDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  logger.error(
    { jobId, callbackUrl, error: lastError?.message, attempts: callbackMaxRetries },
    'Callback failed after all retries'
  );
}

/**
 * Start pipeline worker
 */
export function startPipelineWorker(): Worker<PipelineJobData> {
  if (worker) {
    return worker;
  }

  const config = getConfig();

  worker = new Worker<PipelineJobData>(QUEUE_NAME, processJob, {
    connection: { url: config.redis.url },
    concurrency: config.worker.concurrency,
    removeOnComplete: { count: config.queue.completedCount },
    removeOnFail: { count: config.queue.failedCount },
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.data.jobId, bullJobId: job.id }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error(
      {
        jobId: job?.data.jobId,
        bullJobId: job?.id,
        errorMessage: error?.message,
        errorStack: error?.stack,
        errorName: error?.name,
      },
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

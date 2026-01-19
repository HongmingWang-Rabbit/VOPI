import { Queue, type JobsOptions } from 'bullmq';
import { getRedis } from './redis.js';
import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';

const logger = createChildLogger({ service: 'pipeline-queue' });

const QUEUE_NAME = 'pipeline';

let queue: Queue | null = null;

export interface PipelineJobData {
  jobId: string;
}

/**
 * Initialize pipeline queue
 */
export function initPipelineQueue(): Queue<PipelineJobData> {
  if (queue) {
    return queue;
  }

  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  queue = new Queue<PipelineJobData>(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 3600, // 24 hours
      },
      removeOnFail: {
        count: 1000,
        age: 7 * 24 * 3600, // 7 days
      },
    },
  });

  logger.info({ queueName: QUEUE_NAME }, 'Pipeline queue initialized');

  return queue;
}

/**
 * Get pipeline queue
 */
export function getPipelineQueue(): Queue<PipelineJobData> | null {
  return queue;
}

/**
 * Add a job to the pipeline queue
 */
export async function addPipelineJob(
  jobId: string,
  options: JobsOptions = {}
): Promise<void> {
  const q = initPipelineQueue();
  const config = getConfig();

  await q.add(
    'process',
    { jobId },
    {
      jobId, // Use job ID as BullMQ job ID for deduplication
      ...options,
      timeout: config.worker.jobTimeoutMs,
    }
  );

  logger.info({ jobId }, 'Job added to pipeline queue');
}

/**
 * Close pipeline queue
 */
export async function closePipelineQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
    logger.info('Pipeline queue closed');
  }
}

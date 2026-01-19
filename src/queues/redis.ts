import { Redis } from 'ioredis';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

let redis: Redis | null = null;

/**
 * Initialize Redis connection
 */
export function initRedis(): Redis {
  if (redis) {
    return redis;
  }

  const config = getConfig();
  const logger = getLogger();

  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: true,
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.error('Redis connection failed after 10 retries');
        return null;
      }
      return Math.min(times * 100, 3000);
    },
  });

  redis.on('connect', () => {
    logger.info('Redis connection established');
  });

  redis.on('error', (error: Error) => {
    logger.error({ error }, 'Redis connection error');
  });

  redis.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return redis;
}

/**
 * Get Redis instance (must be initialized first)
 */
export function getRedis(): Redis | null {
  return redis;
}

/**
 * Close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    getLogger().info('Redis connection closed');
  }
}

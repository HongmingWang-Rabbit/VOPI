import 'dotenv/config';

import { parseEnv } from '../config/env.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { initDatabase, closeDatabase } from '../db/index.js';
import { initRedis, closeRedis } from '../queues/redis.js';
import { startPipelineWorker, stopPipelineWorker } from './pipeline.worker.js';

/**
 * Worker entry point
 */
async function main(): Promise<void> {
  // Validate environment first
  parseEnv();

  const config = getConfig();
  const logger = getLogger();

  logger.info({ env: config.server.env }, 'Starting VOPI worker');

  // Initialize connections
  await initDatabase();
  initRedis();

  // Start worker
  startPipelineWorker();

  logger.info(
    { concurrency: config.worker.concurrency },
    'Worker started successfully'
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await stopPipelineWorker();
      await closeRedis();
      await closeDatabase();
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

import 'dotenv/config';

import { parseEnv } from '../config/env.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { initDatabase, closeDatabase } from '../db/index.js';
import { initRedis, closeRedis } from '../queues/redis.js';
import { startPipelineWorker, stopPipelineWorker } from './pipeline.worker.js';
import { videoService } from '../services/video.service.js';
import { setupDefaultProviders } from '../providers/setup.js';

/**
 * Worker entry point
 */
async function main(): Promise<void> {
  // Validate environment first
  parseEnv();

  const config = getConfig();
  const logger = getLogger();

  logger.info({ env: config.server.env }, 'Starting VOPI worker');

  // Initialize providers
  setupDefaultProviders();

  // Check FFmpeg availability
  const ffmpegCheck = await videoService.checkFfmpegInstalled();
  if (!ffmpegCheck.available) {
    logger.error({ error: ffmpegCheck.error }, 'FFmpeg not available - worker cannot process videos');
    process.exit(1);
  }
  logger.info(
    { ffmpegVersion: ffmpegCheck.ffmpegVersion, ffprobeVersion: ffmpegCheck.ffprobeVersion },
    'FFmpeg available'
  );

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
  // Use stderr for fatal errors before/after logger availability
  process.stderr.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});

import 'dotenv/config';
import http from 'node:http';

import { parseEnv } from '../config/env.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { initDatabase, closeDatabase } from '../db/index.js';
import { initRedis, closeRedis } from '../queues/redis.js';
import { startPipelineWorker, stopPipelineWorker } from './pipeline.worker.js';
import { startTokenRefreshWorker, stopTokenRefreshWorker } from './token-refresh.worker.js';
import { videoService } from '../services/video.service.js';
import { setupDefaultProviders } from '../providers/setup.js';
import { setupProcessors } from '../processors/setup.js';

// Simple health check server for container orchestration
let healthServer: http.Server | null = null;

/**
 * Start a simple HTTP server for health checks
 * This allows container orchestrators like Railway to verify the worker is running
 */
function startHealthServer(port: number): void {
  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'worker' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  healthServer.listen(port, () => {
    const logger = getLogger();
    logger.info({ port }, 'Worker health server started');
  });
}

/**
 * Stop the health server
 */
async function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (healthServer) {
      healthServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}

/**
 * Worker entry point
 */
async function main(): Promise<void> {
  // Validate environment first
  parseEnv();

  const config = getConfig();
  const logger = getLogger();

  logger.info({ env: config.server.env }, 'Starting VOPI worker');

  // Initialize providers and processors
  setupDefaultProviders();
  setupProcessors();

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

  // Start workers
  startPipelineWorker();
  startTokenRefreshWorker();

  // Start health check server for container orchestration (Railway, K8s, etc.)
  const healthPort = config.server.port;
  startHealthServer(healthPort);

  logger.info(
    { concurrency: config.worker.concurrency, healthPort },
    'Workers started successfully'
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await stopHealthServer();
      await stopPipelineWorker();
      await stopTokenRefreshWorker();
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

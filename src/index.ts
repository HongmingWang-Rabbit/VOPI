import 'dotenv/config';

import { parseEnv } from './config/env.js';
import { getConfig } from './config/index.js';
import { getLogger } from './utils/logger.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { initRedis, closeRedis } from './queues/redis.js';
import { buildApp } from './app.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Validate environment first
  parseEnv();

  const config = getConfig();
  const logger = getLogger();

  logger.info({ env: config.server.env }, 'Starting VOPI backend service');

  // Initialize connections
  await initDatabase();
  initRedis();

  // Build and start server
  const app = await buildApp();

  try {
    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    logger.info(
      { port: config.server.port, host: config.server.host },
      'Server started successfully'
    );
    logger.info(`Documentation available at http://localhost:${config.server.port}/docs`);
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await app.close();
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

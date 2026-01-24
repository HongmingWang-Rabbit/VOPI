import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { tokenRefreshService } from '../services/token-refresh.service.js';

const logger = getLogger().child({ worker: 'token-refresh' });

let refreshInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Run a single token refresh cycle
 */
async function runRefreshCycle(): Promise<void> {
  if (isRunning) {
    logger.debug('Refresh cycle already in progress, skipping');
    return;
  }

  isRunning = true;

  try {
    logger.debug('Starting token refresh cycle');
    const result = await tokenRefreshService.refreshExpiringTokens();

    if (result.refreshed > 0 || result.failed > 0) {
      logger.info(
        { refreshed: result.refreshed, failed: result.failed },
        'Token refresh cycle completed'
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: message }, 'Token refresh cycle failed');
  } finally {
    isRunning = false;
  }
}

/**
 * Start the token refresh worker
 */
export function startTokenRefreshWorker(): void {
  const config = getConfig();
  const intervalMs = config.tokenRefresh.intervalMs;

  logger.info({ intervalMs }, 'Starting token refresh worker');

  // Run immediately on start
  runRefreshCycle();

  // Then run on interval
  refreshInterval = setInterval(runRefreshCycle, intervalMs);
}

/**
 * Stop the token refresh worker
 */
export async function stopTokenRefreshWorker(): Promise<void> {
  logger.info('Stopping token refresh worker');

  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  // Wait for any in-progress refresh to complete
  while (isRunning) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.info('Token refresh worker stopped');
}

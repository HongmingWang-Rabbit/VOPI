import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * Database connection constants
 */
const DB_CONSTANTS = {
  /** Maximum number of connection retry attempts */
  MAX_RETRIES: 5,
  /** Base delay between retries in ms (exponential backoff) */
  RETRY_BASE_DELAY_MS: 1000,
  /** Maximum delay between retries in ms */
  RETRY_MAX_DELAY_MS: 30000,
} as const;

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let pool: pg.Pool | null = null;

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initialize database connection with retry logic
 */
export async function initDatabase(): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  if (db) {
    return db;
  }

  const config = getConfig();
  const logger = getLogger();

  pool = new Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    idleTimeoutMillis: config.database.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.database.poolConnectionTimeoutMs,
  });

  // Test connection with retry logic
  let lastError: Error | null = null;
  let connected = false;

  for (let attempt = 1; attempt <= DB_CONSTANTS.MAX_RETRIES; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      logger.info({ attempt }, 'Database connection established');
      connected = true;
      break;
    } catch (error) {
      lastError = error as Error;
      logger.warn(
        { attempt, maxRetries: DB_CONSTANTS.MAX_RETRIES, error: lastError.message },
        'Database connection attempt failed'
      );

      if (attempt < DB_CONSTANTS.MAX_RETRIES) {
        const delay = Math.min(
          DB_CONSTANTS.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          DB_CONSTANTS.RETRY_MAX_DELAY_MS
        );
        logger.info({ delayMs: delay }, 'Retrying database connection');
        await sleep(delay);
      }
    }
  }

  if (!connected) {
    logger.error({ error: lastError }, 'Failed to connect to database after all retries');
    throw lastError ?? new Error('Database connection failed');
  }

  db = drizzle(pool, { schema });
  return db;
}

/**
 * Get database instance (must be initialized first)
 */
export function getDatabase(): ReturnType<typeof drizzle<typeof schema>> {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Get pool for health checks
 */
export function getPool(): pg.Pool | null {
  return pool;
}

/**
 * Close database connection
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
    getLogger().info('Database connection closed');
  }
}

export { schema };

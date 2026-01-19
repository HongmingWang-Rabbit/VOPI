import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

const { Pool } = pg;

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let pool: pg.Pool | null = null;

/**
 * Initialize database connection
 */
export async function initDatabase(): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  if (db) {
    return db;
  }

  const config = getConfig();
  const logger = getLogger();

  pool = new Pool({
    connectionString: config.database.url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  // Test connection
  try {
    const client = await pool.connect();
    client.release();
    logger.info('Database connection established');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to database');
    throw error;
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

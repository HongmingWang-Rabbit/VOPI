import { getRedis, initRedis } from '../queues/redis.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger().child({ service: 'state-store' });

/**
 * OAuth state data structure
 */
export interface OAuthStateData {
  provider: string;
  redirectUri: string;
  codeVerifier?: string;
  userId?: string;
  shop?: string;
  platform?: 'ios' | 'android' | 'web'; // Client platform for OAuth client selection
  expiresAt: number;
}

const STATE_PREFIX = 'oauth:state:';
const DEFAULT_TTL_SECONDS = 600; // 10 minutes

/**
 * In-memory fallback store for development
 */
const memoryStore = new Map<string, OAuthStateData>();

// Cleanup interval for memory store
let cleanupInterval: NodeJS.Timeout | null = null;

function startMemoryCleanup(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of memoryStore.entries()) {
      if (value.expiresAt < now) {
        memoryStore.delete(key);
      }
    }
  }, 60 * 1000); // Every minute

  // Allow process to exit cleanly
  cleanupInterval.unref?.();
}

/**
 * State store service for OAuth CSRF protection
 * Uses Redis in production, falls back to memory in development
 *
 * @example
 * ```typescript
 * // Initialize (call once at startup)
 * await stateStoreService.initialize();
 *
 * // Store OAuth state
 * const stateData: OAuthStateData = {
 *   provider: 'google',
 *   redirectUri: 'https://app.example.com/callback',
 *   expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
 * };
 * await stateStoreService.set(state, stateData);
 *
 * // Retrieve and delete state (for callback)
 * const data = await stateStoreService.get(state, true);
 * ```
 */
class StateStoreService {
  private useRedis: boolean = false;

  /**
   * Initialize the state store
   * Must be called before using other methods
   * Attempts to use Redis if configured, falls back to in-memory storage
   */
  async initialize(): Promise<void> {
    const config = getConfig();

    // Try to use Redis if available
    if (config.redis.url) {
      try {
        initRedis();
        const redis = getRedis();
        if (redis) {
          await redis.ping();
          this.useRedis = true;
          logger.info('State store using Redis');
          return;
        }
      } catch (error) {
        logger.warn({ error }, 'Redis not available, falling back to memory store');
      }
    }

    // Fall back to memory store
    this.useRedis = false;
    startMemoryCleanup();
    logger.info('State store using in-memory storage (not suitable for multi-instance deployments)');
  }

  /**
   * Store OAuth state with automatic expiration
   * @param state - Unique state identifier (typically random string)
   * @param data - OAuth state data including provider, redirect URI, and expiration
   */
  async set(state: string, data: OAuthStateData): Promise<void> {
    const ttlSeconds = Math.ceil((data.expiresAt - Date.now()) / 1000);

    if (this.useRedis) {
      const redis = getRedis();
      if (redis) {
        await redis.setex(
          `${STATE_PREFIX}${state}`,
          ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS,
          JSON.stringify(data)
        );
        return;
      }
    }

    // Memory fallback
    memoryStore.set(state, data);
  }

  /**
   * Retrieve OAuth state by identifier
   * @param state - Unique state identifier to look up
   * @param deleteAfterGet - If true, delete the state after retrieval (default: false)
   *                         Use true for OAuth callbacks to prevent state reuse
   * @returns The state data if found and not expired, null otherwise
   */
  async get(state: string, deleteAfterGet: boolean = false): Promise<OAuthStateData | null> {
    if (this.useRedis) {
      const redis = getRedis();
      if (redis) {
        const key = `${STATE_PREFIX}${state}`;
        let data: string | null;

        if (deleteAfterGet) {
          // Use GETDEL for atomic get-and-delete to prevent race conditions
          // in concurrent OAuth callbacks (requires Redis 6.2+)
          // Falls back to GET + DEL if GETDEL is not available
          try {
            data = await redis.getdel(key);
          } catch {
            // Fallback for older Redis versions - use Lua script for atomicity
            const luaScript = `
              local value = redis.call('GET', KEYS[1])
              if value then
                redis.call('DEL', KEYS[1])
              end
              return value
            `;
            data = await redis.eval(luaScript, 1, key) as string | null;
          }
        } else {
          data = await redis.get(key);
        }

        if (!data) return null;

        try {
          const parsed = JSON.parse(data) as OAuthStateData;
          if (parsed.expiresAt < Date.now()) {
            return null;
          }
          return parsed;
        } catch {
          return null;
        }
      }
    }

    // Memory fallback - Map operations are synchronous so no race condition
    const data = memoryStore.get(state);
    if (deleteAfterGet) {
      memoryStore.delete(state);
    }

    if (!data || data.expiresAt < Date.now()) {
      return null;
    }

    return data;
  }

  /**
   * Explicitly delete OAuth state
   * @param state - Unique state identifier to delete
   * Note: Usually prefer using `get(state, true)` to atomically retrieve and delete
   */
  async delete(state: string): Promise<void> {
    if (this.useRedis) {
      const redis = getRedis();
      if (redis) {
        await redis.del(`${STATE_PREFIX}${state}`);
        return;
      }
    }

    // Memory fallback
    memoryStore.delete(state);
  }

  /**
   * Check if the state store is using Redis
   * @returns true if Redis is being used, false if using in-memory storage
   * Useful for logging warnings about multi-instance deployments
   */
  isUsingRedis(): boolean {
    return this.useRedis;
  }
}

export const stateStoreService = new StateStoreService();

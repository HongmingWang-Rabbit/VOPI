import { timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { and, isNull, or, gt, eq } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { UnauthorizedError } from '../utils/errors.js';
import { authService } from '../services/auth.service.js';
import { getLogger } from '../utils/logger.js';
import type { ApiKey, User } from '../db/schema.js';
import type { AuthContext } from '../types/auth.types.js';

const logger = getLogger().child({ service: 'auth-middleware' });

/**
 * API Key cache for reducing database lookups
 * Uses a short TTL to balance performance and security
 *
 * Note: Uses FIFO eviction (oldest insertion removed first) when cache is full.
 * This is acceptable because:
 * 1. The short TTL (30s) means entries are frequently refreshed
 * 2. The large cache size (100) should accommodate most deployments
 * 3. True LRU would require more complexity with minimal benefit for this use case
 */
interface CachedApiKey {
  key: ApiKey;
  cachedAt: number;
}

const API_KEY_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const API_KEY_CACHE_MAX_SIZE = 100;
const apiKeyCache = new Map<string, CachedApiKey>();

// Cleanup stale cache entries periodically
let cacheCleanupInterval: NodeJS.Timeout | null = null;

function startCacheCleanup(): void {
  if (cacheCleanupInterval) return;

  cacheCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, cached] of apiKeyCache.entries()) {
      if (now - cached.cachedAt > API_KEY_CACHE_TTL_MS) {
        apiKeyCache.delete(key);
      }
    }
  }, 60 * 1000); // Cleanup every minute

  // Allow process to exit cleanly
  cacheCleanupInterval.unref?.();
}

startCacheCleanup();

// Extend FastifyRequest to include apiKey and user
declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKey;
    user?: User;
    authContext?: AuthContext;
  }
}

/**
 * Auth context for API key authentication
 * Note: userId is undefined for API key auth since there's no associated user
 */
interface ApiKeyAuthContext extends AuthContext {
  apiKeyId: string;
  apiKeyName?: string;
}

/**
 * Constant-time string comparison to prevent timing attacks
 * Note: When lengths differ, we perform a dummy comparison against itself
 * to maintain constant time execution, preventing timing-based length inference.
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Dummy comparison to maintain constant time even when lengths differ
    const dummy = Buffer.from(a);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Try to authenticate using JWT Bearer token
 * Returns true if successful, false if no Bearer token present
 */
async function tryJwtAuth(request: FastifyRequest): Promise<boolean> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix

  try {
    const payload = authService.verifyAccessToken(token);
    const user = await authService.getUserById(payload.sub);

    if (!user) {
      logger.debug({ userId: payload.sub }, 'JWT valid but user not found');
      return false;
    }

    request.user = user;
    request.authContext = {
      userId: user.id,
      email: user.email,
      tokenType: 'access',
    };

    return true;
  } catch (error) {
    // JWT verification failed - log at debug level for troubleshooting
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.debug({ error: errorMessage }, 'JWT verification failed');
    return false;
  }
}

/**
 * Try to authenticate using API key
 * Returns true if successful, false if no API key or invalid
 * Uses a short-lived cache to reduce database load
 */
async function tryApiKeyAuth(request: FastifyRequest): Promise<boolean> {
  const apiKeyHeader = request.headers['x-api-key'];
  if (!apiKeyHeader || typeof apiKeyHeader !== 'string') {
    return false;
  }

  const now = Date.now();

  // Check cache first
  const cached = apiKeyCache.get(apiKeyHeader);
  if (cached && now - cached.cachedAt < API_KEY_CACHE_TTL_MS) {
    // Verify the cached key is still valid (not expired)
    const expiresAt = cached.key.expiresAt?.getTime();
    if (!expiresAt || expiresAt > now) {
      request.apiKey = cached.key;
      const apiKeyContext: ApiKeyAuthContext = {
        userId: '',
        email: `apikey:${cached.key.name || cached.key.id}`,
        tokenType: 'api_key',
        apiKeyId: cached.key.id,
        apiKeyName: cached.key.name ?? undefined,
      };
      request.authContext = apiKeyContext;
      return true;
    }
    // Key expired, remove from cache
    apiKeyCache.delete(apiKeyHeader);
  }

  const db = getDatabase();
  const nowDate = new Date();

  // Query for the specific API key directly (not revoked and not expired)
  const [matchedKey] = await db
    .select()
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.key, apiKeyHeader),
        isNull(schema.apiKeys.revokedAt),
        or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, nowDate))
      )
    )
    .limit(1);

  if (matchedKey) {
    // Add to cache (with size limit)
    if (apiKeyCache.size >= API_KEY_CACHE_MAX_SIZE) {
      // Remove oldest entry
      const oldestKey = apiKeyCache.keys().next().value;
      if (oldestKey) apiKeyCache.delete(oldestKey);
    }
    apiKeyCache.set(apiKeyHeader, { key: matchedKey, cachedAt: now });

    request.apiKey = matchedKey;
    // Note: API key auth has no associated user - use apiKeyId for tracking
    const apiKeyContext: ApiKeyAuthContext = {
      userId: '', // Empty string indicates API key auth (no user)
      email: `apikey:${matchedKey.name || matchedKey.id}`,
      tokenType: 'api_key',
      apiKeyId: matchedKey.id,
      apiKeyName: matchedKey.name ?? undefined,
    };
    request.authContext = apiKeyContext;
    return true;
  }

  // Fall back to config-based keys for backwards compatibility
  const config = getConfig();
  const validKeys = config.auth.apiKeys;
  const isValidConfigKey = validKeys.some((validKey) => safeCompare(apiKeyHeader, validKey));

  if (isValidConfigKey) {
    const configKeyContext: ApiKeyAuthContext = {
      userId: '', // Empty string indicates API key auth (no user)
      email: 'apikey:config',
      tokenType: 'api_key',
      apiKeyId: 'config',
      apiKeyName: 'config',
    };
    request.authContext = configKeyContext;
    return true;
  }

  return false;
}

/**
 * Combined authentication middleware
 * Supports both JWT Bearer tokens and API keys
 * Priority: JWT > API Key
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Try JWT auth first
  if (await tryJwtAuth(request)) {
    return;
  }

  // Fall back to API key auth
  if (await tryApiKeyAuth(request)) {
    return;
  }

  // No valid authentication found
  const error = new UnauthorizedError('Authentication required');
  reply.status(401).send({
    error: error.code,
    message: error.message,
  });
}

/**
 * Skip auth for certain paths (health checks, docs)
 */
export function shouldSkipAuth(path: string): boolean {
  const config = getConfig();
  return config.auth.skipPaths.some((p) => path.startsWith(p));
}

/**
 * Check if the current request has admin privileges
 * Admin can be granted via:
 * 1. Database API key with isAdmin flag (future)
 * 2. API key in ADMIN_API_KEYS environment variable
 */
export function isAdminRequest(request: FastifyRequest): boolean {
  const apiKeyHeader = request.headers['x-api-key'];
  if (!apiKeyHeader || typeof apiKeyHeader !== 'string') {
    return false;
  }

  const config = getConfig();
  return config.auth.adminApiKeys.some((adminKey) => safeCompare(apiKeyHeader, adminKey));
}

/**
 * Middleware to require admin access
 * Use as preHandler on routes that need admin privileges
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!isAdminRequest(request)) {
    return reply.status(403).send({
      error: 'FORBIDDEN',
      message: 'Admin access required for this operation',
    });
  }
}

/**
 * Middleware to require user (JWT) authentication
 * Rejects API key auth - only allows logged-in users
 */
export async function requireUserAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.user || request.authContext?.tokenType !== 'access') {
    return reply.status(401).send({
      error: 'UNAUTHORIZED',
      message: 'User authentication required. Please log in.',
    });
  }
}

/**
 * Optional auth middleware - authenticates if credentials provided but doesn't require it
 * Useful for endpoints that work with or without auth
 */
export async function optionalAuth(request: FastifyRequest): Promise<void> {
  // Try JWT auth first
  if (await tryJwtAuth(request)) {
    return;
  }

  // Try API key auth
  await tryApiKeyAuth(request);
  // Don't throw error - auth is optional
}

/**
 * Clear the API key cache
 * Call this when an API key is revoked or modified to ensure
 * the changes take effect immediately
 */
export function clearApiKeyCache(apiKey?: string): void {
  if (apiKey) {
    apiKeyCache.delete(apiKey);
  } else {
    apiKeyCache.clear();
  }
}

import { timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { and, isNull, or, gt } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { UnauthorizedError } from '../utils/errors.js';
import type { ApiKey } from '../db/schema.js';

// Extend FastifyRequest to include apiKey
declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKey;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against itself to maintain constant time even when lengths differ
    const dummy = Buffer.from(a);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * API key authentication middleware
 * Validates x-api-key header against database API keys
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKeyHeader = request.headers['x-api-key'];

  if (!apiKeyHeader || typeof apiKeyHeader !== 'string') {
    const error = new UnauthorizedError('Missing API key');
    reply.status(401).send({
      error: error.code,
      message: error.message,
    });
    return;
  }

  const db = getDatabase();
  const now = new Date();

  // Query for valid API keys (not revoked and not expired)
  const apiKeys = await db
    .select()
    .from(schema.apiKeys)
    .where(
      and(
        isNull(schema.apiKeys.revokedAt),
        or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, now))
      )
    );

  // Use constant-time comparison to prevent timing attacks
  const matchedKey = apiKeys.find((key) => safeCompare(apiKeyHeader, key.key));

  if (!matchedKey) {
    // Fall back to config-based keys for backwards compatibility
    const config = getConfig();
    const validKeys = config.auth.apiKeys;
    const isValidConfigKey = validKeys.some((validKey) => safeCompare(apiKeyHeader, validKey));

    if (!isValidConfigKey) {
      const error = new UnauthorizedError('Invalid API key');
      reply.status(401).send({
        error: error.code,
        message: error.message,
      });
      return;
    }
    // Config-based key - no tracking available
    return;
  }

  // Store the API key record on the request for later use
  request.apiKey = matchedKey;
}

/**
 * Skip auth for certain paths (health checks, docs)
 */
export function shouldSkipAuth(path: string): boolean {
  const config = getConfig();
  return config.auth.skipPaths.some((p) => path.startsWith(p));
}

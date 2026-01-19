import { timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { getConfig } from '../config/index.js';
import { UnauthorizedError } from '../utils/errors.js';

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
 * Validates x-api-key header against configured API keys
 */
export function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  const apiKey = request.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string') {
    const error = new UnauthorizedError('Missing API key');
    reply.status(401).send({
      error: error.code,
      message: error.message,
    });
    return;
  }

  const config = getConfig();
  const validKeys = config.auth.apiKeys;

  // Use constant-time comparison to prevent timing attacks
  const isValidKey = validKeys.some((validKey) => safeCompare(apiKey, validKey));

  if (!isValidKey) {
    const error = new UnauthorizedError('Invalid API key');
    reply.status(401).send({
      error: error.code,
      message: error.message,
    });
    return;
  }

  done();
}

/**
 * Skip auth for certain paths (health checks, docs)
 */
export function shouldSkipAuth(path: string): boolean {
  const config = getConfig();
  return config.auth.skipPaths.some((p) => path.startsWith(p));
}

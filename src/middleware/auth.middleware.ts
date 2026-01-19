import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { getConfig } from '../config/index.js';
import { UnauthorizedError } from '../utils/errors.js';

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

  if (!validKeys.includes(apiKey)) {
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
 * Skip auth for certain paths (health checks)
 */
export function shouldSkipAuth(path: string): boolean {
  const skipPaths = ['/health', '/ready', '/docs', '/docs/'];
  return skipPaths.some((p) => path.startsWith(p));
}

import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/index.js';
import { getRedis } from '../queues/redis.js';

interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
}

interface ReadinessResponse extends HealthResponse {
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}

/**
 * Health check routes (no auth required)
 */
export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Liveness probe - is the service running?
   */
  fastify.get<{ Reply: HealthResponse }>(
    '/health',
    {
      schema: {
        description: 'Liveness probe',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.send({
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    }
  );

  /**
   * Readiness probe - can the service handle requests?
   */
  fastify.get<{ Reply: ReadinessResponse }>(
    '/ready',
    {
      schema: {
        description: 'Readiness probe - checks database and Redis connectivity',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              timestamp: { type: 'string' },
              checks: {
                type: 'object',
                properties: {
                  database: { type: 'string' },
                  redis: { type: 'string' },
                },
              },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              timestamp: { type: 'string' },
              checks: {
                type: 'object',
                properties: {
                  database: { type: 'string' },
                  redis: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const checks = {
        database: 'ok' as 'ok' | 'error',
        redis: 'ok' as 'ok' | 'error',
      };

      // Check database
      try {
        const pool = getPool();
        if (pool) {
          const client = await pool.connect();
          await client.query('SELECT 1');
          client.release();
        } else {
          checks.database = 'error';
        }
      } catch {
        checks.database = 'error';
      }

      // Check Redis
      try {
        const redis = getRedis();
        if (redis) {
          await redis.ping();
        } else {
          checks.redis = 'error';
        }
      } catch {
        checks.redis = 'error';
      }

      const allOk = checks.database === 'ok' && checks.redis === 'ok';
      const status = allOk ? 'ok' : 'error';
      const statusCode = allOk ? 200 : 503;

      return reply.status(statusCode).send({
        status,
        timestamp: new Date().toISOString(),
        checks,
      });
    }
  );
}

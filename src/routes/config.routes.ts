import type { FastifyInstance } from 'fastify';
import { globalConfigService } from '../services/global-config.service.js';
import { requireAdmin } from '../middleware/auth.middleware.js';
import {
  upsertConfigSchema,
  batchUpsertConfigSchema,
  type UpsertConfigRequest,
  type EffectiveConfig,
} from '../types/config.types.js';

interface ConfigResponse {
  key: string;
  value: unknown;
  type: string;
  category: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  updatedAt: string | null;
}

/**
 * Global configuration routes
 */
export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Get all config values with metadata
   */
  fastify.get<{ Reply: ConfigResponse[] }>(
    '/config',
    {
      schema: {
        description: 'Get all configuration values with metadata',
        tags: ['Config'],
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                value: {},
                type: { type: 'string' },
                category: { type: 'string' },
                description: { type: 'string', nullable: true },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                updatedAt: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const configs = await globalConfigService.getAllConfigWithMetadata();
      return reply.send(
        configs.map((c) => ({
          ...c,
          updatedAt: c.updatedAt?.toISOString() ?? null,
        }))
      );
    }
  );

  /**
   * Get effective config (merged defaults + database values)
   */
  fastify.get<{ Reply: EffectiveConfig }>(
    '/config/effective',
    {
      schema: {
        description: 'Get effective configuration (merged defaults + database)',
        tags: ['Config'],
        response: {
          200: {
            type: 'object',
            properties: {
              pipelineStrategy: { type: 'string' },
              fps: { type: 'number' },
              batchSize: { type: 'number' },
              geminiModel: { type: 'string' },
              geminiVideoModel: { type: 'string' },
              temperature: { type: 'number' },
              topP: { type: 'number' },
              motionAlpha: { type: 'number' },
              minTemporalGap: { type: 'number' },
              topKPercent: { type: 'number' },
              commercialVersions: { type: 'array', items: { type: 'string' } },
              aiCleanup: { type: 'boolean' },
              geminiVideoFps: { type: 'number' },
              geminiVideoMaxFrames: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const config = await globalConfigService.getEffectiveConfig();
      return reply.send(config);
    }
  );

  /**
   * Get a single config value
   */
  fastify.get<{
    Params: { key: string };
    Reply: { key: string; value: unknown } | { error: string };
  }>(
    '/config/:key',
    {
      schema: {
        description: 'Get a single configuration value',
        tags: ['Config'],
        params: {
          type: 'object',
          properties: {
            key: { type: 'string' },
          },
          required: ['key'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: {},
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const value = await globalConfigService.getValue(request.params.key);
      if (value === undefined) {
        return reply.status(404).send({ error: 'Config key not found' });
      }
      return reply.send({ key: request.params.key, value });
    }
  );

  /**
   * Set a config value (upsert)
   * Requires admin access
   */
  fastify.put<{
    Body: UpsertConfigRequest;
    Reply: { success: boolean; key: string } | { error: string };
  }>(
    '/config',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Set a configuration value (upsert)',
        tags: ['Config'],
        body: {
          type: 'object',
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 100 },
            value: {},
            type: { type: 'string', enum: ['string', 'number', 'boolean', 'json'] },
            category: { type: 'string', enum: ['pipeline', 'ai', 'scoring', 'commercial', 'system'] },
            description: { type: 'string', maxLength: 500 },
            isActive: { type: 'boolean' },
          },
          required: ['key', 'value'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              key: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = upsertConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      await globalConfigService.setValue(parsed.data);
      return reply.send({ success: true, key: parsed.data.key });
    }
  );

  /**
   * Set multiple config values at once
   * Requires admin access
   */
  fastify.put<{
    Body: UpsertConfigRequest[];
    Reply: { success: boolean; count: number } | { error: string };
  }>(
    '/config/batch',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Set multiple configuration values at once (admin only)',
        tags: ['Config'],
        body: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', minLength: 1, maxLength: 100 },
              value: {},
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'json'] },
              category: { type: 'string', enum: ['pipeline', 'ai', 'scoring', 'commercial', 'system'] },
              description: { type: 'string', maxLength: 500 },
              isActive: { type: 'boolean' },
            },
            required: ['key', 'value'],
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              count: { type: 'number' },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = batchUpsertConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      await globalConfigService.setValues(parsed.data);
      return reply.send({ success: true, count: parsed.data.length });
    }
  );

  /**
   * Delete a config value (reset to default)
   * Requires admin access
   */
  fastify.delete<{
    Params: { key: string };
    Reply: { success: boolean; deleted: boolean };
  }>(
    '/config/:key',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Delete a configuration value (reset to default, admin only)',
        tags: ['Config'],
        params: {
          type: 'object',
          properties: {
            key: { type: 'string' },
          },
          required: ['key'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              deleted: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const deleted = await globalConfigService.deleteValue(request.params.key);
      return reply.send({ success: true, deleted });
    }
  );

  /**
   * Seed default config values
   * Requires admin access
   */
  fastify.post<{ Reply: { success: boolean; seeded: number } }>(
    '/config/seed',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Seed default configuration values to database (admin only)',
        tags: ['Config'],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              seeded: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const seeded = await globalConfigService.seedDefaults();
      return reply.send({ success: true, seeded });
    }
  );

  /**
   * Invalidate config cache
   * Requires admin access
   */
  fastify.post<{ Reply: { success: boolean } }>(
    '/config/invalidate-cache',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Invalidate the configuration cache (admin only)',
        tags: ['Config'],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      globalConfigService.invalidateCache();
      return reply.send({ success: true });
    }
  );
}

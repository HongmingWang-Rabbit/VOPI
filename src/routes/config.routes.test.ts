import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { configRoutes } from './config.routes.js';
import { PipelineStrategy, ConfigCategory, ConfigValueType, GlobalConfigKey } from '../types/config.types.js';

// Define mock functions using vi.hoisted to ensure they're available before vi.mock
const mocks = vi.hoisted(() => ({
  getAllConfigWithMetadata: vi.fn(),
  getEffectiveConfig: vi.fn(),
  getValue: vi.fn(),
  setValue: vi.fn(),
  setValues: vi.fn(),
  deleteValue: vi.fn(),
  seedDefaults: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock('../services/global-config.service.js', () => ({
  globalConfigService: mocks,
}));

// Mock requireAdmin to allow all requests in tests
vi.mock('../middleware/auth.middleware.js', () => ({
  requireAdmin: vi.fn().mockImplementation(async () => {
    // Allow all requests in tests
  }),
}));

describe('configRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify();
    await app.register(configRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /config', () => {
    it('should return all config values with metadata', async () => {
      const mockConfigs = [
        {
          key: GlobalConfigKey.PIPELINE_FPS,
          value: 10,
          type: ConfigValueType.NUMBER,
          category: ConfigCategory.PIPELINE,
          description: 'Frames per second',
          isActive: true,
          isDefault: true,
          updatedAt: null,
        },
        {
          key: GlobalConfigKey.PIPELINE_STRATEGY,
          value: PipelineStrategy.CLASSIC,
          type: ConfigValueType.STRING,
          category: ConfigCategory.PIPELINE,
          description: 'Pipeline strategy',
          isActive: true,
          isDefault: false,
          updatedAt: new Date('2024-01-01'),
        },
      ];

      mocks.getAllConfigWithMetadata.mockResolvedValue(mockConfigs);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/config',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(2);
      expect(body[0].key).toBe(GlobalConfigKey.PIPELINE_FPS);
      expect(body[1].updatedAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('GET /config/effective', () => {
    it('should return effective config', async () => {
      const mockConfig = {
        pipelineStrategy: PipelineStrategy.CLASSIC,
        fps: 10,
        batchSize: 30,
        geminiModel: 'gemini-2.0-flash',
        geminiVideoModel: 'gemini-2.0-flash',
        temperature: 0.2,
        topP: 0.8,
        motionAlpha: 0.3,
        minTemporalGap: 1.0,
        topKPercent: 0.3,
        commercialVersions: ['transparent', 'solid'],
        aiCleanup: true,
        geminiVideoFps: 1,
        geminiVideoMaxFrames: 10,
      };

      mocks.getEffectiveConfig.mockResolvedValue(mockConfig);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/config/effective',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pipelineStrategy).toBe(PipelineStrategy.CLASSIC);
      expect(body.fps).toBe(10);
    });
  });

  describe('GET /config/:key', () => {
    it('should return config value for existing key', async () => {
      mocks.getValue.mockResolvedValue(15);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/config/pipeline.fps',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.key).toBe('pipeline.fps');
      expect(body.value).toBe(15);
    });

    it('should return 404 for non-existent key', async () => {
      mocks.getValue.mockResolvedValue(undefined);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/config/non.existent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Config key not found');
    });
  });

  describe('PUT /config', () => {
    it('should set config value', async () => {
      mocks.setValue.mockResolvedValue(undefined);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/config',
        payload: {
          key: 'pipeline.fps',
          value: 15,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.key).toBe('pipeline.fps');
      expect(mocks.setValue).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'pipeline.fps',
          value: 15,
        })
      );
    });

    it('should validate request body', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/config',
        payload: {
          // Missing required key
          value: 15,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('PUT /config/batch', () => {
    it('should set multiple config values', async () => {
      mocks.setValues.mockResolvedValue(undefined);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/config/batch',
        payload: [
          { key: 'pipeline.fps', value: 15 },
          { key: 'ai.temperature', value: 0.5 },
        ],
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.count).toBe(2);
    });

    it('should reject empty array', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/config/batch',
        payload: [],
      });

      expect(response.statusCode).toBe(400);
    });

    it('should validate each config in batch', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/config/batch',
        payload: [
          { key: 'valid.key', value: 'valid' },
          { value: 'missing key' }, // Invalid - missing key
        ],
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /config/:key', () => {
    it('should delete config value and return success', async () => {
      mocks.deleteValue.mockResolvedValue(true);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/config/pipeline.fps',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(true);
    });

    it('should return deleted false when key not found', async () => {
      mocks.deleteValue.mockResolvedValue(false);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/config/non.existent',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(false);
    });
  });

  describe('POST /config/seed', () => {
    it('should seed default config values', async () => {
      mocks.seedDefaults.mockResolvedValue(5);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/config/seed',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.seeded).toBe(5);
      expect(mocks.seedDefaults).toHaveBeenCalled();
    });
  });

  describe('POST /config/invalidate-cache', () => {
    it('should invalidate config cache', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/config/invalidate-cache',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(mocks.invalidateCache).toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineStrategy, ConfigCategory, ConfigValueType, GlobalConfigKey } from '../types/config.types.js';

// Mock database
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockDelete = vi.fn();
const mockTransaction = vi.fn();
const mockReturning = vi.fn();

vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn(() => ({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    transaction: mockTransaction,
  })),
  schema: {
    globalConfig: {
      isActive: 'isActive',
      key: 'key',
    },
  },
}));

// Mock drizzle-orm eq and inArray
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ column: a, value: b })),
  inArray: vi.fn((a, b) => ({ column: a, values: b })),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    configCache: {
      ttlMs: 60000,
    },
    apis: {
      geminiModel: 'gemini-2.0-flash',
    },
  })),
}));

// Import after mocks
import { globalConfigService } from './global-config.service.js';

describe('GlobalConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalConfigService.invalidateCache();

    // Setup default mock chain
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit, returning: mockReturning });
    mockLimit.mockResolvedValue([]);
    mockReturning.mockResolvedValue([]);
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockDelete.mockReturnValue({ where: mockWhere });
  });

  describe('getAllConfig', () => {
    it('should return merged config from defaults and database', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          key: GlobalConfigKey.PIPELINE_FPS,
          value: { value: 15, type: ConfigValueType.NUMBER },
          isActive: true,
        },
      ]);

      const config = await globalConfigService.getAllConfig();

      expect(config.size).toBeGreaterThan(0);
      expect(config.get(GlobalConfigKey.PIPELINE_FPS)?.value).toBe(15);
      // Default value for strategy
      expect(config.get(GlobalConfigKey.PIPELINE_STRATEGY)?.value).toBe(PipelineStrategy.CLASSIC);
    });

    it('should cache config and return from cache on second call', async () => {
      mockWhere.mockResolvedValueOnce([]);

      await globalConfigService.getAllConfig();
      await globalConfigService.getAllConfig();

      // Database should only be called once
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('should refresh cache when invalidated', async () => {
      mockWhere.mockResolvedValue([]);

      await globalConfigService.getAllConfig();
      globalConfigService.invalidateCache();
      await globalConfigService.getAllConfig();

      expect(mockSelect).toHaveBeenCalledTimes(2);
    });
  });

  describe('getValue', () => {
    it('should return value for existing key', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          key: GlobalConfigKey.AI_TEMPERATURE,
          value: { value: 0.5, type: ConfigValueType.NUMBER },
          isActive: true,
        },
      ]);

      const value = await globalConfigService.getValue<number>(GlobalConfigKey.AI_TEMPERATURE);

      expect(value).toBe(0.5);
    });

    it('should return default value for key not in database', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const value = await globalConfigService.getValue<number>(GlobalConfigKey.PIPELINE_FPS);

      expect(value).toBe(10); // Default value
    });

    it('should return undefined for non-existent key', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const value = await globalConfigService.getValue('non.existent.key');

      expect(value).toBeUndefined();
    });
  });

  describe('getValueOrDefault', () => {
    it('should return value when exists', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          key: GlobalConfigKey.PIPELINE_FPS,
          value: { value: 20, type: ConfigValueType.NUMBER },
          isActive: true,
        },
      ]);

      const value = await globalConfigService.getValueOrDefault(GlobalConfigKey.PIPELINE_FPS, 5);

      expect(value).toBe(20);
    });

    it('should return provided default when value undefined', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const value = await globalConfigService.getValueOrDefault('non.existent.key', 'fallback');

      expect(value).toBe('fallback');
    });
  });

  describe('getEffectiveConfig', () => {
    it('should return typed effective config', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          key: GlobalConfigKey.PIPELINE_STRATEGY,
          value: { value: PipelineStrategy.GEMINI_VIDEO, type: ConfigValueType.STRING },
          isActive: true,
        },
        {
          key: GlobalConfigKey.PIPELINE_FPS,
          value: { value: 5, type: ConfigValueType.NUMBER },
          isActive: true,
        },
      ]);

      const config = await globalConfigService.getEffectiveConfig();

      expect(config.pipelineStrategy).toBe(PipelineStrategy.GEMINI_VIDEO);
      expect(config.fps).toBe(5);
      expect(config.batchSize).toBe(30); // Default
      expect(config.geminiModel).toBe('gemini-3-pro-preview'); // Default
    });

    it('should validate and fallback non-string pipeline strategy', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          key: GlobalConfigKey.PIPELINE_STRATEGY,
          // Non-string value should fallback to default
          value: { value: 123, type: ConfigValueType.NUMBER },
          isActive: true,
        },
      ]);

      const config = await globalConfigService.getEffectiveConfig();

      expect(config.pipelineStrategy).toBe(PipelineStrategy.CLASSIC);
    });

    it('should accept any non-empty string as pipeline strategy', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          key: GlobalConfigKey.PIPELINE_STRATEGY,
          // Any valid stack template name should be accepted
          value: { value: 'unified_video_analyzer', type: ConfigValueType.STRING },
          isActive: true,
        },
      ]);

      const config = await globalConfigService.getEffectiveConfig();

      expect(config.pipelineStrategy).toBe('unified_video_analyzer');
    });
  });

  describe('setValue', () => {
    it('should insert new config value', async () => {
      mockLimit.mockResolvedValueOnce([]);

      await globalConfigService.setValue({
        key: 'custom.key',
        value: 'custom value',
      });

      expect(mockInsert).toHaveBeenCalled();
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'custom.key',
          value: { value: 'custom value', type: ConfigValueType.STRING },
        })
      );
    });

    it('should update existing config value', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          key: GlobalConfigKey.PIPELINE_FPS,
          value: { value: 10, type: ConfigValueType.NUMBER },
          description: 'FPS setting',
          isActive: true,
        },
      ]);

      await globalConfigService.setValue({
        key: GlobalConfigKey.PIPELINE_FPS,
        value: 15,
      });

      expect(mockUpdate).toHaveBeenCalled();
    });

    it('should infer type from value', async () => {
      mockLimit.mockResolvedValueOnce([]);

      await globalConfigService.setValue({
        key: 'test.boolean',
        value: true,
      });

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          value: { value: true, type: ConfigValueType.BOOLEAN },
        })
      );
    });

    it('should use provided type', async () => {
      mockLimit.mockResolvedValueOnce([]);

      await globalConfigService.setValue({
        key: 'test.json',
        value: ['a', 'b'],
        type: ConfigValueType.JSON,
      });

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          value: { value: ['a', 'b'], type: ConfigValueType.JSON },
        })
      );
    });

    it('should invalidate cache after setting value', async () => {
      // Setup for first getAllConfig call
      mockWhere.mockResolvedValueOnce([]);

      // Populate cache
      await globalConfigService.getAllConfig();
      expect(mockSelect).toHaveBeenCalledTimes(1);

      // Setup for setValue's select (checking if exists) - needs limit in chain
      mockWhere.mockReturnValueOnce({ limit: vi.fn().mockResolvedValueOnce([]) });

      await globalConfigService.setValue({
        key: 'test.key',
        value: 'value',
      });

      // Setup for second getAllConfig call
      mockWhere.mockResolvedValueOnce([]);

      // Should refresh cache on next call
      await globalConfigService.getAllConfig();
      expect(mockSelect).toHaveBeenCalledTimes(3); // 1st getAllConfig + setValue select + 2nd getAllConfig
    });
  });

  describe('setValues', () => {
    it('should set multiple values in a transaction', async () => {
      // Mock the initial select().from().where() to fetch existing keys (returns empty)
      mockWhere.mockResolvedValueOnce([]);

      mockTransaction.mockImplementation(async (callback) => {
        const tx = {
          select: mockSelect,
          insert: mockInsert,
          update: mockUpdate,
        };
        await callback(tx);
      });

      await globalConfigService.setValues([
        { key: 'key1', value: 'value1' },
        { key: 'key2', value: 42 },
      ]);

      expect(mockTransaction).toHaveBeenCalled();
    });
  });

  describe('deleteValue', () => {
    it('should delete config and return true when found', async () => {
      mockReturning.mockResolvedValueOnce([{ key: 'some.key' }]);

      const deleted = await globalConfigService.deleteValue('some.key');

      expect(deleted).toBe(true);
      expect(mockDelete).toHaveBeenCalled();
    });

    it('should return false when key not found', async () => {
      mockReturning.mockResolvedValueOnce([]);

      const deleted = await globalConfigService.deleteValue('non.existent.key');

      expect(deleted).toBe(false);
    });

    it('should invalidate cache after delete', async () => {
      // First getAllConfig call - mockWhere resolves directly to []
      mockWhere.mockResolvedValueOnce([]);

      await globalConfigService.getAllConfig();
      expect(mockSelect).toHaveBeenCalledTimes(1);

      // deleteValue uses the default mockWhere.mockReturnValue({ limit, returning })
      mockReturning.mockResolvedValueOnce([{ key: 'some.key' }]);
      await globalConfigService.deleteValue('some.key');

      // Second getAllConfig call after cache invalidation
      mockWhere.mockResolvedValueOnce([]);
      await globalConfigService.getAllConfig();
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAllConfigWithMetadata', () => {
    it('should return all configs with metadata', async () => {
      mockFrom.mockReturnValueOnce(
        Promise.resolve([
          {
            key: GlobalConfigKey.PIPELINE_FPS,
            value: { value: 15, type: ConfigValueType.NUMBER },
            category: ConfigCategory.PIPELINE,
            description: 'Custom FPS',
            isActive: true,
            updatedAt: new Date('2024-01-01'),
          },
        ])
      );

      const configs = await globalConfigService.getAllConfigWithMetadata();

      // Should include both DB values and defaults
      expect(configs.length).toBeGreaterThan(0);

      const fpsConfig = configs.find((c) => c.key === GlobalConfigKey.PIPELINE_FPS);
      expect(fpsConfig).toBeDefined();
      expect(fpsConfig?.value).toBe(15);
      expect(fpsConfig?.isDefault).toBe(false);

      const strategyConfig = configs.find((c) => c.key === GlobalConfigKey.PIPELINE_STRATEGY);
      expect(strategyConfig).toBeDefined();
      expect(strategyConfig?.isDefault).toBe(true);
    });

    it('should sort configs by key', async () => {
      mockFrom.mockReturnValueOnce(Promise.resolve([]));

      const configs = await globalConfigService.getAllConfigWithMetadata();

      for (let i = 1; i < configs.length; i++) {
        expect(configs[i - 1].key.localeCompare(configs[i].key)).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('seedDefaults', () => {
    it('should insert default values that do not exist', async () => {
      // Mock the batch select to return no existing keys
      mockFrom.mockResolvedValueOnce([]);

      await globalConfigService.seedDefaults();

      expect(mockInsert).toHaveBeenCalled();
    });

    it('should skip existing values when all exist', async () => {
      // Mock returning all default keys as existing
      const allDefaultKeys = Object.keys(
        await import('../types/config.types.js').then(m => m.DEFAULT_CONFIG)
      ).map(key => ({ key }));
      mockFrom.mockResolvedValueOnce(allDefaultKeys);

      await globalConfigService.seedDefaults();

      // Insert should not be called when all keys exist
      expect(mockValues).not.toHaveBeenCalled();
    });
  });

  describe('invalidateCache', () => {
    it('should clear cache', async () => {
      mockWhere.mockResolvedValue([]);

      await globalConfigService.getAllConfig();
      expect(mockSelect).toHaveBeenCalledTimes(1);

      globalConfigService.invalidateCache();

      await globalConfigService.getAllConfig();
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });
  });
});

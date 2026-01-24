/**
 * Global Config Service
 * Manages runtime configuration from database with caching and defaults
 */

import { eq, inArray } from 'drizzle-orm';
import { createChildLogger } from '../utils/logger.js';
import { getDatabase, schema } from '../db/index.js';
import { getConfig } from '../config/index.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_IMAGE_MODEL,
  GlobalConfigKey,
  PipelineStrategy,
  ConfigCategory,
  ConfigValueType,
  type GlobalConfigValue,
  type EffectiveConfig,
  type UpsertConfigRequest,
} from '../types/config.types.js';
import { DEFAULT_PRICING_CONFIG, type PricingConfig } from '../types/credits.types.js';

const logger = createChildLogger({ service: 'global-config' });

interface CachedConfig {
  config: Map<string, GlobalConfigValue>;
  loadedAt: number;
}

class GlobalConfigService {
  private cache: CachedConfig | null = null;

  /**
   * Get all config values from database, merged with defaults
   */
  async getAllConfig(): Promise<Map<string, GlobalConfigValue>> {
    // Check cache
    const cacheTtlMs = getConfig().configCache.ttlMs;
    if (this.cache && Date.now() - this.cache.loadedAt < cacheTtlMs) {
      return this.cache.config;
    }

    const db = getDatabase();
    const rows = await db
      .select()
      .from(schema.globalConfig)
      .where(eq(schema.globalConfig.isActive, true));

    // Start with defaults
    const config = new Map<string, GlobalConfigValue>();
    for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
      config.set(key, { value: def.value, type: def.type });
    }

    // Override with database values
    for (const row of rows) {
      config.set(row.key, row.value);
    }

    // Update cache
    this.cache = { config, loadedAt: Date.now() };
    logger.debug({ configCount: config.size }, 'Config loaded from database');

    return config;
  }

  /**
   * Get a single config value
   */
  async getValue<T = unknown>(key: string): Promise<T | undefined> {
    const config = await this.getAllConfig();
    const entry = config.get(key);
    return entry?.value as T | undefined;
  }

  /**
   * Get a config value with default fallback
   */
  async getValueOrDefault<T>(key: string, defaultValue: T): Promise<T> {
    const value = await this.getValue<T>(key);
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Validate a pipeline strategy value
   * Accepts any string since it's a stack template name
   */
  private validatePipelineStrategy(value: unknown): PipelineStrategy {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
    logger.warn({ value }, 'Invalid pipeline strategy (must be a non-empty string), using default');
    return PipelineStrategy.CLASSIC;
  }

  /**
   * Get the effective config object with all settings typed
   */
  async getEffectiveConfig(): Promise<EffectiveConfig> {
    const config = await this.getAllConfig();

    const getValue = <T>(key: string, defaultValue: T): T => {
      const entry = config.get(key);
      return (entry?.value as T) ?? defaultValue;
    };

    const strategyValue = getValue(GlobalConfigKey.PIPELINE_STRATEGY, PipelineStrategy.CLASSIC);

    return {
      pipelineStrategy: this.validatePipelineStrategy(strategyValue),
      fps: getValue(GlobalConfigKey.PIPELINE_FPS, 10),
      batchSize: getValue(GlobalConfigKey.PIPELINE_BATCH_SIZE, 30),
      geminiModel: getValue(GlobalConfigKey.AI_GEMINI_MODEL, DEFAULT_GEMINI_MODEL),
      geminiVideoModel: getValue(GlobalConfigKey.AI_GEMINI_VIDEO_MODEL, DEFAULT_GEMINI_MODEL),
      geminiImageModel: getValue(GlobalConfigKey.AI_GEMINI_IMAGE_MODEL, DEFAULT_GEMINI_IMAGE_MODEL),
      temperature: getValue(GlobalConfigKey.AI_TEMPERATURE, 0.2),
      topP: getValue(GlobalConfigKey.AI_TOP_P, 0.8),
      motionAlpha: getValue(GlobalConfigKey.SCORING_MOTION_ALPHA, 0.3),
      minTemporalGap: getValue(GlobalConfigKey.SCORING_MIN_TEMPORAL_GAP, 1.0),
      topKPercent: getValue(GlobalConfigKey.SCORING_TOP_K_PERCENT, 0.3),
      commercialVersions: getValue(GlobalConfigKey.COMMERCIAL_VERSIONS, ['transparent']),
      aiCleanup: getValue(GlobalConfigKey.COMMERCIAL_AI_CLEANUP, true),
      geminiVideoFps: getValue(GlobalConfigKey.GEMINI_VIDEO_FPS, 1),
      geminiVideoMaxFrames: getValue(GlobalConfigKey.GEMINI_VIDEO_MAX_FRAMES, 10),
      debugEnabled: getValue(GlobalConfigKey.DEBUG_ENABLED, false),
    };
  }

  /**
   * Set a config value (upsert)
   */
  async setValue(request: UpsertConfigRequest): Promise<void> {
    const db = getDatabase();
    const { key, value, type, category, description, isActive } = request;

    // Determine type if not provided
    const valueType = type ?? this.inferType(value);
    const configValue: GlobalConfigValue = { value, type: valueType };

    // Get default for category if not provided
    const defaultDef = DEFAULT_CONFIG[key];
    const effectiveCategory = category ?? defaultDef?.category ?? ConfigCategory.SYSTEM;

    // Check if exists
    const existing = await db
      .select()
      .from(schema.globalConfig)
      .where(eq(schema.globalConfig.key, key))
      .limit(1);

    if (existing.length > 0) {
      // Update
      await db
        .update(schema.globalConfig)
        .set({
          value: configValue,
          category: effectiveCategory,
          description: description ?? existing[0].description,
          isActive: isActive ?? existing[0].isActive,
          updatedAt: new Date(),
        })
        .where(eq(schema.globalConfig.key, key));
      logger.info({ key, value }, 'Config updated');
    } else {
      // Insert
      await db.insert(schema.globalConfig).values({
        key,
        value: configValue,
        category: effectiveCategory,
        description: description ?? defaultDef?.description,
        isActive: isActive ?? true,
      });
      logger.info({ key, value }, 'Config created');
    }

    // Invalidate cache
    this.invalidateCache();
  }

  /**
   * Set multiple config values at once (transactional)
   * Optimized to fetch existing keys once and batch operations
   */
  async setValues(configs: UpsertConfigRequest[]): Promise<void> {
    const db = getDatabase();

    // Fetch all existing keys for the configs we're setting
    const keysToSet = configs.map(c => c.key);
    const existingRows = await db
      .select()
      .from(schema.globalConfig)
      .where(inArray(schema.globalConfig.key, keysToSet));

    // Build lookup of existing values
    const existingByKey = new Map(existingRows.map(r => [r.key, r]));

    await db.transaction(async (tx) => {
      const toInsert: Array<{
        key: string;
        value: GlobalConfigValue;
        category: string;
        description: string | undefined;
        isActive: boolean;
      }> = [];
      const toUpdate: Array<{
        key: string;
        value: GlobalConfigValue;
        category: string;
        description: string | null;
        isActive: boolean;
      }> = [];

      for (const request of configs) {
        const { key, value, type, category, description, isActive } = request;

        // Determine type if not provided
        const valueType = type ?? this.inferType(value);
        const configValue: GlobalConfigValue = { value, type: valueType };

        // Get default for category if not provided
        const defaultDef = DEFAULT_CONFIG[key];
        const effectiveCategory = category ?? defaultDef?.category ?? ConfigCategory.SYSTEM;

        const existing = existingByKey.get(key);

        if (existing) {
          toUpdate.push({
            key,
            value: configValue,
            category: effectiveCategory,
            description: description ?? existing.description,
            isActive: isActive ?? existing.isActive,
          });
        } else {
          toInsert.push({
            key,
            value: configValue,
            category: effectiveCategory,
            description: description ?? defaultDef?.description,
            isActive: isActive ?? true,
          });
        }
      }

      // Batch insert new configs
      if (toInsert.length > 0) {
        await tx.insert(schema.globalConfig).values(toInsert);
      }

      // Update existing configs (still need individual updates for different values)
      for (const update of toUpdate) {
        await tx
          .update(schema.globalConfig)
          .set({
            value: update.value,
            category: update.category,
            description: update.description,
            isActive: update.isActive,
            updatedAt: new Date(),
          })
          .where(eq(schema.globalConfig.key, update.key));
      }
    });

    logger.info({ count: configs.length, inserted: configs.length - existingByKey.size, updated: existingByKey.size }, 'Batch config update completed');

    // Invalidate cache after transaction completes
    this.invalidateCache();
  }

  /**
   * Delete a config value (resets to default)
   */
  async deleteValue(key: string): Promise<boolean> {
    const db = getDatabase();
    const deletedRows = await db
      .delete(schema.globalConfig)
      .where(eq(schema.globalConfig.key, key))
      .returning({ key: schema.globalConfig.key });

    this.invalidateCache();
    if (deletedRows.length > 0) {
      logger.info({ key }, 'Config deleted (reset to default)');
    }
    return deletedRows.length > 0;
  }

  /**
   * Get all config entries with metadata (for admin UI)
   */
  async getAllConfigWithMetadata(): Promise<Array<{
    key: string;
    value: unknown;
    type: string;
    category: string;
    description: string | null;
    isActive: boolean;
    isDefault: boolean;
    updatedAt: Date | null;
  }>> {
    const db = getDatabase();
    const rows = await db.select().from(schema.globalConfig);

    // Build lookup of DB values
    const dbValues = new Map(rows.map(r => [r.key, r]));

    // Merge with defaults
    const result: Array<{
      key: string;
      value: unknown;
      type: string;
      category: string;
      description: string | null;
      isActive: boolean;
      isDefault: boolean;
      updatedAt: Date | null;
    }> = [];

    // Add all defaults first
    for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
      const dbRow = dbValues.get(key);
      if (dbRow) {
        result.push({
          key,
          value: dbRow.value.value,
          type: dbRow.value.type,
          category: dbRow.category,
          description: dbRow.description,
          isActive: dbRow.isActive,
          isDefault: false,
          updatedAt: dbRow.updatedAt,
        });
        dbValues.delete(key);
      } else {
        result.push({
          key,
          value: def.value,
          type: def.type,
          category: def.category,
          description: def.description,
          isActive: true,
          isDefault: true,
          updatedAt: null,
        });
      }
    }

    // Add any custom keys not in defaults
    for (const [key, row] of dbValues) {
      result.push({
        key,
        value: row.value.value,
        type: row.value.type,
        category: row.category,
        description: row.description,
        isActive: row.isActive,
        isDefault: false,
        updatedAt: row.updatedAt,
      });
    }

    return result.sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Initialize database with default values (call on startup)
   * Returns the number of values seeded
   */
  async seedDefaults(): Promise<number> {
    const db = getDatabase();

    // Fetch all existing keys in one query
    const existingRows = await db
      .select({ key: schema.globalConfig.key })
      .from(schema.globalConfig);
    const existingKeys = new Set(existingRows.map(r => r.key));

    // Build list of missing configs
    const missingConfigs = Object.entries(DEFAULT_CONFIG)
      .filter(([key]) => !existingKeys.has(key))
      .map(([key, def]) => ({
        key,
        value: { value: def.value, type: def.type },
        category: def.category,
        description: def.description,
        isActive: true,
      }));

    // Batch insert all missing configs
    if (missingConfigs.length > 0) {
      await db.insert(schema.globalConfig).values(missingConfigs);
      logger.info({ count: missingConfigs.length }, 'Default config values seeded');
    } else {
      logger.debug('All default config values already exist');
    }

    this.invalidateCache();
    return missingConfigs.length;
  }

  /**
   * Invalidate the cache (call after external changes)
   */
  invalidateCache(): void {
    this.cache = null;
    logger.debug('Config cache invalidated');
  }

  /**
   * Get pricing configuration for credit calculations
   */
  async getPricingConfig(): Promise<PricingConfig> {
    const config = await this.getAllConfig();

    const getValue = <T>(key: string, defaultValue: T): T => {
      const entry = config.get(key);
      return (entry?.value as T) ?? defaultValue;
    };

    return {
      baseCredits: getValue(GlobalConfigKey.PRICING_BASE_CREDITS, DEFAULT_PRICING_CONFIG.baseCredits),
      creditsPerSecond: getValue(GlobalConfigKey.PRICING_CREDITS_PER_SECOND, DEFAULT_PRICING_CONFIG.creditsPerSecond),
      includedFrames: getValue(GlobalConfigKey.PRICING_INCLUDED_FRAMES, DEFAULT_PRICING_CONFIG.includedFrames),
      extraFrameCost: getValue(GlobalConfigKey.PRICING_EXTRA_FRAME_COST, DEFAULT_PRICING_CONFIG.extraFrameCost),
      commercialVideoEnabled: getValue(GlobalConfigKey.PRICING_COMMERCIAL_VIDEO_ENABLED, DEFAULT_PRICING_CONFIG.commercialVideoEnabled),
      commercialVideoCost: getValue(GlobalConfigKey.PRICING_COMMERCIAL_VIDEO_COST, DEFAULT_PRICING_CONFIG.commercialVideoCost),
      minJobCost: getValue(GlobalConfigKey.PRICING_MIN_JOB_COST, DEFAULT_PRICING_CONFIG.minJobCost),
      maxJobCost: getValue(GlobalConfigKey.PRICING_MAX_JOB_COST, DEFAULT_PRICING_CONFIG.maxJobCost),
    };
  }

  /**
   * Infer type from value
   */
  private inferType(value: unknown): ConfigValueType {
    if (typeof value === 'string') return ConfigValueType.STRING;
    if (typeof value === 'number') return ConfigValueType.NUMBER;
    if (typeof value === 'boolean') return ConfigValueType.BOOLEAN;
    return ConfigValueType.JSON;
  }
}

// Export singleton
export const globalConfigService = new GlobalConfigService();

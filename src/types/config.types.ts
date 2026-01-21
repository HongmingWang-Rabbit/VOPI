import { z } from 'zod';

/**
 * Pipeline strategy - determines how frames are selected
 */
export const PipelineStrategy = {
  /** Classic: Extract all frames → Score → Classify with Gemini */
  CLASSIC: 'classic',
  /** Gemini Video: Upload video to Gemini → AI selects timestamps → Extract specific frames */
  GEMINI_VIDEO: 'gemini_video',
} as const;

export type PipelineStrategy = (typeof PipelineStrategy)[keyof typeof PipelineStrategy];

/**
 * Global config categories for organization
 */
export const ConfigCategory = {
  PIPELINE: 'pipeline',
  AI: 'ai',
  SCORING: 'scoring',
  COMMERCIAL: 'commercial',
  SYSTEM: 'system',
} as const;

export type ConfigCategory = (typeof ConfigCategory)[keyof typeof ConfigCategory];

/**
 * Config value types
 */
export const ConfigValueType = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  JSON: 'json',
} as const;

export type ConfigValueType = (typeof ConfigValueType)[keyof typeof ConfigValueType];

/**
 * Global config value - stored in jsonb for flexibility
 */
export interface GlobalConfigValue {
  value: string | number | boolean | unknown[] | Record<string, unknown>;
  type: ConfigValueType;
}

/**
 * Default global config keys with their types
 */
export const GlobalConfigKey = {
  // Pipeline settings
  PIPELINE_STRATEGY: 'pipeline.strategy',
  PIPELINE_FPS: 'pipeline.fps',
  PIPELINE_BATCH_SIZE: 'pipeline.batch_size',

  // AI settings
  AI_GEMINI_MODEL: 'ai.gemini_model',
  AI_GEMINI_VIDEO_MODEL: 'ai.gemini_video_model',
  AI_TEMPERATURE: 'ai.temperature',
  AI_TOP_P: 'ai.top_p',

  // Scoring settings (for classic strategy)
  SCORING_MOTION_ALPHA: 'scoring.motion_alpha',
  SCORING_MIN_TEMPORAL_GAP: 'scoring.min_temporal_gap',
  SCORING_TOP_K_PERCENT: 'scoring.top_k_percent',

  // Commercial image settings
  COMMERCIAL_VERSIONS: 'commercial.versions',
  COMMERCIAL_AI_CLEANUP: 'commercial.ai_cleanup',

  // Gemini video settings (for gemini_video strategy)
  GEMINI_VIDEO_FPS: 'gemini_video.fps',
  GEMINI_VIDEO_MAX_FRAMES: 'gemini_video.max_frames',
} as const;

export type GlobalConfigKey = (typeof GlobalConfigKey)[keyof typeof GlobalConfigKey];

/**
 * Schema for config value validation
 */
export const globalConfigValueSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.unknown())]),
  type: z.enum(['string', 'number', 'boolean', 'json']),
});

/**
 * Schema for creating/updating config
 */
export const upsertConfigSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.unknown())]),
  type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
  category: z.enum(['pipeline', 'ai', 'scoring', 'commercial', 'system']).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
});

export type UpsertConfigRequest = z.infer<typeof upsertConfigSchema>;

/**
 * Schema for batch config updates
 */
export const batchUpsertConfigSchema = z.array(upsertConfigSchema).min(1).max(100);

export type BatchUpsertConfigRequest = z.infer<typeof batchUpsertConfigSchema>;

/**
 * Default config values
 */
export const DEFAULT_CONFIG: Record<string, GlobalConfigValue & { category: ConfigCategory; description: string }> = {
  [GlobalConfigKey.PIPELINE_STRATEGY]: {
    value: PipelineStrategy.CLASSIC,
    type: ConfigValueType.STRING,
    category: ConfigCategory.PIPELINE,
    description: 'Frame selection strategy: classic (score+classify) or gemini_video (AI video analysis)',
  },
  [GlobalConfigKey.PIPELINE_FPS]: {
    value: 10,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PIPELINE,
    description: 'Frames per second for extraction (classic strategy)',
  },
  [GlobalConfigKey.PIPELINE_BATCH_SIZE]: {
    value: 30,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PIPELINE,
    description: 'Batch size for Gemini classification',
  },
  [GlobalConfigKey.AI_GEMINI_MODEL]: {
    value: 'gemini-2.0-flash',
    type: ConfigValueType.STRING,
    category: ConfigCategory.AI,
    description: 'Gemini model for frame classification',
  },
  [GlobalConfigKey.AI_GEMINI_VIDEO_MODEL]: {
    value: 'gemini-2.0-flash',
    type: ConfigValueType.STRING,
    category: ConfigCategory.AI,
    description: 'Gemini model for video understanding',
  },
  [GlobalConfigKey.AI_TEMPERATURE]: {
    value: 0.2,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.AI,
    description: 'Temperature for Gemini responses (0-1)',
  },
  [GlobalConfigKey.AI_TOP_P]: {
    value: 0.8,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.AI,
    description: 'Top-p sampling for Gemini responses',
  },
  [GlobalConfigKey.SCORING_MOTION_ALPHA]: {
    value: 0.3,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.SCORING,
    description: 'Weight for motion penalty in frame scoring',
  },
  [GlobalConfigKey.SCORING_MIN_TEMPORAL_GAP]: {
    value: 1.0,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.SCORING,
    description: 'Minimum seconds between selected frames',
  },
  [GlobalConfigKey.SCORING_TOP_K_PERCENT]: {
    value: 0.3,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.SCORING,
    description: 'Top percentage of frames to send to Gemini',
  },
  [GlobalConfigKey.COMMERCIAL_VERSIONS]: {
    value: ['transparent', 'solid', 'real', 'creative'],
    type: ConfigValueType.JSON,
    category: ConfigCategory.COMMERCIAL,
    description: 'Commercial image versions to generate',
  },
  [GlobalConfigKey.COMMERCIAL_AI_CLEANUP]: {
    value: true,
    type: ConfigValueType.BOOLEAN,
    category: ConfigCategory.COMMERCIAL,
    description: 'Enable AI cleanup for commercial images',
  },
  [GlobalConfigKey.GEMINI_VIDEO_FPS]: {
    value: 1,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PIPELINE,
    description: 'FPS for Gemini video analysis (1 recommended)',
  },
  [GlobalConfigKey.GEMINI_VIDEO_MAX_FRAMES]: {
    value: 10,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PIPELINE,
    description: 'Maximum frames to select via video analysis',
  },
};

/**
 * Effective config - merged from defaults and database
 */
export interface EffectiveConfig {
  pipelineStrategy: PipelineStrategy;
  fps: number;
  batchSize: number;
  geminiModel: string;
  geminiVideoModel: string;
  temperature: number;
  topP: number;
  motionAlpha: number;
  minTemporalGap: number;
  topKPercent: number;
  commercialVersions: string[];
  aiCleanup: boolean;
  geminiVideoFps: number;
  geminiVideoMaxFrames: number;
}

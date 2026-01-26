import { z } from 'zod';

/**
 * Default Gemini model for AI operations
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

/**
 * Pipeline strategy - the name of a stack template to use
 * Can be any valid stack template ID from stackTemplates or stagingStackTemplates
 */
export const PipelineStrategy = {
  /** Classic: Extract all frames → Score → Classify with Gemini */
  CLASSIC: 'classic',
  /** Gemini Video: Upload video to Gemini → AI selects timestamps → Extract specific frames */
  GEMINI_VIDEO: 'gemini_video',
  /** Unified Video Analyzer: Single Gemini call for audio + video analysis */
  UNIFIED_VIDEO_ANALYZER: 'unified_video_analyzer',
  /** Full Gemini: Uses Gemini for both video analysis AND image generation (no external APIs) */
  FULL_GEMINI: 'full_gemini',
} as const;

/**
 * Pipeline strategy type - allows any stack template name
 * Provides autocomplete for known strategies while accepting custom template names
 */
export type PipelineStrategy =
  | (typeof PipelineStrategy)[keyof typeof PipelineStrategy]
  | (string & Record<never, never>);

/**
 * Global config categories for organization
 */
export const ConfigCategory = {
  PIPELINE: 'pipeline',
  AI: 'ai',
  SCORING: 'scoring',
  COMMERCIAL: 'commercial',
  PRICING: 'pricing',
  SYSTEM: 'system',
  DEBUG: 'debug',
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
 * Default Gemini model for image generation
 * Note: This model supports native image generation
 */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

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
  AI_GEMINI_IMAGE_MODEL: 'ai.gemini_image_model',
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

  // Debug settings
  DEBUG_ENABLED: 'debug.enabled',

  // Pricing settings
  PRICING_BASE_CREDITS: 'pricing.base_credits',
  PRICING_CREDITS_PER_SECOND: 'pricing.credits_per_second',
  PRICING_INCLUDED_FRAMES: 'pricing.included_frames',
  PRICING_EXTRA_FRAME_COST: 'pricing.extra_frame_cost',
  PRICING_COMMERCIAL_VIDEO_ENABLED: 'pricing.commercial_video_enabled',
  PRICING_COMMERCIAL_VIDEO_COST: 'pricing.commercial_video_cost',
  PRICING_MIN_JOB_COST: 'pricing.min_job_cost',
  PRICING_MAX_JOB_COST: 'pricing.max_job_cost',
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
  category: z.enum(['pipeline', 'ai', 'scoring', 'commercial', 'pricing', 'system', 'debug']).optional(),
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
    description: 'Stack template name: classic, gemini_video, unified_video_analyzer, etc.',
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
    value: DEFAULT_GEMINI_MODEL,
    type: ConfigValueType.STRING,
    category: ConfigCategory.AI,
    description: 'Gemini model for frame classification',
  },
  [GlobalConfigKey.AI_GEMINI_VIDEO_MODEL]: {
    value: DEFAULT_GEMINI_MODEL,
    type: ConfigValueType.STRING,
    category: ConfigCategory.AI,
    description: 'Gemini model for video understanding',
  },
  [GlobalConfigKey.AI_GEMINI_IMAGE_MODEL]: {
    value: DEFAULT_GEMINI_IMAGE_MODEL,
    type: ConfigValueType.STRING,
    category: ConfigCategory.AI,
    description: 'Gemini model for image generation (e.g., gemini-2.5-flash-image)',
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
    value: ['transparent'],
    type: ConfigValueType.JSON,
    category: ConfigCategory.COMMERCIAL,
    description: 'Commercial image versions to generate (transparent, solid, real, creative)',
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
  [GlobalConfigKey.DEBUG_ENABLED]: {
    value: false,
    type: ConfigValueType.BOOLEAN,
    category: ConfigCategory.DEBUG,
    description: 'Enable debug mode (preserves temp files and S3 uploads for inspection)',
  },

  // Pricing defaults
  [GlobalConfigKey.PRICING_BASE_CREDITS]: {
    value: 1,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PRICING,
    description: 'Base cost per job in credits',
  },
  [GlobalConfigKey.PRICING_CREDITS_PER_SECOND]: {
    value: 0.05,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PRICING,
    description: 'Additional credits per second of video duration (0.05 = 1 credit per 20 seconds)',
  },
  [GlobalConfigKey.PRICING_INCLUDED_FRAMES]: {
    value: 4,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PRICING,
    description: 'Default number of frames included in base price',
  },
  [GlobalConfigKey.PRICING_EXTRA_FRAME_COST]: {
    value: 0.25,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PRICING,
    description: 'Cost per extra frame beyond included amount',
  },
  [GlobalConfigKey.PRICING_COMMERCIAL_VIDEO_ENABLED]: {
    value: false,
    type: ConfigValueType.BOOLEAN,
    category: ConfigCategory.PRICING,
    description: 'Whether commercial video generation add-on is available (coming soon)',
  },
  [GlobalConfigKey.PRICING_COMMERCIAL_VIDEO_COST]: {
    value: 2,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PRICING,
    description: 'Cost for commercial video generation add-on',
  },
  [GlobalConfigKey.PRICING_MIN_JOB_COST]: {
    value: 1,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PRICING,
    description: 'Minimum job cost (floor)',
  },
  [GlobalConfigKey.PRICING_MAX_JOB_COST]: {
    value: 0,
    type: ConfigValueType.NUMBER,
    category: ConfigCategory.PRICING,
    description: 'Maximum job cost (ceiling, 0 = no limit)',
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
  geminiImageModel: string;
  temperature: number;
  topP: number;
  motionAlpha: number;
  minTemporalGap: number;
  topKPercent: number;
  commercialVersions: string[];
  aiCleanup: boolean;
  geminiVideoFps: number;
  geminiVideoMaxFrames: number;
  debugEnabled: boolean;
}

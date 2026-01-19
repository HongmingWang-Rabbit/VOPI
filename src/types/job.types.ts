import { z } from 'zod';

/**
 * Job status enum
 */
export const JobStatus = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  EXTRACTING: 'extracting',
  SCORING: 'scoring',
  CLASSIFYING: 'classifying',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/**
 * Commercial image versions
 */
export const CommercialVersion = {
  TRANSPARENT: 'transparent',
  SOLID: 'solid',
  REAL: 'real',
  CREATIVE: 'creative',
} as const;

export type CommercialVersion = (typeof CommercialVersion)[keyof typeof CommercialVersion];

/**
 * Job configuration schema
 */
export const jobConfigSchema = z.object({
  fps: z.number().min(1).max(30).default(10),
  batchSize: z.number().min(1).max(100).default(30),
  commercialVersions: z
    .array(z.enum(['transparent', 'solid', 'real', 'creative']))
    .default(['transparent', 'solid', 'real', 'creative']),
  aiCleanup: z.boolean().default(true),
  geminiModel: z.string().default('gemini-2.0-flash'),
});

export type JobConfig = z.infer<typeof jobConfigSchema>;

/**
 * Create job request schema
 */
export const createJobSchema = z.object({
  videoUrl: z.string().url(),
  config: jobConfigSchema.optional().default({}),
  callbackUrl: z.string().url().optional(),
});

export type CreateJobRequest = z.infer<typeof createJobSchema>;

/**
 * Frame obstruction information
 */
export interface FrameObstructions {
  has_obstruction: boolean;
  obstruction_types: string[];
  obstruction_description: string | null;
  removable_by_ai: boolean;
}

/**
 * Background recommendations from Gemini
 */
export interface BackgroundRecommendations {
  solid_color: string;
  solid_color_name: string;
  real_life_setting: string;
  creative_shot: string;
}

/**
 * Frame score data
 */
export interface FrameScores {
  sharpness: number;
  motion: number;
  combined: number;
  geminiScore?: number;
}

/**
 * Job progress information
 */
export interface JobProgress {
  step: JobStatus;
  percentage: number;
  framesExtracted?: number;
  framesScored?: number;
  variantsDiscovered?: number;
  imagesGenerated?: number;
  totalSteps: number;
  currentStep: number;
  message?: string;
}

/**
 * Job result on completion
 */
export interface JobResult {
  variantsDiscovered: number;
  framesAnalyzed: number;
  finalFrames: string[];
  commercialImages: Record<string, Record<string, string>>;
}

/**
 * Video metadata
 */
export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  filename: string;
}

/**
 * Job list query params
 */
export const jobListQuerySchema = z.object({
  status: z.enum(['pending', 'downloading', 'extracting', 'scoring', 'classifying', 'generating', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

export type JobListQuery = z.infer<typeof jobListQuerySchema>;

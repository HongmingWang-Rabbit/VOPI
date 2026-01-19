import { z } from 'zod';

/**
 * Environment variable schema validation using Zod
 */
export const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Auth
  API_KEYS: z.string().transform((val) => val.split(',').map((k) => k.trim())),

  // S3/Storage
  S3_BUCKET: z.string(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),

  // External APIs
  GOOGLE_AI_API_KEY: z.string(),
  PHOTOROOM_API_KEY: z.string(),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  JOB_TIMEOUT_MS: z.coerce.number().default(600000), // 10 minutes

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Parse and validate environment variables
 */
export function parseEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.format();
    console.error('Environment validation failed:');
    console.error(JSON.stringify(errors, null, 2));
    throw new Error('Invalid environment configuration');
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * Get validated environment (throws if not initialized)
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    return parseEnv();
  }
  return cachedEnv;
}

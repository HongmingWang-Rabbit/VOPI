import { z } from 'zod';

/** Recommended minimum length for API keys (warning only, not enforced) */
const RECOMMENDED_API_KEY_LENGTH = 16;

/**
 * Warn about short API keys during env parsing.
 * Note: Uses console.warn because the logger is not yet available during env validation
 * (logger depends on config, which depends on env parsing completing first).
 */
const warnAboutShortKeys = (keys: string[], keyType: string): void => {
  const shortKeys = keys.filter((k) => k.length < RECOMMENDED_API_KEY_LENGTH);
  if (shortKeys.length > 0) {
    console.warn(
      `[Security Warning] ${shortKeys.length} ${keyType} key(s) are shorter than ${RECOMMENDED_API_KEY_LENGTH} characters. ` +
        'Consider using longer keys for better security.'
    );
  }
};

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
  DB_POOL_MAX: z.coerce.number().default(20),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().default(2000),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Auth
  API_KEYS: z
    .string()
    .transform((val) => {
      const keys = val.split(',').map((k) => k.trim()).filter(Boolean);
      warnAboutShortKeys(keys, 'API');
      return keys;
    }),
  ADMIN_API_KEYS: z
    .string()
    .default('')
    .transform((val) => {
      const keys = val.split(',').map((k) => k.trim()).filter(Boolean);
      warnAboutShortKeys(keys, 'Admin API');
      return keys;
    }),

  // S3/Storage (S3-compatible storage - MinIO, AWS S3, DigitalOcean Spaces, etc.)
  S3_BUCKET: z.string(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().url(), // Required - e.g., http://localhost:9000 for MinIO, https://s3.us-east-1.amazonaws.com for AWS
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),

  // External APIs
  GOOGLE_AI_API_KEY: z.string(),
  PHOTOROOM_API_KEY: z.string(),
  PHOTOROOM_BASIC_HOST: z.string().default('sdk.photoroom.com'),
  PHOTOROOM_PLUS_HOST: z.string().default('image-api.photoroom.com'),
  CLAID_API_KEY: z.string().optional(),
  STABILITY_API_KEY: z.string().optional(),
  STABILITY_API_BASE: z.string().url().default('https://api.stability.ai'),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  JOB_TIMEOUT_MS: z.coerce.number().default(600000), // 10 minutes
  TEMP_DIR_NAME: z.string().default('vopi'),
  CALLBACK_TIMEOUT_MS: z.coerce.number().default(30000), // 30 seconds
  CALLBACK_MAX_RETRIES: z.coerce.number().default(3),
  API_RETRY_DELAY_MS: z.coerce.number().default(2000),
  API_RATE_LIMIT_DELAY_MS: z.coerce.number().default(500),

  // Audio processing
  AUDIO_PROCESSING_TIMEOUT_MS: z.coerce.number().default(180000), // 3 minutes
  AUDIO_POLLING_INTERVAL_MS: z.coerce.number().default(3000), // 3 seconds
  AUDIO_MAX_RETRIES: z.coerce.number().default(3), // Max retries for audio analysis

  // Queue
  QUEUE_JOB_ATTEMPTS: z.coerce.number().default(3),
  QUEUE_BACKOFF_DELAY_MS: z.coerce.number().default(5000),
  QUEUE_COMPLETED_AGE_SECONDS: z.coerce.number().default(86400), // 24 hours
  QUEUE_FAILED_AGE_SECONDS: z.coerce.number().default(604800), // 7 days

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // CORS
  CORS_ALLOWED_DOMAINS: z
    .string()
    .default('24rabbit\\.com')
    .transform((val) => val.split(',').map((d) => d.trim()).filter(Boolean)),

  // Auth
  AUTH_SKIP_PATHS: z
    .string()
    .default('/health,/ready,/docs,/api/v1/auth,/api/v1/credits/webhook,/api/v1/credits/packs')
    .transform((val) => val.split(',').map((p) => p.trim()).filter(Boolean)),

  // Callback SSRF protection
  CALLBACK_ALLOWED_DOMAINS: z
    .string()
    .default('')
    .transform((val) => val.split(',').map((d) => d.trim()).filter(Boolean)),

  // OAuth success redirect URL (for platform connections like Shopify)
  OAUTH_SUCCESS_REDIRECT_URL: z.string().default('/api/v1/connections?success=shopify'),

  // FFmpeg
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  // Queue counts (for removeOnComplete/removeOnFail)
  QUEUE_COMPLETED_COUNT: z.coerce.number().default(100),
  QUEUE_FAILED_COUNT: z.coerce.number().default(1000),

  // Upload settings
  PRESIGN_EXPIRATION_SECONDS: z.coerce.number().min(60).max(86400).default(3600), // 1 hour default for user uploads

  // API presign settings (for external APIs like Photoroom, Claid)
  API_PRESIGN_EXPIRY_SECONDS: z.coerce.number().min(60).max(3600).default(300), // 5 min default for API calls

  // Config cache
  CONFIG_CACHE_TTL_MS: z.coerce.number().default(60000), // 1 minute

  // JWT Configuration
  JWT_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_TOKEN_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

  // Google OAuth - Web Client (for backend)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Google OAuth - Mobile Clients (for token verification)
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_IOS_BUNDLE_ID: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
  GOOGLE_ANDROID_PACKAGE_NAME: z.string().optional(),

  // Apple OAuth
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),

  // Token Encryption
  TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),

  // Shopify
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_SCOPES: z.string().default('write_products,read_products'),

  // Amazon SP-API
  AMAZON_CLIENT_ID: z.string().optional(),
  AMAZON_CLIENT_SECRET: z.string().optional(),

  // eBay
  EBAY_CLIENT_ID: z.string().optional(),
  EBAY_CLIENT_SECRET: z.string().optional(),
  EBAY_REDIRECT_URI: z.string().url().optional(),
  EBAY_ENVIRONMENT: z.enum(['sandbox', 'production']).default('production'),

  // Token refresh worker
  TOKEN_REFRESH_INTERVAL_MS: z.coerce.number().default(300000), // 5 minutes
  TOKEN_REFRESH_THRESHOLD_MS: z.coerce.number().default(900000), // 15 minutes before expiry
  TOKEN_REFRESH_CONCURRENCY: z.coerce.number().default(5), // Max concurrent token refreshes

  // Stripe (for credit purchases)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID_CREDIT_1: z.string().optional(),
  STRIPE_PRICE_ID_PACK_20: z.string().optional(),
  STRIPE_PRICE_ID_PACK_100: z.string().optional(),
  STRIPE_PRICE_ID_PACK_500: z.string().optional(),

  // Abuse prevention for signup grants
  SIGNUP_GRANT_IP_LIMIT: z.coerce.number().default(3),
  SIGNUP_GRANT_DEVICE_LIMIT: z.coerce.number().default(2),
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
    // Use stderr for pre-logger initialization errors
    process.stderr.write('Environment validation failed:\n');
    process.stderr.write(JSON.stringify(errors, null, 2) + '\n');
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

import { getEnv, parseEnv, type Env } from './env.js';

export { getEnv, parseEnv, type Env };

/**
 * Application configuration derived from environment
 */
export interface AppConfig {
  server: {
    port: number;
    host: string;
    env: 'development' | 'production' | 'test';
  };
  database: {
    url: string;
    poolMax: number;
    poolIdleTimeoutMs: number;
    poolConnectionTimeoutMs: number;
  };
  redis: {
    url: string;
  };
  auth: {
    apiKeys: string[];
    adminApiKeys: string[];
    skipPaths: string[];
  };
  cors: {
    allowedDomains: string[];
  };
  callback: {
    allowedDomains: string[];
  };
  storage: {
    bucket: string;
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  apis: {
    googleAi: string;
    photoroom: string;
    photoroomBasicHost: string;
    photoroomPlusHost: string;
    claid?: string;
    stability?: string;
    stabilityBase: string;
  };
  worker: {
    concurrency: number;
    jobTimeoutMs: number;
    tempDirName: string;
    callbackTimeoutMs: number;
    callbackMaxRetries: number;
    apiRetryDelayMs: number;
    apiRateLimitDelayMs: number;
  };
  audio: {
    processingTimeoutMs: number;
    pollingIntervalMs: number;
    maxRetries: number;
  };
  queue: {
    jobAttempts: number;
    backoffDelayMs: number;
    completedAgeSeconds: number;
    failedAgeSeconds: number;
    completedCount: number;
    failedCount: number;
  };
  logging: {
    level: string;
  };
  ffmpeg: {
    ffmpegPath: string;
    ffprobePath: string;
  };
  upload: {
    presignExpirationSeconds: number;
  };
  apiPresign: {
    expirySeconds: number;
  };
  configCache: {
    ttlMs: number;
  };
}

/**
 * Build application config from validated environment
 */
export function buildConfig(env: Env): AppConfig {
  return {
    server: {
      port: env.PORT,
      host: env.HOST,
      env: env.NODE_ENV,
    },
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      poolIdleTimeoutMs: env.DB_POOL_IDLE_TIMEOUT_MS,
      poolConnectionTimeoutMs: env.DB_POOL_CONNECTION_TIMEOUT_MS,
    },
    redis: {
      url: env.REDIS_URL,
    },
    auth: {
      apiKeys: env.API_KEYS,
      adminApiKeys: env.ADMIN_API_KEYS,
      skipPaths: env.AUTH_SKIP_PATHS,
    },
    cors: {
      allowedDomains: env.CORS_ALLOWED_DOMAINS,
    },
    callback: {
      allowedDomains: env.CALLBACK_ALLOWED_DOMAINS,
    },
    storage: {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
    apis: {
      googleAi: env.GOOGLE_AI_API_KEY,
      photoroom: env.PHOTOROOM_API_KEY,
      photoroomBasicHost: env.PHOTOROOM_BASIC_HOST,
      photoroomPlusHost: env.PHOTOROOM_PLUS_HOST,
      claid: env.CLAID_API_KEY,
      stability: env.STABILITY_API_KEY,
      stabilityBase: env.STABILITY_API_BASE,
    },
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      jobTimeoutMs: env.JOB_TIMEOUT_MS,
      tempDirName: env.TEMP_DIR_NAME,
      callbackTimeoutMs: env.CALLBACK_TIMEOUT_MS,
      callbackMaxRetries: env.CALLBACK_MAX_RETRIES,
      apiRetryDelayMs: env.API_RETRY_DELAY_MS,
      apiRateLimitDelayMs: env.API_RATE_LIMIT_DELAY_MS,
    },
    audio: {
      processingTimeoutMs: env.AUDIO_PROCESSING_TIMEOUT_MS,
      pollingIntervalMs: env.AUDIO_POLLING_INTERVAL_MS,
      maxRetries: env.AUDIO_MAX_RETRIES,
    },
    queue: {
      jobAttempts: env.QUEUE_JOB_ATTEMPTS,
      backoffDelayMs: env.QUEUE_BACKOFF_DELAY_MS,
      completedAgeSeconds: env.QUEUE_COMPLETED_AGE_SECONDS,
      failedAgeSeconds: env.QUEUE_FAILED_AGE_SECONDS,
      completedCount: env.QUEUE_COMPLETED_COUNT,
      failedCount: env.QUEUE_FAILED_COUNT,
    },
    logging: {
      level: env.LOG_LEVEL,
    },
    ffmpeg: {
      ffmpegPath: env.FFMPEG_PATH,
      ffprobePath: env.FFPROBE_PATH,
    },
    upload: {
      presignExpirationSeconds: env.PRESIGN_EXPIRATION_SECONDS,
    },
    apiPresign: {
      expirySeconds: env.API_PRESIGN_EXPIRY_SECONDS,
    },
    configCache: {
      ttlMs: env.CONFIG_CACHE_TTL_MS,
    },
  };
}

let cachedConfig: AppConfig | null = null;

/**
 * Get application configuration
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    const env = getEnv();
    cachedConfig = buildConfig(env);
  }
  return cachedConfig;
}

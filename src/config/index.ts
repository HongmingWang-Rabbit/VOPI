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
    geminiModel: string;
    photoroom: string;
    photoroomBasicHost: string;
    photoroomPlusHost: string;
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
      geminiModel: env.GEMINI_MODEL,
      photoroom: env.PHOTOROOM_API_KEY,
      photoroomBasicHost: env.PHOTOROOM_BASIC_HOST,
      photoroomPlusHost: env.PHOTOROOM_PLUS_HOST,
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

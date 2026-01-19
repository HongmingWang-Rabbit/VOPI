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
  };
  redis: {
    url: string;
  };
  auth: {
    apiKeys: string[];
  };
  storage: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  apis: {
    googleAi: string;
    photoroom: string;
  };
  worker: {
    concurrency: number;
    jobTimeoutMs: number;
  };
  logging: {
    level: string;
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
    },
    redis: {
      url: env.REDIS_URL,
    },
    auth: {
      apiKeys: env.API_KEYS,
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
    },
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      jobTimeoutMs: env.JOB_TIMEOUT_MS,
    },
    logging: {
      level: env.LOG_LEVEL,
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

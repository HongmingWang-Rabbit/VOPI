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
  };
  cors: {
    allowedDomains: string[];
  };
  callback: {
    allowedDomains: string[];
  };
  /** OAuth success redirect URL for platform connections (e.g., Shopify) */
  oauthSuccessRedirectUrl: string;
  /** Allowed URL schemes for OAuth successRedirect param (e.g., ['myapp', 'vopi']) */
  oauthAllowedRedirectSchemes: string[];
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
  jwt: {
    secret?: string;
    accessTokenExpiresIn: string;
    refreshTokenExpiresIn: string;
  };
  googleOAuth: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    // Mobile clients for token verification
    ios?: {
      clientId?: string;
      bundleId?: string;
    };
    android?: {
      clientId?: string;
      packageName?: string;
    };
  };
  appleOAuth: {
    clientId?: string;
    teamId?: string;
    keyId?: string;
    privateKey?: string;
  };
  encryption: {
    tokenKey?: string;
  };
  shopify: {
    apiKey?: string;
    apiSecret?: string;
    scopes: string;
  };
  amazon: {
    clientId?: string;
    clientSecret?: string;
  };
  ebay: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    environment: 'sandbox' | 'production';
  };
  tokenRefresh: {
    intervalMs: number;
    thresholdMs: number;
    concurrency: number;
  };
  stripe: {
    secretKey?: string;
    webhookSecret?: string;
    priceIds: {
      credit1?: string;
      pack20?: string;
      pack100?: string;
      pack500?: string;
    };
  };
  abusePrevention: {
    signupGrantIpLimit: number;
    signupGrantDeviceLimit: number;
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
    },
    cors: {
      allowedDomains: env.CORS_ALLOWED_DOMAINS,
    },
    callback: {
      allowedDomains: env.CALLBACK_ALLOWED_DOMAINS,
    },
    oauthSuccessRedirectUrl: env.OAUTH_SUCCESS_REDIRECT_URL,
    oauthAllowedRedirectSchemes: env.OAUTH_ALLOWED_REDIRECT_SCHEMES,
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
    jwt: {
      secret: env.JWT_SECRET,
      accessTokenExpiresIn: env.JWT_ACCESS_TOKEN_EXPIRES_IN,
      refreshTokenExpiresIn: env.JWT_REFRESH_TOKEN_EXPIRES_IN,
    },
    googleOAuth: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      ios: {
        clientId: env.GOOGLE_IOS_CLIENT_ID,
        bundleId: env.GOOGLE_IOS_BUNDLE_ID,
      },
      android: {
        clientId: env.GOOGLE_ANDROID_CLIENT_ID,
        packageName: env.GOOGLE_ANDROID_PACKAGE_NAME,
      },
    },
    appleOAuth: {
      clientId: env.APPLE_CLIENT_ID,
      teamId: env.APPLE_TEAM_ID,
      keyId: env.APPLE_KEY_ID,
      privateKey: env.APPLE_PRIVATE_KEY,
    },
    encryption: {
      tokenKey: env.TOKEN_ENCRYPTION_KEY,
    },
    shopify: {
      apiKey: env.SHOPIFY_API_KEY,
      apiSecret: env.SHOPIFY_API_SECRET,
      scopes: env.SHOPIFY_SCOPES,
    },
    amazon: {
      clientId: env.AMAZON_CLIENT_ID,
      clientSecret: env.AMAZON_CLIENT_SECRET,
    },
    ebay: {
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
      redirectUri: env.EBAY_REDIRECT_URI,
      environment: env.EBAY_ENVIRONMENT,
    },
    tokenRefresh: {
      intervalMs: env.TOKEN_REFRESH_INTERVAL_MS,
      thresholdMs: env.TOKEN_REFRESH_THRESHOLD_MS,
      concurrency: env.TOKEN_REFRESH_CONCURRENCY,
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      priceIds: {
        credit1: env.STRIPE_PRICE_ID_CREDIT_1,
        pack20: env.STRIPE_PRICE_ID_PACK_20,
        pack100: env.STRIPE_PRICE_ID_PACK_100,
        pack500: env.STRIPE_PRICE_ID_PACK_500,
      },
    },
    abusePrevention: {
      signupGrantIpLimit: env.SIGNUP_GRANT_IP_LIMIT,
      signupGrantDeviceLimit: env.SIGNUP_GRANT_DEVICE_LIMIT,
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

import { describe, it, expect, vi } from 'vitest';
import { envSchema } from './env.js';

// Valid API key for testing (must be at least 16 characters)
const VALID_API_KEY = 'test-api-key-12345';
const VALID_API_KEY_2 = 'test-api-key-67890';
const VALID_API_KEY_3 = 'test-api-key-abcde';

describe('envSchema', () => {
  describe('SERVER configuration', () => {
    it('should use default values when not provided', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: `${VALID_API_KEY},${VALID_API_KEY_2}`,
        S3_BUCKET: 'test-bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        GOOGLE_AI_API_KEY: 'google-key',
        PHOTOROOM_API_KEY: 'photoroom-key',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.PORT).toBe(3000);
        expect(result.data.HOST).toBe('0.0.0.0');
      }
    });

    it('should accept valid NODE_ENV values', () => {
      const envs = ['development', 'production', 'test'];
      for (const env of envs) {
        const result = envSchema.safeParse({
          NODE_ENV: env,
          DATABASE_URL: 'postgres://localhost/test',
          API_KEYS: VALID_API_KEY,
          S3_BUCKET: 'bucket',
          S3_ENDPOINT: 'http://localhost:9000',
          S3_ACCESS_KEY_ID: 'key',
          S3_SECRET_ACCESS_KEY: 'secret',
          GOOGLE_AI_API_KEY: 'key',
          PHOTOROOM_API_KEY: 'key',
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid NODE_ENV', () => {
      const result = envSchema.safeParse({
        NODE_ENV: 'invalid',
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(false);
    });

    it('should coerce PORT to number', () => {
      const result = envSchema.safeParse({
        PORT: '8080',
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
        expect(typeof result.data.PORT).toBe('number');
      }
    });
  });

  describe('DATABASE configuration', () => {
    it('should require DATABASE_URL', () => {
      const result = envSchema.safeParse({
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(false);
    });

    it('should validate DATABASE_URL is a valid URL', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'not-a-url',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(false);
    });

    it('should use default pool settings', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DB_POOL_MAX).toBe(20);
        expect(result.data.DB_POOL_IDLE_TIMEOUT_MS).toBe(30000);
        expect(result.data.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(2000);
      }
    });
  });

  describe('API_KEYS transformation', () => {
    it('should split comma-separated keys into array', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: `${VALID_API_KEY},${VALID_API_KEY_2},${VALID_API_KEY_3}`,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.API_KEYS).toEqual([VALID_API_KEY, VALID_API_KEY_2, VALID_API_KEY_3]);
      }
    });

    it('should trim whitespace from keys', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: ` ${VALID_API_KEY} , ${VALID_API_KEY_2} , ${VALID_API_KEY_3} `,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.API_KEYS).toEqual([VALID_API_KEY, VALID_API_KEY_2, VALID_API_KEY_3]);
      }
    });

    it('should accept short keys with warning (backward compatibility)', () => {
      // Short keys are allowed but trigger a console warning
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: 'short-key',
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('API key(s) are shorter than 16 characters')
      );

      warnSpy.mockRestore();
    });
  });

  describe('CORS_ALLOWED_DOMAINS transformation', () => {
    it('should use default domain pattern', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CORS_ALLOWED_DOMAINS).toEqual(['24rabbit\\.com']);
      }
    });

    it('should split and filter empty domains', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
        CORS_ALLOWED_DOMAINS: 'example.com,,test.com, ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CORS_ALLOWED_DOMAINS).toEqual(['example.com', 'test.com']);
      }
    });
  });

  describe('CALLBACK_ALLOWED_DOMAINS transformation', () => {
    it('should default to empty array', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CALLBACK_ALLOWED_DOMAINS).toEqual([]);
      }
    });
  });

  describe('Worker configuration', () => {
    it('should use default worker settings', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.WORKER_CONCURRENCY).toBe(2);
        expect(result.data.JOB_TIMEOUT_MS).toBe(600000);
        expect(result.data.CALLBACK_TIMEOUT_MS).toBe(30000);
        expect(result.data.CALLBACK_MAX_RETRIES).toBe(3);
      }
    });
  });

  describe('Queue configuration', () => {
    it('should use default queue settings', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.QUEUE_JOB_ATTEMPTS).toBe(3);
        expect(result.data.QUEUE_BACKOFF_DELAY_MS).toBe(5000);
        expect(result.data.QUEUE_COMPLETED_AGE_SECONDS).toBe(86400);
        expect(result.data.QUEUE_FAILED_AGE_SECONDS).toBe(604800);
        expect(result.data.QUEUE_COMPLETED_COUNT).toBe(100);
        expect(result.data.QUEUE_FAILED_COUNT).toBe(1000);
      }
    });
  });

  describe('FFmpeg configuration', () => {
    it('should use default FFmpeg paths', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.FFMPEG_PATH).toBe('ffmpeg');
        expect(result.data.FFPROBE_PATH).toBe('ffprobe');
      }
    });

    it('should accept custom FFmpeg paths', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
        FFMPEG_PATH: '/usr/local/bin/ffmpeg',
        FFPROBE_PATH: '/usr/local/bin/ffprobe',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.FFMPEG_PATH).toBe('/usr/local/bin/ffmpeg');
        expect(result.data.FFPROBE_PATH).toBe('/usr/local/bin/ffprobe');
      }
    });
  });

  describe('Logging configuration', () => {
    it('should use default log level', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LOG_LEVEL).toBe('info');
      }
    });

    it('should accept valid log levels', () => {
      const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
      for (const level of levels) {
        const result = envSchema.safeParse({
          DATABASE_URL: 'postgres://localhost/test',
          API_KEYS: VALID_API_KEY,
          S3_BUCKET: 'bucket',
          S3_ENDPOINT: 'http://localhost:9000',
          S3_ACCESS_KEY_ID: 'key',
          S3_SECRET_ACCESS_KEY: 'secret',
          GOOGLE_AI_API_KEY: 'key',
          PHOTOROOM_API_KEY: 'key',
          LOG_LEVEL: level,
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid log level', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgres://localhost/test',
        API_KEYS: VALID_API_KEY,
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        GOOGLE_AI_API_KEY: 'key',
        PHOTOROOM_API_KEY: 'key',
        LOG_LEVEL: 'verbose',
      });
      expect(result.success).toBe(false);
    });
  });
});

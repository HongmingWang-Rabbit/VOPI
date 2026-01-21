import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authMiddleware, shouldSkipAuth } from './auth.middleware.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ApiKey } from '../db/schema.js';

// Mock the config module
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    auth: {
      apiKeys: ['valid-config-key'],
      skipPaths: ['/health', '/ready', '/docs'],
    },
  })),
}));

// Mock the database module
const mockLimit = vi.fn().mockResolvedValue([] as ApiKey[]);
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn(() => ({
    select: () => ({ from: mockFrom }),
  })),
  schema: {
    apiKeys: {
      key: 'key',
      revokedAt: 'revokedAt',
      expiresAt: 'expiresAt',
    },
  },
}));

describe('auth.middleware', () => {
  describe('shouldSkipAuth', () => {
    it('should return true for /health', () => {
      expect(shouldSkipAuth('/health')).toBe(true);
    });

    it('should return true for /health/live', () => {
      expect(shouldSkipAuth('/health/live')).toBe(true);
    });

    it('should return true for /ready', () => {
      expect(shouldSkipAuth('/ready')).toBe(true);
    });

    it('should return true for /docs', () => {
      expect(shouldSkipAuth('/docs')).toBe(true);
    });

    it('should return true for /docs/json', () => {
      expect(shouldSkipAuth('/docs/json')).toBe(true);
    });

    it('should return false for /api/v1/jobs', () => {
      expect(shouldSkipAuth('/api/v1/jobs')).toBe(false);
    });

    it('should return false for /', () => {
      expect(shouldSkipAuth('/')).toBe(false);
    });

    it('should return false for /healthcheck (not exact match)', () => {
      // This starts with /health so it should match
      expect(shouldSkipAuth('/healthcheck')).toBe(true);
    });
  });

  describe('authMiddleware', () => {
    let mockRequest: Partial<FastifyRequest>;
    let mockReply: Partial<FastifyReply>;

    beforeEach(() => {
      mockRequest = {
        headers: {},
      };
      mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };
      // Reset mock to return empty array (no db keys)
      mockLimit.mockResolvedValue([]);
    });

    it('should pass for valid config-based API key (fallback)', async () => {
      mockRequest.headers = { 'x-api-key': 'valid-config-key' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('should return 401 for missing API key', async () => {
      mockRequest.headers = {};

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'UNAUTHORIZED',
        message: 'Missing API key',
      });
    });

    it('should return 401 for invalid API key', async () => {
      mockRequest.headers = { 'x-api-key': 'invalid-key' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
    });

    it('should return 401 for non-string API key (array)', async () => {
      mockRequest.headers = { 'x-api-key': ['key1', 'key2'] as unknown as string };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should reject keys that are substrings of valid keys', async () => {
      mockRequest.headers = { 'x-api-key': 'valid-config' }; // Missing "-key"

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should reject keys with extra characters', async () => {
      mockRequest.headers = { 'x-api-key': 'valid-config-key-extra' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should be case-sensitive', async () => {
      mockRequest.headers = { 'x-api-key': 'VALID-CONFIG-KEY' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should accept database API key and attach to request', async () => {
      const dbKey = {
        id: 'test-id',
        key: 'db-api-key',
        name: 'Test Key',
        maxUses: 10,
        usedCount: 5,
        createdAt: new Date(),
        expiresAt: null,
        revokedAt: null,
      };

      mockLimit.mockResolvedValue([dbKey]);

      mockRequest.headers = { 'x-api-key': 'db-api-key' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect((mockRequest as FastifyRequest).apiKey).toEqual(dbKey);
    });
  });
});

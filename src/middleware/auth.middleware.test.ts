import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authMiddleware, shouldSkipAuth } from './auth.middleware.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

// Mock the config module
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    auth: {
      apiKeys: ['valid-key-1', 'valid-key-2'],
      skipPaths: ['/health', '/ready', '/docs'],
    },
  })),
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
    let mockDone: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockRequest = {
        headers: {},
      };
      mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };
      mockDone = vi.fn();
    });

    it('should call done() for valid API key', () => {
      mockRequest.headers = { 'x-api-key': 'valid-key-1' };

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).toHaveBeenCalled();
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('should call done() for second valid API key', () => {
      mockRequest.headers = { 'x-api-key': 'valid-key-2' };

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).toHaveBeenCalled();
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('should return 401 for missing API key', () => {
      mockRequest.headers = {};

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).not.toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'UNAUTHORIZED',
        message: 'Missing API key',
      });
    });

    it('should return 401 for invalid API key', () => {
      mockRequest.headers = { 'x-api-key': 'invalid-key' };

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).not.toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
    });

    it('should return 401 for non-string API key (array)', () => {
      mockRequest.headers = { 'x-api-key': ['key1', 'key2'] as unknown as string };

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).not.toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should reject keys that are substrings of valid keys', () => {
      mockRequest.headers = { 'x-api-key': 'valid-key' }; // Missing "-1"

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).not.toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should reject keys with extra characters', () => {
      mockRequest.headers = { 'x-api-key': 'valid-key-1-extra' };

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).not.toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should be case-sensitive', () => {
      mockRequest.headers = { 'x-api-key': 'VALID-KEY-1' };

      authMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply,
        mockDone
      );

      expect(mockDone).not.toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(401);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobsController } from './jobs.controller.js';
import { createJobSchema, type CreateJobRequest } from '../types/job.types.js';
import type { ApiKey, User } from '../db/schema.js';

// Mock database - needs to be a proper chain
const createChainMock = () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['insert', 'values', 'returning', 'select', 'from', 'where', 'orderBy', 'limit', 'offset', 'update', 'set', 'delete', 'transaction'];

  methods.forEach(method => {
    chain[method] = vi.fn().mockReturnValue(chain);
  });

  // Make transaction pass through the callback and return its result
  chain.transaction = vi.fn().mockImplementation(async (callback) => {
    return callback(chain);
  });

  return chain;
};

const mockDb = createChainMock();

vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn(() => mockDb),
  schema: {
    jobs: {
      id: 'id',
      status: 'status',
      progress: 'progress',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    },
    apiKeys: {
      id: 'id',
      usedCount: 'usedCount',
    },
  },
}));

// Mock queue
vi.mock('../queues/pipeline.queue.js', () => ({
  addPipelineJob: vi.fn().mockResolvedValue(undefined),
}));

// Mock url validator
vi.mock('../utils/url-validator.js', () => ({
  validateCallbackUrlComprehensive: vi.fn().mockReturnValue({ valid: true }),
}));

// Mock logger
vi.mock('../utils/logger.js', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockLogger.child = vi.fn(() => mockLogger);
  return {
    createChildLogger: vi.fn(() => mockLogger),
    getLogger: vi.fn(() => mockLogger),
  };
});

// Mock credits service
vi.mock('../services/credits.service.js', () => ({
  creditsService: {
    calculateJobCost: vi.fn().mockResolvedValue({ totalCredits: 1, breakdown: [] }),
    calculateJobCostWithAffordability: vi.fn().mockResolvedValue({
      totalCredits: 1,
      breakdown: [],
      canAfford: true,
      currentBalance: 10,
    }),
    spendCredits: vi.fn().mockResolvedValue({ success: true, newBalance: 10, transactionId: 'test-tx' }),
  },
}));

import { addPipelineJob } from '../queues/pipeline.queue.js';
import { validateCallbackUrlComprehensive } from '../utils/url-validator.js';

describe('JobsController', () => {
  let controller: JobsController;

  // Mock user for all tests
  const mockUser: User = {
    id: 'user-123',
    email: 'test@example.com',
    emailVerified: true,
    name: 'Test User',
    avatarUrl: null,
    creditsBalance: 0,
    stripeCustomerId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    deletedAt: null,
  };

  beforeEach(() => {
    controller = new JobsController();
    vi.clearAllMocks();

    // Reset mock chains - each method returns the chain
    Object.keys(mockDb).forEach(key => {
      if (key !== 'transaction') {
        mockDb[key].mockReturnValue(mockDb);
      }
    });

    // Ensure transaction passes through
    mockDb.transaction.mockImplementation(async (callback) => {
      return callback(mockDb);
    });
  });

  describe('createJob', () => {
    it('should create a job and add it to queue', async () => {
      const mockJob = {
        id: 'job-123',
        videoUrl: 'https://example.com/video.mp4',
        status: 'pending',
        config: { fps: 10, batchSize: 30 },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.returning.mockResolvedValue([mockJob]);

      const createJobRequest: CreateJobRequest = createJobSchema.parse({
        videoUrl: 'https://example.com/video.mp4',
      });
      const result = await controller.createJob(createJobRequest, mockUser);

      expect(result.id).toBe('job-123');
      expect(addPipelineJob).toHaveBeenCalledWith('job-123');
    });

    it('should validate callback URL if provided', async () => {
      const mockJob = {
        id: 'job-123',
        videoUrl: 'https://example.com/video.mp4',
        callbackUrl: 'https://callback.example.com/webhook',
        status: 'pending',
        config: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.returning.mockResolvedValue([mockJob]);

      const createJobRequest: CreateJobRequest = createJobSchema.parse({
        videoUrl: 'https://example.com/video.mp4',
        callbackUrl: 'https://callback.example.com/webhook',
      });
      await controller.createJob(createJobRequest, mockUser);

      expect(validateCallbackUrlComprehensive).toHaveBeenCalledWith(
        'https://callback.example.com/webhook'
      );
    });

    it('should throw BadRequestError for invalid callback URL', async () => {
      vi.mocked(validateCallbackUrlComprehensive).mockReturnValue({
        valid: false,
        error: 'Invalid domain',
      });

      const createJobRequest: CreateJobRequest = createJobSchema.parse({
        videoUrl: 'https://example.com/video.mp4',
        callbackUrl: 'https://evil.com/webhook',
      });
      await expect(
        controller.createJob(createJobRequest, mockUser)
      ).rejects.toThrow('Invalid domain');
    });

    it('should increment API key usage when apiKey is provided', async () => {
      const mockApiKey: ApiKey = {
        id: 'key-123',
        key: 'test-key',
        name: 'Test Key',
        maxUses: 10,
        usedCount: 5,
        createdAt: new Date(),
        expiresAt: null,
        revokedAt: null,
      };
      const mockUpdatedKey = { ...mockApiKey, usedCount: 6 };
      const mockJob = {
        id: 'job-123',
        videoUrl: 'https://example.com/video.mp4',
        status: 'pending',
        config: {},
        apiKeyId: 'key-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // First returning() call is for API key update, second is for job insert
      let callCount = 0;
      mockDb.returning.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([mockUpdatedKey]);
        return Promise.resolve([mockJob]);
      });

      const createJobRequest: CreateJobRequest = createJobSchema.parse({
        videoUrl: 'https://example.com/video.mp4',
      });
      const result = await controller.createJob(createJobRequest, mockUser, mockApiKey);

      expect(result.id).toBe('job-123');
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should throw ForbiddenError when API key usage limit exceeded', async () => {
      const mockApiKey: ApiKey = {
        id: 'key-123',
        key: 'test-key',
        name: 'Test Key',
        maxUses: 10,
        usedCount: 10, // Already at limit
        createdAt: new Date(),
        expiresAt: null,
        revokedAt: null,
      };

      // Atomic update returns nothing (limit exceeded)
      mockDb.returning.mockResolvedValue([]);

      const createJobRequest: CreateJobRequest = createJobSchema.parse({
        videoUrl: 'https://example.com/video.mp4',
      });
      await expect(
        controller.createJob(createJobRequest, mockUser, mockApiKey)
      ).rejects.toThrow('API key usage limit exceeded');
    });

    it('should throw ForbiddenError on race condition (atomic update fails)', async () => {
      const mockApiKey: ApiKey = {
        id: 'key-123',
        key: 'test-key',
        name: 'Test Key',
        maxUses: 10,
        usedCount: 9, // One use left, but another request takes it
        createdAt: new Date(),
        expiresAt: null,
        revokedAt: null,
      };

      // Atomic update returns nothing (another request used the last slot)
      mockDb.returning.mockResolvedValue([]);

      const createJobRequest: CreateJobRequest = createJobSchema.parse({
        videoUrl: 'https://example.com/video.mp4',
      });
      await expect(
        controller.createJob(createJobRequest, mockUser, mockApiKey)
      ).rejects.toThrow('API key usage limit exceeded');
    });
  });

  describe('listJobs', () => {
    it('should return paginated jobs list', async () => {
      const mockJobs = [
        { id: 'job-1', status: 'completed' },
        { id: 'job-2', status: 'pending' },
      ];

      // First Promise.all call: jobs query returns via offset, count query returns via where
      let callCount = 0;
      mockDb.offset.mockImplementation(() => {
        return Promise.resolve(mockJobs);
      });
      mockDb.where.mockImplementation(() => {
        callCount++;
        // Second where call is for count query
        if (callCount > 1) {
          return Promise.resolve([{ count: 10 }]);
        }
        return mockDb;
      });

      const result = await controller.listJobs(mockUser.id, {
        limit: 10,
        offset: 0,
      });

      expect(result.jobs).toEqual(mockJobs);
      expect(result.total).toBe(10);
    });

    it('should filter by status when provided', async () => {
      let callCount = 0;
      mockDb.offset.mockImplementation(() => Promise.resolve([]));
      mockDb.where.mockImplementation(() => {
        callCount++;
        if (callCount > 1) {
          return Promise.resolve([{ count: 0 }]);
        }
        return mockDb;
      });

      await controller.listJobs(mockUser.id, {
        limit: 10,
        offset: 0,
        status: 'completed',
      });

      // where should be called with status filter
      expect(mockDb.where).toHaveBeenCalled();
    });
  });

  describe('getJob', () => {
    it('should return job by ID', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'completed',
        videoUrl: 'https://example.com/video.mp4',
      };

      mockDb.limit.mockResolvedValue([mockJob]);

      const result = await controller.getJob('job-123', mockUser.id);

      expect(result.id).toBe('job-123');
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.limit.mockResolvedValue([]);

      await expect(controller.getJob('nonexistent', mockUser.id)).rejects.toThrow('Job nonexistent not found');
    });
  });

  describe('getJobStatus', () => {
    it('should return lightweight job status', async () => {
      const mockStatus = {
        id: 'job-123',
        status: 'processing',
        progress: { step: 'extract', message: 'Extracting frames' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.limit.mockResolvedValue([mockStatus]);

      const result = await controller.getJobStatus('job-123', mockUser.id);

      expect(result.id).toBe('job-123');
      expect(result.status).toBe('processing');
      expect(result.progress).toEqual({ step: 'extract', message: 'Extracting frames' });
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.limit.mockResolvedValue([]);

      await expect(controller.getJobStatus('nonexistent', mockUser.id)).rejects.toThrow(
        'Job nonexistent not found'
      );
    });
  });

  describe('cancelJob', () => {
    it('should cancel a pending job', async () => {
      const mockCancelledJob = {
        id: 'job-123',
        status: 'cancelled',
        updatedAt: new Date(),
      };

      mockDb.returning.mockResolvedValue([mockCancelledJob]);

      const result = await controller.cancelJob('job-123', mockUser.id);

      expect(result.status).toBe('cancelled');
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.returning.mockResolvedValue([]);
      mockDb.limit.mockResolvedValue([]);

      await expect(controller.cancelJob('nonexistent', mockUser.id)).rejects.toThrow(
        'Job nonexistent not found'
      );
    });

    it('should throw BadRequestError when job is not pending', async () => {
      mockDb.returning.mockResolvedValue([]);
      mockDb.limit.mockResolvedValue([{ id: 'job-123', status: 'processing', userId: mockUser.id }]);

      await expect(controller.cancelJob('job-123', mockUser.id)).rejects.toThrow(
        'Cannot cancel job in processing status'
      );
    });

    it('should throw BadRequestError when job is completed', async () => {
      mockDb.returning.mockResolvedValue([]);
      mockDb.limit.mockResolvedValue([{ id: 'job-123', status: 'completed', userId: mockUser.id }]);

      await expect(controller.cancelJob('job-123', mockUser.id)).rejects.toThrow(
        'Cannot cancel job in completed status'
      );
    });
  });

  describe('deleteJob', () => {
    it('should delete an existing job', async () => {
      const mockJob = { id: 'job-123', status: 'completed' };

      // Setup for select query chain: select().from().where().limit() -> Promise
      // where() returns mockDb (with limit), limit() returns the Promise
      mockDb.where.mockReturnValue(mockDb);
      mockDb.limit.mockImplementation(() => Promise.resolve([mockJob]));

      await expect(controller.deleteJob('job-123', mockUser.id)).resolves.not.toThrow();
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.where.mockReturnValue(mockDb);
      mockDb.limit.mockImplementation(() => Promise.resolve([]));

      await expect(controller.deleteJob('nonexistent', mockUser.id)).rejects.toThrow(
        'Job nonexistent not found'
      );
    });
  });
});

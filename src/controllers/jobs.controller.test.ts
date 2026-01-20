import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobsController } from './jobs.controller.js';

// Mock database - needs to be a proper chain
const createChainMock = () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['insert', 'values', 'returning', 'select', 'from', 'where', 'orderBy', 'limit', 'offset', 'update', 'set', 'delete'];

  methods.forEach(method => {
    chain[method] = vi.fn().mockReturnValue(chain);
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
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { addPipelineJob } from '../queues/pipeline.queue.js';
import { validateCallbackUrlComprehensive } from '../utils/url-validator.js';

describe('JobsController', () => {
  let controller: JobsController;

  beforeEach(() => {
    controller = new JobsController();
    vi.clearAllMocks();

    // Reset mock chains - each method returns the chain
    Object.keys(mockDb).forEach(key => {
      mockDb[key].mockReturnValue(mockDb);
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

      const result = await controller.createJob({
        videoUrl: 'https://example.com/video.mp4',
      } as any);

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

      await controller.createJob({
        videoUrl: 'https://example.com/video.mp4',
        callbackUrl: 'https://callback.example.com/webhook',
      } as any);

      expect(validateCallbackUrlComprehensive).toHaveBeenCalledWith(
        'https://callback.example.com/webhook'
      );
    });

    it('should throw BadRequestError for invalid callback URL', async () => {
      vi.mocked(validateCallbackUrlComprehensive).mockReturnValue({
        valid: false,
        error: 'Invalid domain',
      });

      await expect(
        controller.createJob({
          videoUrl: 'https://example.com/video.mp4',
          callbackUrl: 'https://evil.com/webhook',
        } as any)
      ).rejects.toThrow('Invalid domain');
    });

    it('should increment API key usage when apiKey is provided', async () => {
      const mockApiKey = {
        id: 'key-123',
        key: 'test-key',
        maxUses: 10,
        usedCount: 5,
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

      const result = await controller.createJob(
        { videoUrl: 'https://example.com/video.mp4' } as any,
        mockApiKey as any
      );

      expect(result.id).toBe('job-123');
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should throw ForbiddenError when API key usage limit exceeded', async () => {
      const mockApiKey = {
        id: 'key-123',
        key: 'test-key',
        maxUses: 10,
        usedCount: 10, // Already at limit
      };

      // Atomic update returns nothing (limit exceeded)
      mockDb.returning.mockResolvedValue([]);

      await expect(
        controller.createJob(
          { videoUrl: 'https://example.com/video.mp4' } as any,
          mockApiKey as any
        )
      ).rejects.toThrow('API key usage limit exceeded');
    });

    it('should throw ForbiddenError on race condition (atomic update fails)', async () => {
      const mockApiKey = {
        id: 'key-123',
        key: 'test-key',
        maxUses: 10,
        usedCount: 9, // One use left, but another request takes it
      };

      // Atomic update returns nothing (another request used the last slot)
      mockDb.returning.mockResolvedValue([]);

      await expect(
        controller.createJob(
          { videoUrl: 'https://example.com/video.mp4' } as any,
          mockApiKey as any
        )
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

      const result = await controller.listJobs({
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

      await controller.listJobs({
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

      const result = await controller.getJob('job-123');

      expect(result.id).toBe('job-123');
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.limit.mockResolvedValue([]);

      await expect(controller.getJob('nonexistent')).rejects.toThrow('Job nonexistent not found');
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

      const result = await controller.getJobStatus('job-123');

      expect(result.id).toBe('job-123');
      expect(result.status).toBe('processing');
      expect(result.progress).toEqual({ step: 'extract', message: 'Extracting frames' });
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.limit.mockResolvedValue([]);

      await expect(controller.getJobStatus('nonexistent')).rejects.toThrow(
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

      const result = await controller.cancelJob('job-123');

      expect(result.status).toBe('cancelled');
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.returning.mockResolvedValue([]);
      mockDb.limit.mockResolvedValue([]);

      await expect(controller.cancelJob('nonexistent')).rejects.toThrow(
        'Job nonexistent not found'
      );
    });

    it('should throw BadRequestError when job is not pending', async () => {
      mockDb.returning.mockResolvedValue([]);
      mockDb.limit.mockResolvedValue([{ id: 'job-123', status: 'processing' }]);

      await expect(controller.cancelJob('job-123')).rejects.toThrow(
        'Cannot cancel job in processing status'
      );
    });

    it('should throw BadRequestError when job is completed', async () => {
      mockDb.returning.mockResolvedValue([]);
      mockDb.limit.mockResolvedValue([{ id: 'job-123', status: 'completed' }]);

      await expect(controller.cancelJob('job-123')).rejects.toThrow(
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

      await expect(controller.deleteJob('job-123')).resolves.not.toThrow();
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundError when job not found', async () => {
      mockDb.where.mockReturnValue(mockDb);
      mockDb.limit.mockImplementation(() => Promise.resolve([]));

      await expect(controller.deleteJob('nonexistent')).rejects.toThrow(
        'Job nonexistent not found'
      );
    });
  });
});

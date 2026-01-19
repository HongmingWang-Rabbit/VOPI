import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageService } from './storage.service.js';

// Mock AWS SDK
vi.mock('@aws-sdk/client-s3', () => {
  const mockSend = vi.fn();
  return {
    S3Client: vi.fn().mockImplementation(function () {
      return { send: mockSend };
    }),
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    HeadObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
  };
});

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation(() => ({
    done: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
}));

// Mock fs
vi.mock('fs', () => ({
  createReadStream: vi.fn(() => ({ pipe: vi.fn() })),
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn((event, cb) => {
      if (event === 'finish') setTimeout(cb, 0);
      return { on: vi.fn() };
    }),
    destroy: vi.fn(),
  })),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    storage: {
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: true,
    },
  })),
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

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(() => {
    service = new StorageService();
    vi.clearAllMocks();
  });

  describe('getPublicUrl', () => {
    it('should generate URL with path style for custom endpoint', () => {
      service.init();
      const url = service.getPublicUrl('jobs/123/frame.png');
      expect(url).toBe('http://localhost:9000/test-bucket/jobs/123/frame.png');
    });
  });

  describe('getJobKey', () => {
    it('should generate correct job key', () => {
      const key = service.getJobKey('job-123', 'frames', 'frame_001.png');
      expect(key).toBe('jobs/job-123/frames/frame_001.png');
    });

    it('should sanitize job ID', () => {
      const key = service.getJobKey('../../../etc/passwd', 'frames', 'file.png');
      expect(key).not.toContain('..');
    });

    it('should sanitize path parts', () => {
      const key = service.getJobKey('job-123', '../secret', 'file.png');
      expect(key).not.toContain('..');
    });

    it('should handle special characters in job ID', () => {
      const key = service.getJobKey('job@123!#$%', 'frames', 'file.png');
      expect(key).toMatch(/^jobs\/[a-zA-Z0-9_-]+\/frames\/[a-zA-Z0-9_.-]+$/);
    });

    it('should handle multiple path segments', () => {
      const key = service.getJobKey('job-123', 'commercial', 'variant_1', 'image.png');
      expect(key).toBe('jobs/job-123/commercial/variant_1/image.png');
    });
  });

  describe('sanitizeKeySegment (via getJobKey)', () => {
    it('should remove path traversal attempts', () => {
      const key = service.getJobKey('..', '..', '..');
      expect(key).not.toContain('..');
    });

    it('should remove leading/trailing slashes', () => {
      const key = service.getJobKey('/job/', '/frames/', '/file/');
      expect(key).not.toContain('//');
    });

    it('should replace invalid characters with underscore', () => {
      const key = service.getJobKey('job<>:"|?*', 'frames', 'file.png');
      expect(key).not.toMatch(/[<>:"|?*]/);
    });

    it('should keep alphanumeric, dash, underscore, and dot', () => {
      const key = service.getJobKey('job-123_test', 'frames', 'file.test.png');
      expect(key).toBe('jobs/job-123_test/frames/file.test.png');
    });
  });

  describe('init', () => {
    it('should return existing client if already initialized', () => {
      const client1 = service.init();
      const client2 = service.init();
      expect(client1).toBe(client2);
    });
  });
});

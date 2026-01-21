import { describe, it, expect } from 'vitest';
import { extractS3KeyFromUrl, isUploadedVideoUrl } from './s3-url.js';

describe('s3-url', () => {
  const baseConfig = {
    bucket: 'vopi-storage',
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
  };

  describe('extractS3KeyFromUrl', () => {
    describe('S3 protocol URLs', () => {
      it('should extract key from s3:// URL with matching bucket', () => {
        const url = 's3://vopi-storage/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBe('jobs/123/frames/frame_001.png');
      });

      it('should return null for s3:// URL with different bucket', () => {
        const url = 's3://other-bucket/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBeNull();
      });
    });

    describe('path-style HTTP URLs (configured endpoint)', () => {
      it('should extract key from path-style URL matching endpoint', () => {
        const url = 'http://localhost:9000/vopi-storage/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBe('jobs/123/frames/frame_001.png');
      });

      it('should handle endpoint with trailing slash', () => {
        const config = { ...baseConfig, endpoint: 'http://localhost:9000/' };
        const url = 'http://localhost:9000/vopi-storage/uploads/video.mp4';
        expect(extractS3KeyFromUrl(url, config)).toBe('uploads/video.mp4');
      });

      it('should return null for different endpoint', () => {
        const url = 'http://other-host:9000/vopi-storage/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBeNull();
      });
    });

    describe('path-style HTTP URLs with allowAnyHost', () => {
      it('should extract key from any host when allowAnyHost is true', () => {
        const url = 'http://minio:9000/vopi-storage/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig, { allowAnyHost: true })).toBe(
          'jobs/123/frames/frame_001.png'
        );
      });

      it('should extract key from internal Docker hostname', () => {
        const url = 'http://minio:9000/vopi-storage/commercial/product_1_transparent.png';
        expect(extractS3KeyFromUrl(url, baseConfig, { allowAnyHost: true })).toBe(
          'commercial/product_1_transparent.png'
        );
      });

      it('should return null for different bucket even with allowAnyHost', () => {
        const url = 'http://minio:9000/other-bucket/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig, { allowAnyHost: true })).toBeNull();
      });
    });

    describe('AWS virtual-hosted style URLs', () => {
      it('should extract key from AWS virtual-hosted URL', () => {
        const url = 'https://vopi-storage.s3.us-east-1.amazonaws.com/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBe('jobs/123/frames/frame_001.png');
      });

      it('should handle http:// AWS URLs', () => {
        const url = 'http://vopi-storage.s3.us-east-1.amazonaws.com/uploads/video.mp4';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBe('uploads/video.mp4');
      });

      it('should return null for different region', () => {
        const url = 'https://vopi-storage.s3.eu-west-1.amazonaws.com/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBeNull();
      });

      it('should return null for different bucket', () => {
        const url = 'https://other-bucket.s3.us-east-1.amazonaws.com/jobs/123/frames/frame_001.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should return null for non-S3 URLs', () => {
        const url = 'https://example.com/video.mp4';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBeNull();
      });

      it('should return null for invalid URLs', () => {
        expect(extractS3KeyFromUrl('not-a-url', baseConfig)).toBeNull();
      });

      it('should handle keys with special characters', () => {
        const url = 'http://localhost:9000/vopi-storage/jobs/123/frames/frame_00001_t0.50.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBe('jobs/123/frames/frame_00001_t0.50.png');
      });

      it('should handle deeply nested paths', () => {
        const url = 's3://vopi-storage/a/b/c/d/e/f/file.png';
        expect(extractS3KeyFromUrl(url, baseConfig)).toBe('a/b/c/d/e/f/file.png');
      });

      it('should extract from AWS virtual-hosted URLs when endpoint is different', () => {
        // Even when endpoint is configured for MinIO, we should still be able to extract from AWS URLs
        const config = { bucket: 'vopi-storage', endpoint: 'http://localhost:9000', region: 'us-east-1' };
        const url = 'https://vopi-storage.s3.us-east-1.amazonaws.com/key.png';
        expect(extractS3KeyFromUrl(url, config)).toBe('key.png');
      });
    });
  });

  describe('isUploadedVideoUrl', () => {
    it('should return true for uploads/ prefix', () => {
      const url = 'http://minio:9000/vopi-storage/uploads/abc123.mp4';
      expect(isUploadedVideoUrl(url, baseConfig)).toBe(true);
    });

    it('should return false for non-uploads prefix', () => {
      const url = 'http://minio:9000/vopi-storage/jobs/123/video.mp4';
      expect(isUploadedVideoUrl(url, baseConfig)).toBe(false);
    });

    it('should return false for external URLs', () => {
      const url = 'https://example.com/video.mp4';
      expect(isUploadedVideoUrl(url, baseConfig)).toBe(false);
    });

    it('should handle S3 protocol URLs', () => {
      const url = 's3://vopi-storage/uploads/video.mp4';
      expect(isUploadedVideoUrl(url, baseConfig)).toBe(true);
    });

    it('should handle AWS URLs', () => {
      const url = 'https://vopi-storage.s3.us-east-1.amazonaws.com/uploads/video.mp4';
      expect(isUploadedVideoUrl(url, baseConfig)).toBe(true);
    });
  });
});

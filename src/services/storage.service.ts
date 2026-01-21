import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';

const logger = createChildLogger({ service: 'storage' });

export interface UploadResult {
  key: string;
  url: string;
  size: number;
}

/**
 * StorageService - S3/GCS operations
 */
export class StorageService {
  private client: S3Client | null = null;

  /**
   * Initialize S3 client
   */
  init(): S3Client {
    if (this.client) {
      return this.client;
    }

    const config = getConfig();

    this.client = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      },
      forcePathStyle: config.storage.forcePathStyle,
    });

    logger.info(
      { region: config.storage.region, endpoint: config.storage.endpoint },
      'S3 client initialized'
    );

    return this.client;
  }

  /**
   * Get bucket name
   */
  private getBucket(): string {
    return getConfig().storage.bucket;
  }

  /**
   * Upload a file to S3
   */
  async uploadFile(localPath: string, s3Key: string): Promise<UploadResult> {
    const client = this.init();
    const bucket = this.getBucket();

    const fileStats = await stat(localPath);
    const fileStream = createReadStream(localPath);

    // Determine content type
    const ext = path.extname(localPath).toLowerCase();
    const contentTypeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.json': 'application/json',
    };
    const contentType = contentTypeMap[ext] || 'application/octet-stream';

    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: s3Key,
        Body: fileStream,
        ContentType: contentType,
      },
    });

    await upload.done();

    const url = this.getPublicUrl(s3Key);
    logger.info({ key: s3Key, size: fileStats.size }, 'File uploaded to S3');

    return {
      key: s3Key,
      url,
      size: fileStats.size,
    };
  }

  /**
   * Upload a buffer to S3
   */
  async uploadBuffer(buffer: Buffer, s3Key: string, contentType = 'application/octet-stream'): Promise<UploadResult> {
    const client = this.init();
    const bucket = this.getBucket();

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType,
      })
    );

    const url = this.getPublicUrl(s3Key);
    logger.info({ key: s3Key, size: buffer.length }, 'Buffer uploaded to S3');

    return {
      key: s3Key,
      url,
      size: buffer.length,
    };
  }

  /**
   * Download a file from S3
   */
  async downloadFile(s3Key: string, localPath: string): Promise<void> {
    const client = this.init();
    const bucket = this.getBucket();

    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      })
    );

    if (!response.Body) {
      throw new Error(`No body in S3 response for ${s3Key}`);
    }

    await mkdir(path.dirname(localPath), { recursive: true });

    const writeStream = createWriteStream(localPath);
    await pipeline(response.Body as Readable, writeStream);

    logger.info({ key: s3Key, localPath }, 'File downloaded from S3');
  }

  /**
   * Download file from URL (S3 or HTTP)
   */
  async downloadFromUrl(url: string, localPath: string): Promise<void> {
    // Check if it's an S3 URL
    if (url.startsWith('s3://')) {
      const match = url.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (match) {
        const [, bucket, key] = match;
        // If it's the same bucket, use direct S3 download
        if (bucket === this.getBucket()) {
          await this.downloadFile(key, localPath);
          return;
        }
      }
    }

    // For HTTP(S) URLs, use fetch
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      await mkdir(path.dirname(localPath), { recursive: true });

      // Convert Web ReadableStream to Node.js Readable and use pipeline for proper cleanup
      const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
      const writeStream = createWriteStream(localPath);

      // pipeline automatically handles cleanup on success or error
      await pipeline(nodeStream, writeStream);

      logger.info({ url, localPath }, 'File downloaded from URL');
      return;
    }

    throw new Error(`Unsupported URL scheme: ${url}`);
  }

  /**
   * Check if file exists in S3
   */
  async exists(s3Key: string): Promise<boolean> {
    const client = this.init();
    const bucket = this.getBucket();

    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: s3Key,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a file from S3
   */
  async deleteFile(s3Key: string): Promise<void> {
    const client = this.init();
    const bucket = this.getBucket();

    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      })
    );

    logger.info({ key: s3Key }, 'File deleted from S3');
  }

  /**
   * List files in a prefix
   */
  async listFiles(prefix: string): Promise<string[]> {
    const client = this.init();
    const bucket = this.getBucket();

    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
      })
    );

    return (response.Contents || []).map((obj) => obj.Key!).filter(Boolean);
  }

  /**
   * Get a presigned URL for download
   */
  async getPresignedUrl(s3Key: string, expiresIn = 3600): Promise<string> {
    const client = this.init();
    const bucket = this.getBucket();

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
    });

    return getSignedUrl(client, command, { expiresIn });
  }

  /**
   * Get a presigned URL for upload
   */
  async getPresignedUploadUrl(
    s3Key: string,
    contentType = 'video/mp4',
    expiresIn = 3600
  ): Promise<{ uploadUrl: string; key: string; publicUrl: string }> {
    const client = this.init();
    const bucket = this.getBucket();

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn });
    const publicUrl = this.getPublicUrl(s3Key);

    logger.info({ key: s3Key, expiresIn }, 'Generated presigned upload URL');

    return { uploadUrl, key: s3Key, publicUrl };
  }

  /**
   * Get public URL for a key
   * Works with any S3-compatible storage (MinIO, AWS S3, DigitalOcean Spaces, etc.)
   */
  getPublicUrl(s3Key: string): string {
    const config = getConfig();
    const endpoint = config.storage.endpoint.replace(/\/$/, '');

    if (config.storage.forcePathStyle) {
      // Path-style URL: http://endpoint/bucket/key (required for MinIO and some S3-compatible services)
      return `${endpoint}/${config.storage.bucket}/${s3Key}`;
    }

    // Virtual-hosted-style URL: endpoint/key (for AWS S3, set endpoint to https://bucket.s3.region.amazonaws.com)
    return `${endpoint}/${s3Key}`;
  }

  /**
   * Sanitize a path segment for S3 key usage
   * Removes path traversal attempts and invalid characters
   */
  private sanitizeKeySegment(segment: string): string {
    return segment
      // Remove path traversal attempts
      .replace(/\.\./g, '')
      // Remove leading/trailing slashes
      .replace(/^\/+|\/+$/g, '')
      // Replace multiple slashes with single
      .replace(/\/+/g, '/')
      // Remove potentially dangerous characters, keep alphanumeric, dash, underscore, dot
      .replace(/[^a-zA-Z0-9\-_.]/g, '_');
  }

  /**
   * Generate S3 key for job artifacts
   */
  getJobKey(jobId: string, ...parts: string[]): string {
    const sanitizedJobId = this.sanitizeKeySegment(jobId);
    const sanitizedParts = parts.map((p) => this.sanitizeKeySegment(p));
    return ['jobs', sanitizedJobId, ...sanitizedParts].join('/');
  }
}

export const storageService = new StorageService();

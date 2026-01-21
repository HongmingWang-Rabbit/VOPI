/**
 * S3 URL Utilities
 * Shared utilities for extracting S3 keys from various URL formats
 */

export interface StorageConfig {
  bucket: string;
  endpoint: string;
  region: string;
}

/**
 * Extract S3 key from various URL formats
 *
 * Supports:
 * - S3 protocol: s3://bucket/key
 * - Path-style HTTP: http://endpoint/bucket/key (MinIO, custom endpoints)
 * - Path-style HTTP with any host: http://any-host/bucket/key (internal Docker URLs)
 * - Virtual-hosted AWS: https://bucket.s3.region.amazonaws.com/key
 *
 * @param url - The URL to extract the key from
 * @param config - Storage configuration with bucket, endpoint, and region
 * @param options - Additional options
 * @returns The S3 key or null if not a valid S3 URL for this bucket
 */
export function extractS3KeyFromUrl(
  url: string,
  config: StorageConfig,
  options: { allowAnyHost?: boolean } = {}
): string | null {
  const { allowAnyHost = false } = options;

  // Handle S3 protocol URLs: s3://bucket/key
  if (url.startsWith('s3://')) {
    const match = url.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (match && match[1] === config.bucket) {
      return match[2];
    }
    return null;
  }

  // Handle path-style URLs with any host (for Docker internal URLs like minio:9000)
  // This is useful when stored URLs use internal hostnames but we need to match by bucket
  if (allowAnyHost) {
    const anyHostPattern = new RegExp(`^https?://[^/]+/${config.bucket}/(.+)$`);
    const anyHostMatch = url.match(anyHostPattern);
    if (anyHostMatch) {
      return anyHostMatch[1];
    }
  }

  // Handle path-style HTTP URLs from configured endpoint: http://endpoint/bucket/key
  if (config.endpoint) {
    const endpoint = config.endpoint.replace(/\/$/, '');
    // Escape special regex characters in endpoint
    const escapedEndpoint = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathStylePattern = new RegExp(`^${escapedEndpoint}/${config.bucket}/(.+)$`);
    const match = url.match(pathStylePattern);
    if (match) {
      return match[1];
    }
  }

  // Handle virtual-hosted style AWS URLs: https://bucket.s3.region.amazonaws.com/key
  const awsPattern = new RegExp(
    `^https?://${config.bucket}\\.s3\\.${config.region}\\.amazonaws\\.com/(.+)$`
  );
  const awsMatch = url.match(awsPattern);
  if (awsMatch) {
    return awsMatch[1];
  }

  return null;
}

/**
 * Check if a URL belongs to an S3 uploads prefix (uploaded via presigned URL)
 *
 * @param url - The URL to check
 * @param config - Storage configuration
 * @returns True if the URL is from the uploads prefix
 */
export function isUploadedVideoUrl(url: string, config: StorageConfig): boolean {
  const key = extractS3KeyFromUrl(url, config, { allowAnyHost: true });
  return key !== null && key.startsWith('uploads/');
}

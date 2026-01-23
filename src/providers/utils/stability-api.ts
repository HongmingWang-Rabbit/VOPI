/**
 * Stability AI API Utilities
 *
 * Shared utilities for making requests to Stability AI APIs.
 */

import { ExternalApiError } from '../../utils/errors.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ service: 'stability-api' });

/**
 * Stability API request constants
 */
export const STABILITY_API_CONSTANTS = {
  /** Maximum retry attempts */
  MAX_RETRIES: 3,
  /** Delay between retries in ms */
  RETRY_DELAY_MS: 2000,
  /** Polling interval for async results in ms */
  POLLING_INTERVAL_MS: 3000,
  /** Maximum polling attempts */
  MAX_POLLING_ATTEMPTS: 60,
  /** Maximum input file size (10MB) */
  MAX_INPUT_SIZE_BYTES: 10 * 1024 * 1024,
  /** Maximum pixels allowed by Stability APIs (~9.4M pixels, approximately 3072x3072) */
  MAX_PIXELS: 9_437_184,
} as const;

/**
 * Options for making Stability API requests
 */
export interface StabilityRequestOptions {
  /** API key */
  apiKey: string;
  /** Full endpoint URL */
  endpoint: string;
  /** Form data to send */
  formData: FormData;
  /** Current attempt number (for retries) */
  attempt?: number;
  /** Maximum retries (default: 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 2000) */
  retryDelayMs?: number;
  /** Operation name for logging */
  operationName?: string;
}

/**
 * Delay helper
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make API request to Stability AI with retry logic
 *
 * Handles:
 * - Rate limiting (429) with exponential backoff
 * - Server errors (5xx) with retry
 * - Network errors with retry
 * - Returns binary image data as Buffer
 */
export async function makeStabilityRequest(
  options: StabilityRequestOptions
): Promise<Buffer> {
  const {
    apiKey,
    endpoint,
    formData,
    attempt = 1,
    maxRetries = STABILITY_API_CONSTANTS.MAX_RETRIES,
    retryDelayMs = STABILITY_API_CONSTANTS.RETRY_DELAY_MS,
    operationName = 'stability-api',
  } = options;

  try {
    logger.debug({ endpoint, attempt, operationName }, 'Calling Stability AI API');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'image/*',
      },
      body: formData,
    });

    if (!response.ok) {
      // Try to get error details from response
      let errorDetails = '';
      try {
        const errorBody = await response.text();
        errorDetails = errorBody;
      } catch {
        errorDetails = `HTTP ${response.status}`;
      }

      logger.error({
        status: response.status,
        error: errorDetails.slice(0, 500),
        attempt,
        operationName,
      }, 'Stability API error');

      // Retry on rate limit or server errors
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        logger.warn({ status: response.status, attempt, operationName }, 'Stability API error, retrying...');
        await delay(retryDelayMs * attempt);
        return makeStabilityRequest({ ...options, attempt: attempt + 1 });
      }

      throw new ExternalApiError('Stability', `API error (HTTP ${response.status}): ${errorDetails}`);
    }

    // API returns binary image data directly
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof ExternalApiError) {
      throw error;
    }

    // Retry on network errors
    if (attempt < maxRetries) {
      logger.warn({ error: (error as Error).message, attempt, operationName }, 'Stability request failed, retrying...');
      await delay(retryDelayMs * attempt);
      return makeStabilityRequest({ ...options, attempt: attempt + 1 });
    }

    throw new ExternalApiError('Stability', `Request failed: ${(error as Error).message}`);
  }
}

/**
 * Options for making async Stability API requests (with polling)
 */
export interface StabilityAsyncRequestOptions extends StabilityRequestOptions {
  /** API base URL for polling */
  apiBase: string;
  /** Polling interval in ms */
  pollingIntervalMs?: number;
  /** Maximum polling attempts */
  maxPollingAttempts?: number;
}

/**
 * Make async API request to Stability AI with polling for result
 *
 * Some Stability AI endpoints return 202 with a result ID that needs to be polled.
 * This function handles both sync and async responses.
 */
export async function makeStabilityAsyncRequest(
  options: StabilityAsyncRequestOptions
): Promise<Buffer> {
  const {
    apiKey,
    endpoint,
    formData,
    apiBase,
    attempt = 1,
    maxRetries = STABILITY_API_CONSTANTS.MAX_RETRIES,
    retryDelayMs = STABILITY_API_CONSTANTS.RETRY_DELAY_MS,
    pollingIntervalMs = STABILITY_API_CONSTANTS.POLLING_INTERVAL_MS,
    maxPollingAttempts = STABILITY_API_CONSTANTS.MAX_POLLING_ATTEMPTS,
    operationName = 'stability-async-api',
  } = options;

  try {
    logger.debug({ endpoint, attempt, operationName }, 'Calling Stability AI async API');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'image/*',
      },
      body: formData,
    });

    // Check for async response (generation ID)
    if (response.status === 202) {
      // Try to get result ID from header first, then from JSON body
      let resultId: string | null = response.headers.get('id');

      if (!resultId) {
        try {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const jsonBody = await response.json() as { id?: string };
            resultId = jsonBody.id ?? null;
          }
        } catch {
          // Ignore JSON parse errors
        }
      }

      if (resultId) {
        return pollForResult({
          apiKey,
          apiBase,
          resultId,
          pollingIntervalMs,
          maxPollingAttempts,
          operationName,
        });
      }
      throw new ExternalApiError('Stability', 'Async generation started but no result ID returned');
    }

    if (!response.ok) {
      let errorDetails = '';
      try {
        const errorBody = await response.text();
        errorDetails = errorBody;
      } catch {
        errorDetails = `HTTP ${response.status}`;
      }

      logger.error({
        status: response.status,
        error: errorDetails.slice(0, 500),
        attempt,
        operationName,
      }, 'Stability async API error');

      // Retry on rate limit or server errors
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        logger.warn({ status: response.status, attempt, operationName }, 'Stability API error, retrying...');
        await delay(retryDelayMs * attempt);
        return makeStabilityAsyncRequest({ ...options, attempt: attempt + 1 });
      }

      throw new ExternalApiError('Stability', `Async API error (HTTP ${response.status}): ${errorDetails}`);
    }

    // Synchronous response - return binary image data directly
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof ExternalApiError) {
      throw error;
    }

    // Retry on network errors
    if (attempt < maxRetries) {
      logger.warn({ error: (error as Error).message, attempt, operationName }, 'Stability async request failed, retrying...');
      await delay(retryDelayMs * attempt);
      return makeStabilityAsyncRequest({ ...options, attempt: attempt + 1 });
    }

    throw new ExternalApiError('Stability', `Async request failed: ${(error as Error).message}`);
  }
}

/**
 * Options for polling for async result
 */
interface PollForResultOptions {
  apiKey: string;
  apiBase: string;
  resultId: string;
  pollingIntervalMs?: number;
  maxPollingAttempts?: number;
  operationName?: string;
}

/**
 * Poll for async generation result
 */
async function pollForResult(options: PollForResultOptions): Promise<Buffer> {
  const {
    apiKey,
    apiBase,
    resultId,
    pollingIntervalMs = STABILITY_API_CONSTANTS.POLLING_INTERVAL_MS,
    maxPollingAttempts = STABILITY_API_CONSTANTS.MAX_POLLING_ATTEMPTS,
    operationName = 'stability-poll',
  } = options;

  const resultEndpoint = `${apiBase}/v2beta/stable-image/results/${resultId}`;

  for (let attempt = 0; attempt < maxPollingAttempts; attempt++) {
    await delay(pollingIntervalMs);

    logger.debug({ resultId, attempt, operationName }, 'Polling for generation result');

    try {
      const response = await fetch(resultEndpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'image/*',
        },
      });

      if (response.status === 202) {
        // Still processing
        continue;
      }

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      const errorText = await response.text();
      throw new ExternalApiError('Stability', `Result polling failed (HTTP ${response.status}): ${errorText}`);
    } catch (error) {
      // Retry on network errors during polling
      if (!(error instanceof ExternalApiError) && attempt < maxPollingAttempts - 1) {
        logger.warn({ error: (error as Error).message, attempt, operationName }, 'Polling request failed, will retry');
        continue;
      }
      throw error;
    }
  }

  throw new ExternalApiError('Stability', 'Generation timed out after polling');
}

/**
 * Parse hex color to RGBA object with validation
 *
 * @param hex - Hex color string (e.g., '#FFFFFF' or 'FFFFFF')
 * @returns RGBA object with validated values
 */
export function parseHexColor(hex: string): { r: number; g: number; b: number; alpha: number } {
  // Default to white if invalid
  const defaultColor = { r: 255, g: 255, b: 255, alpha: 1 };

  if (!hex || typeof hex !== 'string') {
    logger.warn({ hex }, 'Invalid hex color, using default white');
    return defaultColor;
  }

  const cleanHex = hex.trim().replace(/^#/, '');

  // Validate hex string format
  if (!/^[0-9A-Fa-f]{6}$/.test(cleanHex)) {
    logger.warn({ hex }, 'Invalid hex color format, using default white');
    return defaultColor;
  }

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);

  // Validate parsed values (should never fail after regex check, but be safe)
  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    logger.warn({ hex, r, g, b }, 'Failed to parse hex color, using default white');
    return defaultColor;
  }

  return { r, g, b, alpha: 1 };
}

/**
 * Check if image file size is within Stability AI limits
 *
 * @param sizeBytes - File size in bytes
 * @returns true if within limits
 */
export function isWithinSizeLimit(sizeBytes: number): boolean {
  return sizeBytes <= STABILITY_API_CONSTANTS.MAX_INPUT_SIZE_BYTES;
}

/**
 * Get human-readable file size error message
 */
export function getFileSizeError(sizeBytes: number): string {
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
  const limitMB = (STABILITY_API_CONSTANTS.MAX_INPUT_SIZE_BYTES / 1024 / 1024).toFixed(0);
  return `Image too large: ${sizeMB}MB exceeds ${limitMB}MB limit`;
}

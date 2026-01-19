import { getConfig } from '../config/index.js';

/**
 * URL validation utilities for SSRF protection
 */

/**
 * Check if a callback URL is allowed based on configured domains
 * @param url - The callback URL to validate
 * @returns true if the URL is allowed, false otherwise
 */
export function isCallbackUrlAllowed(url: string): boolean {
  const config = getConfig();
  const allowedDomains = config.callback.allowedDomains;

  // If no domains are configured, allow all (not recommended for production)
  if (allowedDomains.length === 0) {
    return true;
  }

  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    // Check if hostname matches any allowed domain (including subdomains)
    return allowedDomains.some((domain) => {
      const domainLower = domain.toLowerCase();
      // Exact match or subdomain match
      return hostname === domainLower || hostname.endsWith(`.${domainLower}`);
    });
  } catch {
    // Invalid URL
    return false;
  }
}

/**
 * Validate callback URL and throw if not allowed
 * @param url - The callback URL to validate
 * @throws Error if the URL is not allowed
 */
export function validateCallbackUrl(url: string): void {
  if (!isCallbackUrlAllowed(url)) {
    const config = getConfig();
    const allowedDomains = config.callback.allowedDomains;

    if (allowedDomains.length > 0) {
      throw new Error(
        `Callback URL domain not allowed. Allowed domains: ${allowedDomains.join(', ')}`
      );
    }
  }
}

/**
 * Check if a URL uses a safe protocol (http or https)
 * @param url - The URL to check
 * @returns true if the protocol is safe
 */
export function isSafeProtocol(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Check if a URL points to a private/internal IP address
 * This helps prevent SSRF attacks against internal services
 * @param url - The URL to check
 * @returns true if the URL appears to target a private IP
 */
export function isPrivateUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    // Check for localhost variants
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    ) {
      return true;
    }

    // Check for private IP ranges (basic check)
    // 10.0.0.0/8
    if (hostname.startsWith('10.')) {
      return true;
    }

    // 172.16.0.0/12
    if (hostname.startsWith('172.')) {
      const secondOctet = parseInt(hostname.split('.')[1], 10);
      if (secondOctet >= 16 && secondOctet <= 31) {
        return true;
      }
    }

    // 192.168.0.0/16
    if (hostname.startsWith('192.168.')) {
      return true;
    }

    // 169.254.0.0/16 (link-local)
    if (hostname.startsWith('169.254.')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Comprehensive callback URL validation
 * @param url - The callback URL to validate
 * @returns An object with validation result and optional error message
 */
export function validateCallbackUrlComprehensive(url: string): {
  valid: boolean;
  error?: string;
} {
  // Check protocol
  if (!isSafeProtocol(url)) {
    return { valid: false, error: 'Callback URL must use http or https protocol' };
  }

  // Check for private IPs (potential SSRF)
  if (isPrivateUrl(url)) {
    const config = getConfig();
    // Allow private URLs in development mode
    if (config.server.env !== 'development') {
      return { valid: false, error: 'Callback URL cannot target private/internal addresses' };
    }
  }

  // Check against allowed domains
  if (!isCallbackUrlAllowed(url)) {
    const config = getConfig();
    const allowedDomains = config.callback.allowedDomains;
    return {
      valid: false,
      error: `Callback URL domain not allowed. Allowed domains: ${allowedDomains.join(', ')}`,
    };
  }

  return { valid: true };
}

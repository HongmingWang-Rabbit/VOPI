import { randomBytes } from 'crypto';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import { encryptionService } from '../encryption.service.js';
import type { AmazonConnectionMetadata } from '../../types/auth.types.js';

const logger = getLogger().child({ service: 'amazon-oauth' });

// Amazon Login with Amazon (LWA) endpoints
const AMAZON_AUTH_URL = 'https://www.amazon.com/ap/oa';
const AMAZON_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

interface AmazonTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Amazon SP-API OAuth service
 * Handles Login with Amazon (LWA) OAuth flow for SP-API access
 * Note: Amazon access tokens expire in 1 hour
 */
class AmazonOAuthService {
  /**
   * Get Amazon OAuth configuration
   */
  private getConfig() {
    const config = getConfig();

    if (!config.amazon.clientId || !config.amazon.clientSecret) {
      throw new Error('Amazon OAuth is not configured');
    }

    return {
      clientId: config.amazon.clientId,
      clientSecret: config.amazon.clientSecret,
    };
  }

  /**
   * Generate a random state for CSRF protection
   */
  generateState(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Generate OAuth authorization URL for Amazon SP-API
   */
  getAuthorizationUrl(redirectUri: string, state: string): string {
    const { clientId } = this.getConfig();

    // SP-API requires specific scope format
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'profile', // Basic profile for LWA
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });

    return `${AMAZON_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Get SP-API authorization URL
   * This is for full SP-API access (requires seller approval)
   */
  getSPAPIAuthorizationUrl(
    redirectUri: string,
    state: string,
    appId: string
  ): string {
    const params = new URLSearchParams({
      application_id: appId,
      state,
      redirect_uri: redirectUri,
    });

    return `https://sellercentral.amazon.com/apps/authorize/consent?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(
    code: string,
    redirectUri: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const { clientId, clientSecret } = this.getConfig();

    logger.debug('Exchanging Amazon authorization code');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch(AMAZON_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token exchange failed');
      throw new Error(`Amazon token exchange failed: ${error}`);
    }

    const data = (await response.json()) as AmazonTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(
    refreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const { clientId, clientSecret } = this.getConfig();

    logger.debug('Refreshing Amazon access token');

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch(AMAZON_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token refresh failed');
      throw new Error(`Amazon token refresh failed: ${error}`);
    }

    const data = (await response.json()) as AmazonTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // May not return new refresh token
      expiresIn: data.expires_in,
    };
  }

  /**
   * Get seller info using the SP-API
   * This requires the amazon-sp-api library for proper AWS signature
   */
  async getSellerInfo(
    _accessToken: string,
    _refreshToken: string
  ): Promise<AmazonConnectionMetadata> {
    // Note: In production, use amazon-sp-api library for proper API calls
    // This is a simplified version - actual implementation would use the SP-API SDK

    // For now, we'll create a basic metadata object
    // The actual seller ID would be obtained during the SP-API authorization flow
    logger.debug('Creating Amazon connection metadata');

    return {
      sellerId: 'pending', // Will be populated from SP-API authorization
      marketplaceIds: ['ATVPDKIKX0DER'], // Default to US marketplace
      region: 'na', // North America
    };
  }

  /**
   * Verify token is still valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    // Make a simple request to verify token
    // In production, this would use the SP-API
    try {
      const response = await fetch('https://api.amazon.com/user/profile', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt tokens for storage
   */
  encryptToken(token: string): string {
    return encryptionService.encrypt(token);
  }

  /**
   * Decrypt stored token
   */
  decryptToken(encryptedToken: string): string {
    return encryptionService.decrypt(encryptedToken);
  }

  /**
   * Check if Amazon OAuth is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!(config.amazon.clientId && config.amazon.clientSecret);
  }
}

export const amazonOAuthService = new AmazonOAuthService();

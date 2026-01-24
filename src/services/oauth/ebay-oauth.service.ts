import { randomBytes } from 'crypto';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import { encryptionService } from '../encryption.service.js';
import type { EbayConnectionMetadata } from '../../types/auth.types.js';

const logger = getLogger().child({ service: 'ebay-oauth' });

// eBay OAuth endpoints
const EBAY_SANDBOX_AUTH_URL = 'https://auth.sandbox.ebay.com/oauth2/authorize';
const EBAY_SANDBOX_TOKEN_URL = 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
const EBAY_PRODUCTION_AUTH_URL = 'https://auth.ebay.com/oauth2/authorize';
const EBAY_PRODUCTION_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

// eBay scopes for selling APIs
const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
].join(' ');

interface EbayTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in?: number;
}

interface EbayUserInfo {
  userId: string;
  username?: string;
}

/**
 * eBay OAuth service
 * Handles OAuth 2.0 flow for eBay API access
 * Note: eBay access tokens expire in 2 hours, refresh tokens in 18 months
 */
class EbayOAuthService {
  /**
   * Get eBay OAuth configuration
   */
  private getConfig() {
    const config = getConfig();

    if (!config.ebay.clientId || !config.ebay.clientSecret) {
      throw new Error('eBay OAuth is not configured');
    }

    return {
      clientId: config.ebay.clientId,
      clientSecret: config.ebay.clientSecret,
      redirectUri: config.ebay.redirectUri,
      environment: config.ebay.environment,
    };
  }

  /**
   * Get the appropriate URL based on environment
   */
  private getUrls() {
    const { environment } = this.getConfig();

    if (environment === 'sandbox') {
      return {
        authUrl: EBAY_SANDBOX_AUTH_URL,
        tokenUrl: EBAY_SANDBOX_TOKEN_URL,
      };
    }

    return {
      authUrl: EBAY_PRODUCTION_AUTH_URL,
      tokenUrl: EBAY_PRODUCTION_TOKEN_URL,
    };
  }

  /**
   * Generate a random state for CSRF protection
   */
  generateState(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthorizationUrl(redirectUri: string, state: string): string {
    const { clientId } = this.getConfig();
    const { authUrl } = this.getUrls();

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: EBAY_SCOPES,
      state,
    });

    return `${authUrl}?${params.toString()}`;
  }

  /**
   * Get Basic Auth header for token requests
   */
  private getAuthHeader(): string {
    const { clientId, clientSecret } = this.getConfig();
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(
    code: string,
    redirectUri: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const { tokenUrl } = this.getUrls();

    logger.debug('Exchanging eBay authorization code');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getAuthHeader(),
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token exchange failed');
      throw new Error(`eBay token exchange failed: ${error}`);
    }

    const data = (await response.json()) as EbayTokenResponse;

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
    const { tokenUrl } = this.getUrls();

    logger.debug('Refreshing eBay access token');

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: EBAY_SCOPES,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getAuthHeader(),
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token refresh failed');
      throw new Error(`eBay token refresh failed: ${error}`);
    }

    const data = (await response.json()) as EbayTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // May not return new refresh token
      expiresIn: data.expires_in,
    };
  }

  /**
   * Get user info from eBay
   */
  async getUserInfo(accessToken: string): Promise<EbayUserInfo> {
    const { environment } = this.getConfig();
    const baseUrl = environment === 'sandbox'
      ? 'https://api.sandbox.ebay.com'
      : 'https://api.ebay.com';

    logger.debug('Fetching eBay user info');

    // Use Identity API to get user info
    const response = await fetch(`${baseUrl}/commerce/identity/v1/user/`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // If identity API fails, try to get basic info from account API
      logger.warn('Identity API failed, using fallback');
      return {
        userId: 'unknown',
      };
    }

    const data = await response.json();

    return {
      userId: data.userId || data.username || 'unknown',
      username: data.username,
    };
  }

  /**
   * Get connection metadata
   */
  async getConnectionMetadata(accessToken: string): Promise<EbayConnectionMetadata> {
    const { environment } = this.getConfig();
    const userInfo = await this.getUserInfo(accessToken);

    return {
      userId: userInfo.userId,
      username: userInfo.username,
      marketplaceId: 'EBAY_US', // Default to US marketplace
      environment,
    };
  }

  /**
   * Verify token is still valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    const { environment } = this.getConfig();
    const baseUrl = environment === 'sandbox'
      ? 'https://api.sandbox.ebay.com'
      : 'https://api.ebay.com';

    try {
      const response = await fetch(`${baseUrl}/commerce/identity/v1/user/`, {
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
   * Encrypt token for storage
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
   * Check if eBay OAuth is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!(config.ebay.clientId && config.ebay.clientSecret);
  }
}

export const ebayOAuthService = new EbayOAuthService();

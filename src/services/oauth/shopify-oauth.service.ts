import { createHmac, timingSafeEqual } from 'crypto';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import { encryptionService } from '../encryption.service.js';
import { SHOPIFY_API_VERSION } from '../../utils/constants.js';
import type { ShopifyConnectionMetadata } from '../../types/auth.types.js';

const logger = getLogger().child({ service: 'shopify-oauth' });

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  expires_in?: number;
  associated_user_scope?: string;
  associated_user?: {
    id: number;
    first_name: string;
    last_name: string;
    email: string;
    email_verified: boolean;
    account_owner: boolean;
    locale: string;
    collaborator: boolean;
  };
}

interface ShopifyShopInfo {
  shop: {
    id: number;
    name: string;
    email: string;
    domain: string;
    myshopify_domain: string;
    shop_owner: string;
    primary_locale: string;
    timezone: string;
    currency: string;
    country_code: string;
  };
}

/**
 * Shopify OAuth service
 * Handles OAuth 2.0 flow for Shopify Admin API access
 * Note: Shopify offline tokens don't expire
 */
class ShopifyOAuthService {
  /**
   * Get Shopify OAuth configuration
   */
  private getConfig() {
    const config = getConfig();

    if (!config.shopify.apiKey || !config.shopify.apiSecret) {
      throw new Error('Shopify OAuth is not configured');
    }

    return {
      apiKey: config.shopify.apiKey,
      apiSecret: config.shopify.apiSecret,
      scopes: config.shopify.scopes,
    };
  }

  /**
   * Generate OAuth authorization URL for a shop
   */
  getAuthorizationUrl(shop: string, redirectUri: string, state: string): string {
    const { apiKey, scopes } = this.getConfig();

    // Ensure shop is in correct format
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

    const params = new URLSearchParams({
      client_id: apiKey,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
    });

    return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
  }

  /**
   * Verify HMAC signature from Shopify callback
   */
  verifyHmac(query: Record<string, string>): boolean {
    const { apiSecret } = this.getConfig();

    const hmac = query.hmac;
    if (!hmac) return false;

    // Create message from all params except hmac
    const params = { ...query };
    delete params.hmac;
    delete params.signature; // Legacy parameter

    // Sort parameters alphabetically and create query string
    const message = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    // Calculate HMAC
    const calculatedHmac = createHmac('sha256', apiSecret)
      .update(message)
      .digest('hex');

    // Timing-safe comparison using Node.js stdlib
    if (hmac.length !== calculatedHmac.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(hmac), Buffer.from(calculatedHmac));
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCode(
    shop: string,
    code: string
  ): Promise<{ accessToken: string; scope: string }> {
    const { apiKey, apiSecret } = this.getConfig();

    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

    logger.debug({ shop: shopDomain }, 'Exchanging Shopify authorization code');

    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: apiKey,
        client_secret: apiSecret,
        code,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error, shop: shopDomain }, 'Token exchange failed');
      throw new Error(`Shopify token exchange failed: ${error}`);
    }

    const data = (await response.json()) as ShopifyTokenResponse;

    return {
      accessToken: data.access_token,
      scope: data.scope,
    };
  }

  /**
   * Get shop info using access token
   */
  async getShopInfo(
    shop: string,
    accessToken: string
  ): Promise<ShopifyConnectionMetadata> {
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

    logger.debug({ shop: shopDomain }, 'Fetching Shopify shop info');

    const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error, shop: shopDomain }, 'Shop info fetch failed');
      throw new Error(`Failed to get Shopify shop info: ${error}`);
    }

    const data = (await response.json()) as ShopifyShopInfo;

    return {
      shop: shopDomain,
      shopName: data.shop.name,
      shopId: String(data.shop.id),
    };
  }

  /**
   * Verify token is still valid by making a test request
   */
  async verifyToken(shop: string, accessToken: string): Promise<boolean> {
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

    try {
      const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt access token for storage
   */
  encryptToken(token: string): string {
    return encryptionService.encrypt(token);
  }

  /**
   * Decrypt stored access token
   */
  decryptToken(encryptedToken: string): string {
    return encryptionService.decrypt(encryptedToken);
  }

  /**
   * Verify HMAC signature from Shopify webhook request body
   */
  verifyWebhookHmac(rawBody: Buffer, hmacHeader: string): boolean {
    const { apiSecret } = this.getConfig();

    const calculatedHmac = createHmac('sha256', apiSecret)
      .update(rawBody)
      .digest('base64');

    if (hmacHeader.length !== calculatedHmac.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(calculatedHmac));
  }

  /**
   * Check if Shopify OAuth is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!(config.shopify.apiKey && config.shopify.apiSecret);
  }
}

export const shopifyOAuthService = new ShopifyOAuthService();

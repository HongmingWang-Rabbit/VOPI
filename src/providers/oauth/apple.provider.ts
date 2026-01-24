import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import type {
  OAuthUserProfile,
  OAuthTokens,
  AppleProviderData,
} from '../../types/auth.types.js';

const logger = getLogger().child({ provider: 'apple-oauth' });

const APPLE_AUTH_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

interface AppleAuthOptions {
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  responseMode?: 'query' | 'fragment' | 'form_post';
}

interface AppleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
  id_token: string;
}

interface AppleIdTokenPayload extends JWTPayload {
  sub: string; // User's unique identifier
  at_hash?: string;
  email?: string;
  email_verified?: string | boolean;
  is_private_email?: string | boolean;
  auth_time: number;
  nonce_supported: boolean;
  real_user_status?: number;
}

/**
 * Apple OAuth provider
 * Note: Apple's OAuth uses JWT-based client secrets that must be regenerated
 */
class AppleOAuthProvider {
  // Remote JWK Set with automatic caching and refresh (handled by jose)
  private readonly JWKS = createRemoteJWKSet(new URL(APPLE_KEYS_URL));

  /**
   * Get Apple OAuth configuration
   */
  private getConfig() {
    const config = getConfig();

    if (
      !config.appleOAuth.clientId ||
      !config.appleOAuth.teamId ||
      !config.appleOAuth.keyId ||
      !config.appleOAuth.privateKey
    ) {
      throw new Error('Apple OAuth is not configured');
    }

    return {
      clientId: config.appleOAuth.clientId,
      teamId: config.appleOAuth.teamId,
      keyId: config.appleOAuth.keyId,
      privateKey: config.appleOAuth.privateKey.replace(/\\n/g, '\n'),
    };
  }

  /**
   * Generate client secret JWT for Apple
   * Apple requires a JWT signed with the private key
   */
  private generateClientSecret(): string {
    const { clientId, teamId, keyId, privateKey } = this.getConfig();

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: teamId,
      iat: now,
      exp: now + 180 * 24 * 60 * 60, // 180 days max
      aud: 'https://appleid.apple.com',
      sub: clientId,
    };

    return jwt.sign(payload, privateKey, {
      algorithm: 'ES256',
      keyid: keyId,
    });
  }

  /**
   * Generate a random state parameter for CSRF protection
   */
  generateState(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * Generate Apple OAuth authorization URL
   */
  getAuthorizationUrl(options: AppleAuthOptions): string {
    const { clientId } = this.getConfig();

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: 'name email',
      response_mode: options.responseMode ?? 'form_post',
    });

    if (options.state) {
      params.set('state', options.state);
    }

    if (options.codeChallenge) {
      params.set('code_challenge', options.codeChallenge);
      params.set('code_challenge_method', options.codeChallengeMethod ?? 'S256');
    }

    return `${APPLE_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthTokens> {
    const { clientId } = this.getConfig();
    const clientSecret = this.generateClientSecret();

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    if (codeVerifier) {
      params.set('code_verifier', codeVerifier);
    }

    logger.debug('Exchanging authorization code for tokens');

    const response = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token exchange failed');
      throw new Error(`Apple token exchange failed: ${error}`);
    }

    const data = (await response.json()) as AppleTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      idToken: data.id_token,
    };
  }

  /**
   * Decode and verify ID token using jose library
   * Uses createRemoteJWKSet for automatic key fetching, caching, and rotation
   */
  async decodeIdToken(idToken: string): Promise<OAuthUserProfile> {
    const { clientId } = this.getConfig();

    try {
      // Verify and decode token using jose
      // The JWKS handles key fetching, caching, and rotation automatically
      const { payload } = await jwtVerify(idToken, this.JWKS, {
        issuer: 'https://appleid.apple.com',
        audience: clientId,
      });

      const decoded = payload as AppleIdTokenPayload;

      // Extract user info
      const isPrivateEmail =
        decoded.is_private_email === 'true' || decoded.is_private_email === true;
      const emailVerified =
        decoded.email_verified === 'true' || decoded.email_verified === true;

      const providerData: AppleProviderData = {
        isPrivateEmail,
        realUserStatus: decoded.real_user_status,
      };

      if (!decoded.email) {
        throw new Error('Email not provided in Apple ID token');
      }

      return {
        id: decoded.sub,
        email: decoded.email,
        emailVerified,
        providerData,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to verify Apple ID token');
      throw new Error('Invalid Apple ID token');
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const { clientId } = this.getConfig();
    const clientSecret = this.generateClientSecret();

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    logger.debug('Refreshing Apple access token');

    const response = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token refresh failed');
      throw new Error(`Apple token refresh failed: ${error}`);
    }

    const data = (await response.json()) as AppleTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: refreshToken, // Apple doesn't return new refresh token
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      idToken: data.id_token,
    };
  }

  /**
   * Revoke a token
   */
  async revokeToken(token: string, tokenTypeHint: 'access_token' | 'refresh_token'): Promise<void> {
    const { clientId } = this.getConfig();
    const clientSecret = this.generateClientSecret();

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token,
      token_type_hint: tokenTypeHint,
    });

    const response = await fetch('https://appleid.apple.com/auth/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn({ error }, 'Token revocation failed');
    }
  }

  /**
   * Check if Apple OAuth is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!(
      config.appleOAuth.clientId &&
      config.appleOAuth.teamId &&
      config.appleOAuth.keyId &&
      config.appleOAuth.privateKey
    );
  }
}

export const appleOAuthProvider = new AppleOAuthProvider();

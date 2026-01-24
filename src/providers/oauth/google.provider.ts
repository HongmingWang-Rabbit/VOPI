import { createHash, randomBytes } from 'crypto';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import type {
  OAuthUserProfile,
  OAuthTokens,
  GoogleProviderData,
} from '../../types/auth.types.js';

const logger = getLogger().child({ provider: 'google-oauth' });

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

interface GoogleAuthOptions {
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  accessType?: 'online' | 'offline';
  prompt?: 'none' | 'consent' | 'select_account';
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  hd?: string; // Google Workspace domain
}

/**
 * Google OAuth provider
 */
class GoogleOAuthProvider {
  /**
   * Get Google OAuth configuration
   */
  private getConfig() {
    const config = getConfig();

    if (!config.googleOAuth.clientId || !config.googleOAuth.clientSecret) {
      throw new Error('Google OAuth is not configured');
    }

    return {
      clientId: config.googleOAuth.clientId,
      clientSecret: config.googleOAuth.clientSecret,
    };
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
   * Generate Google OAuth authorization URL
   */
  getAuthorizationUrl(options: GoogleAuthOptions): string {
    const { clientId } = this.getConfig();

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: options.accessType ?? 'offline',
      prompt: options.prompt ?? 'consent',
    });

    if (options.state) {
      params.set('state', options.state);
    }

    if (options.codeChallenge) {
      params.set('code_challenge', options.codeChallenge);
      params.set('code_challenge_method', options.codeChallengeMethod ?? 'S256');
    }

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret } = this.getConfig();

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

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token exchange failed');
      throw new Error(`Google token exchange failed: ${error}`);
    }

    const data = (await response.json()) as GoogleTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      idToken: data.id_token,
      scope: data.scope,
    };
  }

  /**
   * Get user info using access token
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserProfile> {
    logger.debug('Fetching user info from Google');

    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'User info fetch failed');
      throw new Error(`Failed to get Google user info: ${error}`);
    }

    const data = (await response.json()) as GoogleUserInfo;

    const providerData: GoogleProviderData = {
      picture: data.picture,
      locale: data.locale,
      hd: data.hd,
    };

    return {
      id: data.id,
      email: data.email,
      emailVerified: data.verified_email,
      name: data.name,
      avatarUrl: data.picture,
      providerData,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const { clientId, clientSecret } = this.getConfig();

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    logger.debug('Refreshing Google access token');

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Token refresh failed');
      throw new Error(`Google token refresh failed: ${error}`);
    }

    const data = (await response.json()) as GoogleTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken, // Google may not return new refresh token
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      scope: data.scope,
    };
  }

  /**
   * Revoke a token (access or refresh)
   */
  async revokeToken(token: string): Promise<void> {
    const response = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${token}`,
      { method: 'POST' }
    );

    if (!response.ok) {
      const error = await response.text();
      logger.warn({ error }, 'Token revocation failed');
    }
  }

  /**
   * Check if Google OAuth is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!(config.googleOAuth.clientId && config.googleOAuth.clientSecret);
  }
}

export const googleOAuthProvider = new GoogleOAuthProvider();

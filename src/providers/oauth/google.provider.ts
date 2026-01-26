import { createHash, randomBytes } from 'crypto';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import type {
  OAuthUserProfile,
  OAuthTokens,
  GoogleProviderData,
  ClientPlatformType,
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
  platform?: ClientPlatformType; // ios, android, or web
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
   * Get Google OAuth configuration for a specific platform
   *
   * @param platform - 'ios', 'android', or 'web' (default)
   * @returns Client ID and Client Secret (secret only for web)
   */
  private getConfigForPlatform(platform: ClientPlatformType = 'web') {
    const config = getConfig();

    // Web client (has client secret, used for backend token exchange)
    if (!config.googleOAuth.clientId || !config.googleOAuth.clientSecret) {
      throw new Error('Google OAuth Web client is not configured');
    }

    switch (platform) {
      case 'ios': {
        const iosClientId = config.googleOAuth.ios?.clientId;
        if (!iosClientId) {
          throw new Error('Google OAuth iOS client is not configured (GOOGLE_IOS_CLIENT_ID)');
        }
        return {
          clientId: iosClientId,
          // iOS apps don't use client secret - they use the authorization code directly
          // But token exchange still requires the web client secret
          clientSecret: config.googleOAuth.clientSecret,
        };
      }

      case 'android': {
        const androidClientId = config.googleOAuth.android?.clientId;
        if (!androidClientId) {
          throw new Error('Google OAuth Android client is not configured (GOOGLE_ANDROID_CLIENT_ID)');
        }
        return {
          clientId: androidClientId,
          // Android apps don't use client secret
          clientSecret: config.googleOAuth.clientSecret,
        };
      }

      case 'web':
      default:
        return {
          clientId: config.googleOAuth.clientId,
          clientSecret: config.googleOAuth.clientSecret,
        };
    }
  }

  /**
   * Get Google OAuth configuration (legacy - defaults to web)
   * @deprecated Use getConfigForPlatform instead
   */
  private getConfig() {
    return this.getConfigForPlatform('web');
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
   *
   * Uses platform-specific client ID to ensure the redirect URI is allowed
   */
  getAuthorizationUrl(options: GoogleAuthOptions): string {
    const platform = options.platform ?? 'web';
    const { clientId } = this.getConfigForPlatform(platform);

    logger.debug({ platform, clientId: clientId.substring(0, 20) + '...' }, 'Generating authorization URL');

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
   *
   * @param code - Authorization code from OAuth callback
   * @param redirectUri - Must match the redirect URI used in getAuthorizationUrl
   * @param codeVerifier - PKCE code verifier (required for mobile, optional for web)
   * @param platform - Must match the platform used in getAuthorizationUrl
   *
   * Note: Mobile platforms (iOS/Android) are "public clients" and don't use client_secret.
   * They rely on PKCE for security instead.
   */
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
    platform: ClientPlatformType = 'web'
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret } = this.getConfigForPlatform(platform);
    const isMobile = platform === 'ios' || platform === 'android';

    logger.debug({ platform, clientId: clientId.substring(0, 20) + '...', isMobile }, 'Exchanging authorization code for tokens');

    // Build token exchange params
    const params = new URLSearchParams({
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    // Mobile apps are "public clients" - they don't use client_secret
    // They must use PKCE (code_verifier) for security instead
    if (!isMobile) {
      params.set('client_secret', clientSecret);
    }

    // PKCE code verifier (required for mobile, optional for web)
    if (codeVerifier) {
      params.set('code_verifier', codeVerifier);
    } else if (isMobile) {
      logger.warn({ platform }, 'Mobile OAuth without PKCE code_verifier - this may fail');
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error, platform, isMobile }, 'Token exchange failed');
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

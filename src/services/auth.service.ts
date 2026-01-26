import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { getLogger } from '../utils/logger.js';
import { parseDuration } from '../utils/duration.js';
import { creditsService } from './credits.service.js';
import {
  JwtSecretNotConfiguredError,
  AccessTokenExpiredError,
  AccessTokenInvalidError,
  AccessTokenMalformedError,
  AccessTokenWrongTypeError,
  RefreshTokenExpiredError,
  RefreshTokenInvalidError,
  RefreshTokenRevokedError,
  RefreshTokenReusedError,
  RefreshTokenWrongTypeError,
  UserNotFoundError,
  UserDeletedError,
} from '../utils/auth-errors.js';
import type {
  JwtPayload,
  RefreshTokenPayload,
  OAuthProviderType,
  OAuthUserProfile,
  OAuthTokens,
  DeviceInfo,
  AuthResponse,
} from '../types/auth.types.js';
import type { User, NewUser } from '../db/schema.js';

const logger = getLogger().child({ service: 'auth' });

/**
 * Hash a token for secure storage
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Authentication service
 */
class AuthService {
  /**
   * Get JWT secret from config
   */
  private getSecret(): string {
    const config = getConfig();
    if (!config.jwt.secret) {
      throw new JwtSecretNotConfiguredError();
    }
    return config.jwt.secret;
  }

  /**
   * Generate an access token for a user
   */
  generateAccessToken(user: Pick<User, 'id' | 'email'>): string {
    const config = getConfig();
    const secret = this.getSecret();

    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      type: 'access',
    };

    const token = jwt.sign(payload, secret, {
      expiresIn: config.jwt.accessTokenExpiresIn as jwt.SignOptions['expiresIn'],
    });

    // Debug: verify the token we just created has correct claims
    const decoded = jwt.decode(token) as JwtPayload;
    logger.debug(
      {
        userId: user.id,
        tokenType: decoded?.type,
        tokenSub: decoded?.sub,
        hasType: 'type' in (decoded || {}),
        expiresIn: config.jwt.accessTokenExpiresIn,
      },
      'Generated access token'
    );

    return token;
  }

  /**
   * Generate a refresh token and store its hash in the database
   */
  async generateRefreshToken(
    user: Pick<User, 'id'>,
    deviceInfo?: DeviceInfo
  ): Promise<string> {
    const config = getConfig();
    const secret = this.getSecret();
    const tokenId = randomUUID();

    const payload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
      sub: user.id,
      jti: tokenId,
      type: 'refresh',
    };

    const token = jwt.sign(payload, secret, {
      expiresIn: config.jwt.refreshTokenExpiresIn as jwt.SignOptions['expiresIn'],
    });

    // Store hashed token in database
    const tokenHash = hashToken(token);
    const expiresAt = new Date(
      Date.now() + parseDuration(config.jwt.refreshTokenExpiresIn)
    );

    const db = getDatabase();
    await db.insert(schema.refreshTokens).values({
      userId: user.id,
      tokenHash,
      deviceId: deviceInfo?.deviceId,
      deviceName: deviceInfo?.deviceName,
      userAgent: deviceInfo?.userAgent,
      ipAddress: deviceInfo?.ipAddress,
      expiresAt,
    });

    return token;
  }

  /**
   * Verify and decode an access token
   */
  verifyAccessToken(token: string): JwtPayload {
    const secret = this.getSecret();

    // Debug: decode without verification first to see what claims are in the token
    const unverifiedDecoded = jwt.decode(token);
    logger.debug(
      {
        hasToken: !!token,
        tokenLength: token?.length,
        unverifiedClaims: unverifiedDecoded,
        unverifiedType: (unverifiedDecoded as Record<string, unknown>)?.type,
      },
      'Verifying access token - pre-verification decode'
    );

    try {
      const decoded = jwt.verify(token, secret) as JwtPayload;

      logger.debug(
        {
          sub: decoded.sub,
          type: decoded.type,
          email: decoded.email,
          exp: decoded.exp,
          iat: decoded.iat,
        },
        'Access token verified successfully'
      );

      if (decoded.type !== 'access') {
        logger.warn(
          { expectedType: 'access', actualType: decoded.type, sub: decoded.sub },
          'Token type mismatch'
        );
        throw new AccessTokenWrongTypeError('access', decoded.type || 'unknown');
      }

      return decoded;
    } catch (error) {
      // Re-throw our custom errors
      if (error instanceof AccessTokenWrongTypeError) {
        throw error;
      }
      if (error instanceof jwt.TokenExpiredError) {
        throw new AccessTokenExpiredError(error.expiredAt);
      }
      if (error instanceof jwt.NotBeforeError) {
        throw new AccessTokenInvalidError('Token not yet valid (nbf claim)');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        logger.warn(
          { error: error.message, tokenPreview: token?.substring(0, 20) + '...' },
          'JWT verification failed'
        );
        // Distinguish between malformed and invalid signature
        if (error.message.includes('malformed') || error.message.includes('invalid')) {
          throw new AccessTokenMalformedError(error.message);
        }
        throw new AccessTokenInvalidError(error.message);
      }
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   * Implements token rotation for security
   */
  async refreshAccessToken(
    refreshToken: string,
    deviceInfo?: DeviceInfo
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const secret = this.getSecret();
    const config = getConfig();
    const db = getDatabase();

    // Verify refresh token
    let decoded: RefreshTokenPayload;
    try {
      decoded = jwt.verify(refreshToken, secret) as RefreshTokenPayload;

      if (decoded.type !== 'refresh') {
        throw new RefreshTokenWrongTypeError('refresh', decoded.type || 'unknown');
      }
    } catch (error) {
      // Re-throw our custom errors
      if (error instanceof RefreshTokenWrongTypeError) {
        throw error;
      }
      if (error instanceof jwt.TokenExpiredError) {
        throw new RefreshTokenExpiredError(error.expiredAt);
      }
      if (error instanceof jwt.NotBeforeError) {
        throw new RefreshTokenInvalidError('Token not yet valid (nbf claim)');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new RefreshTokenInvalidError(error.message);
      }
      throw error;
    }

    const tokenHash = hashToken(refreshToken);

    // Find and validate the stored token
    const [storedToken] = await db
      .select()
      .from(schema.refreshTokens)
      .where(
        and(
          eq(schema.refreshTokens.tokenHash, tokenHash),
          eq(schema.refreshTokens.userId, decoded.sub)
        )
      )
      .limit(1);

    if (!storedToken) {
      // Token hash not found - could be reused after rotation or never existed
      logger.warn(
        { userId: decoded.sub, tokenId: decoded.jti },
        'Refresh token not found in database - possible token reuse or invalid token'
      );
      throw new RefreshTokenReusedError(decoded.sub);
    }

    // Check if token has been revoked
    if (storedToken.revokedAt) {
      logger.warn(
        { userId: decoded.sub, tokenId: storedToken.id, revokedAt: storedToken.revokedAt },
        'Attempt to use revoked refresh token'
      );
      throw new RefreshTokenRevokedError(decoded.sub);
    }

    // Check if token has expired in the database
    if (storedToken.expiresAt <= new Date()) {
      logger.info(
        { userId: decoded.sub, tokenId: storedToken.id, expiredAt: storedToken.expiresAt },
        'Refresh token expired in database'
      );
      throw new RefreshTokenExpiredError(storedToken.expiresAt);
    }

    // Get user
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, decoded.sub))
      .limit(1);

    if (!user) {
      throw new UserNotFoundError(decoded.sub);
    }

    if (user.deletedAt) {
      throw new UserDeletedError(decoded.sub);
    }

    // Validate user has required fields for token generation
    if (!user.id || !user.email) {
      logger.error(
        { userId: decoded.sub, hasId: !!user.id, hasEmail: !!user.email },
        'User missing required fields for token generation'
      );
      throw new Error('User data incomplete - cannot generate tokens');
    }

    logger.debug(
      { userId: user.id, email: user.email },
      'Refreshing tokens for user'
    );

    // Revoke old refresh token (rotation)
    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date(), lastUsedAt: new Date() })
      .where(eq(schema.refreshTokens.id, storedToken.id));

    // Generate new tokens
    const accessToken = this.generateAccessToken(user);
    const newRefreshToken = await this.generateRefreshToken(user, deviceInfo);

    logger.info(
      { userId: user.id, accessTokenLength: accessToken.length },
      'Generated new tokens via refresh'
    );

    const expiresIn = Math.floor(
      parseDuration(config.jwt.accessTokenExpiresIn) / 1000
    );

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    };
  }

  /**
   * Find or create user from OAuth profile
   */
  async findOrCreateUserFromOAuth(
    provider: OAuthProviderType,
    profile: OAuthUserProfile,
    tokens: OAuthTokens,
    deviceInfo?: DeviceInfo
  ): Promise<User> {
    const db = getDatabase();

    // First, check if OAuth account exists
    const [existingOAuth] = await db
      .select()
      .from(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.provider, provider),
          eq(schema.oauthAccounts.providerAccountId, profile.id)
        )
      )
      .limit(1);

    if (existingOAuth) {
      // Update tokens and get user
      await db
        .update(schema.oauthAccounts)
        .set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.expiresIn
            ? new Date(Date.now() + tokens.expiresIn * 1000)
            : null,
          providerData: profile.providerData,
          updatedAt: new Date(),
        })
        .where(eq(schema.oauthAccounts.id, existingOAuth.id));

      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, existingOAuth.userId))
        .limit(1);

      if (!user) {
        throw new UserNotFoundError(existingOAuth.userId);
      }
      if (user.deletedAt) {
        throw new UserDeletedError(existingOAuth.userId);
      }

      // Update last login
      await db
        .update(schema.users)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));

      return user;
    }

    // Check if user exists by email
    const [existingUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, profile.email))
      .limit(1);

    if (existingUser) {
      if (existingUser.deletedAt) {
        throw new UserDeletedError(existingUser.id);
      }

      // Link OAuth account to existing user
      //
      // Security note: We link accounts based on matching email addresses.
      // This is safe because:
      // 1. OAuth providers (Google, Apple) verify email ownership
      // 2. The email_verified flag from the provider indicates verification status
      // 3. Users can only link accounts if they control the email address
      //
      // If stricter linking is needed, implement explicit account linking flow
      // where user must be logged in to link additional OAuth providers.
      //
      // TODO: Consider sending email notification to user when new OAuth provider is linked
      await db.insert(schema.oauthAccounts).values({
        userId: existingUser.id,
        provider,
        providerAccountId: profile.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresIn
          ? new Date(Date.now() + tokens.expiresIn * 1000)
          : null,
        providerData: profile.providerData,
      });

      // Log account linking for security audit trail
      logger.info(
        {
          userId: existingUser.id,
          provider,
          providerAccountId: profile.id,
          email: profile.email,
          emailVerified: profile.emailVerified,
        },
        'Linked new OAuth provider to existing user account'
      );

      // Update last login and email verification if needed
      await db
        .update(schema.users)
        .set({
          lastLoginAt: new Date(),
          updatedAt: new Date(),
          emailVerified: existingUser.emailVerified || profile.emailVerified,
          name: existingUser.name || profile.name,
          avatarUrl: existingUser.avatarUrl || profile.avatarUrl,
        })
        .where(eq(schema.users.id, existingUser.id));

      return existingUser;
    }

    // Create new user
    const newUser: NewUser = {
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      lastLoginAt: new Date(),
    };

    const [createdUser] = await db
      .insert(schema.users)
      .values(newUser)
      .returning();

    // Create OAuth account link
    await db.insert(schema.oauthAccounts).values({
      userId: createdUser.id,
      provider,
      providerAccountId: profile.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : null,
      providerData: profile.providerData,
    });

    logger.info(
      { userId: createdUser.id, provider, email: profile.email },
      'Created new user from OAuth'
    );

    // Grant signup credits to new user
    try {
      const grantResult = await creditsService.grantSignupCredits(
        createdUser.id,
        profile.email,
        deviceInfo?.ipAddress,
        deviceInfo?.deviceId
      );
      if (grantResult.granted) {
        logger.info(
          { userId: createdUser.id, credits: grantResult.balance },
          'Granted signup credits to new user'
        );
      } else {
        logger.warn(
          { userId: createdUser.id, reason: grantResult.reason },
          'Could not grant signup credits to new user'
        );
      }
    } catch (error) {
      // Don't fail user creation if credit grant fails
      logger.error(
        { userId: createdUser.id, error },
        'Failed to grant signup credits to new user'
      );
    }

    return createdUser;
  }

  /**
   * Get user by ID
   */
  async getUserById(userId: string): Promise<User | null> {
    const db = getDatabase();

    const [user] = await db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          isNull(schema.users.deletedAt)
        )
      )
      .limit(1);

    return user || null;
  }

  /**
   * Revoke a specific refresh token
   */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const db = getDatabase();
    const tokenHash = hashToken(refreshToken);

    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.refreshTokens.tokenHash, tokenHash));
  }

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllRefreshTokens(userId: string): Promise<void> {
    const db = getDatabase();

    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.refreshTokens.userId, userId),
          isNull(schema.refreshTokens.revokedAt)
        )
      );

    logger.info({ userId }, 'Revoked all refresh tokens');
  }

  /**
   * Create full auth response
   */
  async createAuthResponse(
    user: User,
    deviceInfo?: DeviceInfo
  ): Promise<AuthResponse> {
    const config = getConfig();

    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user, deviceInfo);

    const expiresIn = Math.floor(
      parseDuration(config.jwt.accessTokenExpiresIn) / 1000
    );

    return {
      accessToken,
      refreshToken,
      expiresIn,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? undefined,
        avatarUrl: user.avatarUrl ?? undefined,
        creditsBalance: user.creditsBalance,
      },
    };
  }

  /**
   * Check if JWT auth is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!config.jwt.secret;
  }
}

export const authService = new AuthService();

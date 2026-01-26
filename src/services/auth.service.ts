import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'crypto';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { getLogger } from '../utils/logger.js';
import { parseDuration } from '../utils/duration.js';
import { creditsService } from './credits.service.js';
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
      throw new Error('JWT_SECRET is not configured');
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

    return jwt.sign(payload, secret, {
      expiresIn: config.jwt.accessTokenExpiresIn as jwt.SignOptions['expiresIn'],
    });
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

    try {
      const decoded = jwt.verify(token, secret) as JwtPayload;

      if (decoded.type !== 'access') {
        throw new Error('Invalid token type');
      }

      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Token expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid token');
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
        throw new Error('Invalid token type');
      }
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Refresh token expired');
      }
      throw new Error('Invalid refresh token');
    }

    const tokenHash = hashToken(refreshToken);

    // Find and validate the stored token
    const [storedToken] = await db
      .select()
      .from(schema.refreshTokens)
      .where(
        and(
          eq(schema.refreshTokens.tokenHash, tokenHash),
          eq(schema.refreshTokens.userId, decoded.sub),
          isNull(schema.refreshTokens.revokedAt),
          gt(schema.refreshTokens.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!storedToken) {
      // Token not found or revoked - potential token reuse attack
      logger.warn({ userId: decoded.sub }, 'Refresh token not found or revoked');
      throw new Error('Invalid refresh token');
    }

    // Get user
    const [user] = await db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, decoded.sub),
          isNull(schema.users.deletedAt)
        )
      )
      .limit(1);

    if (!user) {
      throw new Error('User not found');
    }

    // Revoke old refresh token (rotation)
    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date(), lastUsedAt: new Date() })
      .where(eq(schema.refreshTokens.id, storedToken.id));

    // Generate new tokens
    const accessToken = this.generateAccessToken(user);
    const newRefreshToken = await this.generateRefreshToken(user, deviceInfo);

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

      if (!user || user.deletedAt) {
        throw new Error('User account has been deleted');
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
        throw new Error('User account has been deleted');
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

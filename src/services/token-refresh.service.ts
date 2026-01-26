import { eq, and, lt, isNotNull } from 'drizzle-orm';
import { getDatabase, schema } from '../db/index.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { chunk } from '../utils/parallel.js';
import { shopifyOAuthService } from './oauth/shopify-oauth.service.js';
import { amazonOAuthService } from './oauth/amazon-oauth.service.js';
import { ebayOAuthService } from './oauth/ebay-oauth.service.js';
import { encryptionService } from './encryption.service.js';
import { PlatformType, ConnectionStatus, type ShopifyConnectionMetadata } from '../types/auth.types.js';
import type { PlatformConnection } from '../db/schema.js';

const logger = getLogger().child({ service: 'token-refresh' });

/** Maximum concurrent token refresh operations */
const TOKEN_REFRESH_CONCURRENCY = 5;

/**
 * Token refresh service
 * Handles automatic refresh of expiring platform tokens
 */
class TokenRefreshService {
  /**
   * Refresh tokens that are about to expire
   * Called periodically by the worker
   * Uses parallel processing with concurrency limit for efficiency
   */
  async refreshExpiringTokens(): Promise<{ refreshed: number; failed: number }> {
    const config = getConfig();
    const db = getDatabase();

    // Find connections with tokens expiring within threshold
    const threshold = new Date(Date.now() + config.tokenRefresh.thresholdMs);

    const expiringConnections = await db
      .select()
      .from(schema.platformConnections)
      .where(
        and(
          eq(schema.platformConnections.status, ConnectionStatus.ACTIVE),
          isNotNull(schema.platformConnections.tokenExpiresAt),
          lt(schema.platformConnections.tokenExpiresAt, threshold)
        )
      );

    logger.info(
      { count: expiringConnections.length },
      'Found connections with expiring tokens'
    );

    if (expiringConnections.length === 0) {
      return { refreshed: 0, failed: 0 };
    }

    let refreshed = 0;
    let failed = 0;

    // Process connections in parallel batches for efficiency
    const batches = chunk(expiringConnections, TOKEN_REFRESH_CONCURRENCY);

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async (connection) => {
          try {
            await this.refreshConnectionToken(connection);
            return { success: true, connectionId: connection.id };
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.error(
              { connectionId: connection.id, platform: connection.platform, error: message },
              'Failed to refresh token'
            );

            // Update connection status and error
            await db
              .update(schema.platformConnections)
              .set({
                status: ConnectionStatus.ERROR,
                lastError: message,
                updatedAt: new Date(),
              })
              .where(eq(schema.platformConnections.id, connection.id));

            throw error;
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          refreshed++;
        } else {
          failed++;
        }
      }
    }

    return { refreshed, failed };
  }

  /**
   * Refresh token for a specific connection
   */
  async refreshConnectionToken(connection: PlatformConnection): Promise<void> {
    const db = getDatabase();

    logger.debug(
      { connectionId: connection.id, platform: connection.platform },
      'Refreshing platform token'
    );

    // Decrypt the refresh token
    if (!connection.refreshToken) {
      throw new Error('No refresh token available');
    }

    const refreshToken = encryptionService.decrypt(connection.refreshToken);

    let newAccessToken: string;
    let newRefreshToken: string;
    let expiresIn: number;

    switch (connection.platform) {
      case PlatformType.SHOPIFY: {
        // Shopify tokens don't expire, but we verify they're still valid
        const shopMetadata = connection.metadata as ShopifyConnectionMetadata;
        const isValid = await shopifyOAuthService.verifyToken(
          shopMetadata.shop,
          encryptionService.decrypt(connection.accessToken)
        );

        if (!isValid) {
          throw new Error('Shopify token is no longer valid');
        }

        // No refresh needed for Shopify
        return;
      }

      case PlatformType.AMAZON: {
        const amazonResult = await amazonOAuthService.refreshAccessToken(refreshToken);
        newAccessToken = amazonResult.accessToken;
        newRefreshToken = amazonResult.refreshToken;
        expiresIn = amazonResult.expiresIn;
        break;
      }

      case PlatformType.EBAY: {
        const ebayResult = await ebayOAuthService.refreshAccessToken(refreshToken);
        newAccessToken = ebayResult.accessToken;
        newRefreshToken = ebayResult.refreshToken;
        expiresIn = ebayResult.expiresIn;
        break;
      }

      default:
        throw new Error(`Unknown platform: ${connection.platform}`);
    }

    // Calculate new expiration time
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    // Update connection with new tokens
    await db
      .update(schema.platformConnections)
      .set({
        accessToken: encryptionService.encrypt(newAccessToken),
        refreshToken: encryptionService.encrypt(newRefreshToken),
        tokenExpiresAt,
        status: ConnectionStatus.ACTIVE,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.platformConnections.id, connection.id));

    logger.info(
      { connectionId: connection.id, platform: connection.platform },
      'Token refreshed successfully'
    );
  }

  /**
   * Get a valid access token for a connection, refreshing if needed
   * @param connectionId - The connection ID
   * @param userId - Optional user ID to verify ownership. If provided, verifies the connection belongs to this user.
   */
  async getValidAccessToken(connectionId: string, userId?: string): Promise<string> {
    const db = getDatabase();

    // Build query conditions
    const conditions = [eq(schema.platformConnections.id, connectionId)];

    // Add user ownership verification if userId is provided
    if (userId) {
      conditions.push(eq(schema.platformConnections.userId, userId));
    }

    const [connection] = await db
      .select()
      .from(schema.platformConnections)
      .where(and(...conditions))
      .limit(1);

    if (!connection) {
      throw new Error(userId ? 'Connection not found or access denied' : 'Connection not found');
    }

    if (connection.status !== ConnectionStatus.ACTIVE) {
      throw new Error(`Connection is ${connection.status}`);
    }

    // Check if token is expired or about to expire
    const config = getConfig();
    const threshold = new Date(Date.now() + config.tokenRefresh.thresholdMs);

    if (connection.tokenExpiresAt && connection.tokenExpiresAt < threshold) {
      // Token needs refresh
      await this.refreshConnectionToken(connection);

      // Re-fetch connection to get updated token
      const [updatedConnection] = await db
        .select()
        .from(schema.platformConnections)
        .where(eq(schema.platformConnections.id, connectionId))
        .limit(1);

      return encryptionService.decrypt(updatedConnection.accessToken);
    }

    return encryptionService.decrypt(connection.accessToken);
  }

  /**
   * Mark a connection as expired
   */
  async markConnectionExpired(connectionId: string): Promise<void> {
    const db = getDatabase();

    await db
      .update(schema.platformConnections)
      .set({
        status: ConnectionStatus.EXPIRED,
        updatedAt: new Date(),
      })
      .where(eq(schema.platformConnections.id, connectionId));
  }

  /**
   * Mark a connection as revoked
   */
  async markConnectionRevoked(connectionId: string): Promise<void> {
    const db = getDatabase();

    await db
      .update(schema.platformConnections)
      .set({
        status: ConnectionStatus.REVOKED,
        updatedAt: new Date(),
      })
      .where(eq(schema.platformConnections.id, connectionId));
  }
}

export const tokenRefreshService = new TokenRefreshService();

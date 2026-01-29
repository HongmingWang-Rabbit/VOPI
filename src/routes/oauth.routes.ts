import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { getLogger } from '../utils/logger.js';
import { requireUserAuth } from '../middleware/auth.middleware.js';
import { getDatabase, schema } from '../db/index.js';
import { getConfig } from '../config/index.js';
import { shopifyOAuthService } from '../services/oauth/shopify-oauth.service.js';
import { amazonOAuthService } from '../services/oauth/amazon-oauth.service.js';
import { ebayOAuthService } from '../services/oauth/ebay-oauth.service.js';
import { encryptionService } from '../services/encryption.service.js';
import { tokenRefreshService } from '../services/token-refresh.service.js';
import { stateStoreService, type OAuthStateData } from '../services/state-store.service.js';
import {
  shopifyAuthorizeQuerySchema,
  shopifyCallbackQuerySchema,
  amazonAuthorizeQuerySchema,
  amazonCallbackQuerySchema,
  ebayAuthorizeQuerySchema,
  ebayCallbackQuerySchema,
  PlatformType,
  ConnectionStatus,
} from '../types/auth.types.js';
import type { ShopifyConnectionMetadata, AmazonConnectionMetadata, EbayConnectionMetadata } from '../types/auth.types.js';

/**
 * Platform OAuth routes for connecting e-commerce platforms
 */
export async function oauthRoutes(fastify: FastifyInstance): Promise<void> {
  const logger = getLogger().child({ route: 'oauth' });

  // =========================================================================
  // Platform Availability
  // =========================================================================

  /**
   * Check which platforms are configured
   */
  fastify.get(
    '/platforms/available',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Check which OAuth platforms are configured and available',
        tags: ['Platforms'],
        response: {
          200: {
            type: 'object',
            properties: {
              platforms: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    platform: { type: 'string' },
                    configured: { type: 'boolean' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        platforms: [
          { platform: PlatformType.SHOPIFY, configured: shopifyOAuthService.isConfigured(), name: 'Shopify' },
          { platform: PlatformType.AMAZON, configured: amazonOAuthService.isConfigured(), name: 'Amazon' },
          { platform: PlatformType.EBAY, configured: ebayOAuthService.isConfigured(), name: 'eBay' },
        ],
      });
    }
  );

  // =========================================================================
  // Shopify OAuth
  // =========================================================================

  /**
   * Start Shopify OAuth flow
   */
  fastify.get(
    '/oauth/shopify/authorize',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Start Shopify OAuth flow',
        tags: ['Platform OAuth'],
        // Note: This schema must stay in sync with shopifyAuthorizeQuerySchema in auth.types.ts
        querystring: {
          type: 'object',
          required: ['shop'],
          properties: {
            shop: { type: 'string', pattern: '^[a-zA-Z0-9-]+\\.myshopify\\.com$' },
            redirectUri: { type: 'string', format: 'uri' },
            response_type: { type: 'string', enum: ['json'] },
            successRedirect: { type: 'string', description: 'URL to redirect to after successful OAuth (e.g., deep link)' },
          },
        },
        response: {
          200: {
            type: 'object',
            description: 'JSON response with auth URL (when response_type=json)',
            required: ['authUrl'],
            properties: {
              authUrl: { type: 'string' },
            },
          },
          302: { type: 'null', description: 'Redirect to Shopify authorization (default)' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!shopifyOAuthService.isConfigured()) {
        return reply.status(400).send({
          error: 'PROVIDER_NOT_CONFIGURED',
          message: 'Shopify OAuth is not configured',
        });
      }

      const { shop, redirectUri, response_type, successRedirect } = shopifyAuthorizeQuerySchema.parse(request.query);
      const state = randomBytes(32).toString('hex');

      // Use default redirect URI if not provided
      const callbackUri = redirectUri || `${request.protocol}://${request.hostname}/api/v1/oauth/shopify/callback`;

      // Store state
      const stateData: OAuthStateData = {
        provider: PlatformType.SHOPIFY,
        redirectUri: callbackUri,
        userId: request.user!.id,
        shop,
        successRedirect,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      await stateStoreService.set(state, stateData);

      const authUrl = shopifyOAuthService.getAuthorizationUrl(shop, callbackUri, state);

      // Return JSON for mobile clients that can't follow 302 redirects
      if (response_type === 'json') {
        return reply.send({ authUrl });
      }

      return reply.redirect(authUrl);
    }
  );

  /**
   * Shopify OAuth callback
   */
  fastify.get(
    '/oauth/shopify/callback',
    {
      schema: {
        description: 'Shopify OAuth callback',
        tags: ['Platform OAuth'],
        querystring: {
          type: 'object',
          required: ['code', 'shop', 'state', 'hmac', 'timestamp'],
          additionalProperties: true, // Shopify may send extra params (e.g., host) needed for HMAC
          properties: {
            code: { type: 'string' },
            shop: { type: 'string' },
            state: { type: 'string' },
            hmac: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = shopifyCallbackQuerySchema.parse(request.query);

      // Verify HMAC using ALL raw query params (not just Zod-parsed ones).
      // Shopify may send extra params (e.g., host) that are included in the HMAC calculation.
      const rawQuery = request.query as Record<string, string>;
      if (!shopifyOAuthService.verifyHmac(rawQuery)) {
        return reply.status(400).send({
          error: 'INVALID_HMAC',
          message: 'Invalid HMAC signature',
        });
      }

      // Verify state
      const storedState = await stateStoreService.get(query.state, true); // deleteAfterGet
      if (!storedState || storedState.provider !== PlatformType.SHOPIFY) {
        return reply.status(400).send({
          error: 'INVALID_STATE',
          message: 'Invalid or expired state',
        });
      }

      // User ID must exist for platform OAuth (we set it in the authorize step)
      if (!storedState.userId) {
        return reply.status(400).send({
          error: 'INVALID_STATE',
          message: 'Missing user context in state',
        });
      }

      const userId = storedState.userId;

      try {
        // Exchange code for token
        const { accessToken, scope } = await shopifyOAuthService.exchangeCode(
          query.shop,
          query.code
        );

        // Get shop info
        const shopInfo = await shopifyOAuthService.getShopInfo(query.shop, accessToken);

        const db = getDatabase();

        // Check if connection already exists
        const [existing] = await db
          .select()
          .from(schema.platformConnections)
          .where(
            and(
              eq(schema.platformConnections.userId, userId),
              eq(schema.platformConnections.platform, PlatformType.SHOPIFY),
              eq(schema.platformConnections.platformAccountId, shopInfo.shopId!)
            )
          )
          .limit(1);

        const metadata: ShopifyConnectionMetadata = {
          ...shopInfo,
          scope,
        };

        if (existing) {
          // Update existing connection
          await db
            .update(schema.platformConnections)
            .set({
              accessToken: encryptionService.encrypt(accessToken),
              metadata,
              status: ConnectionStatus.ACTIVE,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.platformConnections.id, existing.id));
        } else {
          // Create new connection
          await db.insert(schema.platformConnections).values({
            userId: userId,
            platform: PlatformType.SHOPIFY,
            platformAccountId: shopInfo.shopId!,
            accessToken: encryptionService.encrypt(accessToken),
            metadata,
            status: ConnectionStatus.ACTIVE,
          });
        }

        // Redirect to success page: use successRedirect from state (mobile deep link),
        // fall back to OAUTH_SUCCESS_REDIRECT_URL env var.
        // Validate successRedirect to prevent open redirect attacks.
        const config = getConfig();
        let successUrl = config.oauthSuccessRedirectUrl;

        if (storedState.successRedirect) {
          const redirect = storedState.successRedirect;
          const isRelativePath = redirect.startsWith('/');
          const allowedSchemes = config.oauthAllowedRedirectSchemes;
          const hasAllowedScheme = allowedSchemes.length > 0 &&
            allowedSchemes.some((scheme) => redirect.startsWith(`${scheme}://`));

          if (isRelativePath || hasAllowedScheme) {
            successUrl = redirect;
          } else {
            logger.warn({ redirect }, 'Blocked disallowed successRedirect scheme');
          }
        }

        return reply.redirect(successUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(400).send({
          error: 'OAUTH_FAILED',
          message,
        });
      }
    }
  );

  // =========================================================================
  // Amazon OAuth
  // =========================================================================

  /**
   * Start Amazon OAuth flow
   */
  fastify.get(
    '/oauth/amazon/authorize',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Start Amazon OAuth flow',
        tags: ['Platform OAuth'],
        querystring: {
          type: 'object',
          properties: {
            redirectUri: { type: 'string', format: 'uri' },
          },
        },
        response: {
          302: { type: 'null', description: 'Redirect to Amazon authorization' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!amazonOAuthService.isConfigured()) {
        return reply.status(400).send({
          error: 'PROVIDER_NOT_CONFIGURED',
          message: 'Amazon OAuth is not configured',
        });
      }

      const { redirectUri } = amazonAuthorizeQuerySchema.parse(request.query);
      const state = randomBytes(32).toString('hex');

      const callbackUri = redirectUri || `${request.protocol}://${request.hostname}/api/v1/oauth/amazon/callback`;

      const amazonStateData: OAuthStateData = {
        provider: PlatformType.AMAZON,
        redirectUri: callbackUri,
        userId: request.user!.id,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      await stateStoreService.set(state, amazonStateData);

      const authUrl = amazonOAuthService.getAuthorizationUrl(callbackUri, state);
      return reply.redirect(authUrl);
    }
  );

  /**
   * Amazon OAuth callback
   */
  fastify.get(
    '/oauth/amazon/callback',
    {
      schema: {
        description: 'Amazon OAuth callback',
        tags: ['Platform OAuth'],
        querystring: {
          type: 'object',
          required: ['state'],
          properties: {
            code: { type: 'string' },
            spapi_oauth_code: { type: 'string' },
            state: { type: 'string' },
            error: { type: 'string' },
            error_description: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = amazonCallbackQuerySchema.parse(request.query);

      if (query.error) {
        return reply.status(400).send({
          error: 'OAUTH_ERROR',
          message: query.error_description || query.error,
        });
      }

      const storedState = await stateStoreService.get(query.state, true); // deleteAfterGet
      if (!storedState || storedState.provider !== PlatformType.AMAZON) {
        return reply.status(400).send({
          error: 'INVALID_STATE',
          message: 'Invalid or expired state',
        });
      }

      // User ID must exist for platform OAuth (we set it in the authorize step)
      if (!storedState.userId) {
        return reply.status(400).send({
          error: 'INVALID_STATE',
          message: 'Missing user context in state',
        });
      }

      const userId = storedState.userId;

      const code = query.code || query.spapi_oauth_code;
      if (!code) {
        return reply.status(400).send({
          error: 'MISSING_CODE',
          message: 'Authorization code not provided',
        });
      }

      try {
        const { accessToken, refreshToken, expiresIn } = await amazonOAuthService.exchangeCode(
          code,
          storedState.redirectUri
        );

        const sellerInfo = await amazonOAuthService.getSellerInfo(accessToken, refreshToken);

        const db = getDatabase();

        const metadata: AmazonConnectionMetadata = sellerInfo;

        const [existing] = await db
          .select()
          .from(schema.platformConnections)
          .where(
            and(
              eq(schema.platformConnections.userId, userId),
              eq(schema.platformConnections.platform, PlatformType.AMAZON),
              eq(schema.platformConnections.platformAccountId, sellerInfo.sellerId)
            )
          )
          .limit(1);

        const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

        if (existing) {
          await db
            .update(schema.platformConnections)
            .set({
              accessToken: encryptionService.encrypt(accessToken),
              refreshToken: encryptionService.encrypt(refreshToken),
              tokenExpiresAt,
              metadata,
              status: ConnectionStatus.ACTIVE,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.platformConnections.id, existing.id));
        } else {
          await db.insert(schema.platformConnections).values({
            userId: userId,
            platform: PlatformType.AMAZON,
            platformAccountId: sellerInfo.sellerId,
            accessToken: encryptionService.encrypt(accessToken),
            refreshToken: encryptionService.encrypt(refreshToken),
            tokenExpiresAt,
            metadata,
            status: ConnectionStatus.ACTIVE,
          });
        }

        return reply.redirect('/api/v1/connections?success=amazon');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(400).send({
          error: 'OAUTH_FAILED',
          message,
        });
      }
    }
  );

  // =========================================================================
  // eBay OAuth
  // =========================================================================

  /**
   * Start eBay OAuth flow
   */
  fastify.get(
    '/oauth/ebay/authorize',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Start eBay OAuth flow',
        tags: ['Platform OAuth'],
        querystring: {
          type: 'object',
          properties: {
            redirectUri: { type: 'string', format: 'uri' },
          },
        },
        response: {
          302: { type: 'null', description: 'Redirect to eBay authorization' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!ebayOAuthService.isConfigured()) {
        return reply.status(400).send({
          error: 'PROVIDER_NOT_CONFIGURED',
          message: 'eBay OAuth is not configured',
        });
      }

      const { redirectUri } = ebayAuthorizeQuerySchema.parse(request.query);
      const state = randomBytes(32).toString('hex');

      const callbackUri = redirectUri || `${request.protocol}://${request.hostname}/api/v1/oauth/ebay/callback`;

      const ebayStateData: OAuthStateData = {
        provider: PlatformType.EBAY,
        redirectUri: callbackUri,
        userId: request.user!.id,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      await stateStoreService.set(state, ebayStateData);

      const authUrl = ebayOAuthService.getAuthorizationUrl(callbackUri, state);
      return reply.redirect(authUrl);
    }
  );

  /**
   * eBay OAuth callback
   */
  fastify.get(
    '/oauth/ebay/callback',
    {
      schema: {
        description: 'eBay OAuth callback',
        tags: ['Platform OAuth'],
        querystring: {
          type: 'object',
          required: ['code', 'state'],
          properties: {
            code: { type: 'string' },
            state: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ebayCallbackQuerySchema.parse(request.query);

      const storedState = await stateStoreService.get(query.state, true); // deleteAfterGet
      if (!storedState || storedState.provider !== PlatformType.EBAY) {
        return reply.status(400).send({
          error: 'INVALID_STATE',
          message: 'Invalid or expired state',
        });
      }

      // User ID must exist for platform OAuth (we set it in the authorize step)
      if (!storedState.userId) {
        return reply.status(400).send({
          error: 'INVALID_STATE',
          message: 'Missing user context in state',
        });
      }

      const userId = storedState.userId;

      try {
        const { accessToken, refreshToken, expiresIn } = await ebayOAuthService.exchangeCode(
          query.code,
          storedState.redirectUri
        );

        const connectionMetadata = await ebayOAuthService.getConnectionMetadata(accessToken);

        const db = getDatabase();

        const metadata: EbayConnectionMetadata = connectionMetadata;

        const [existing] = await db
          .select()
          .from(schema.platformConnections)
          .where(
            and(
              eq(schema.platformConnections.userId, userId),
              eq(schema.platformConnections.platform, PlatformType.EBAY),
              eq(schema.platformConnections.platformAccountId, connectionMetadata.userId)
            )
          )
          .limit(1);

        const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

        if (existing) {
          await db
            .update(schema.platformConnections)
            .set({
              accessToken: encryptionService.encrypt(accessToken),
              refreshToken: encryptionService.encrypt(refreshToken),
              tokenExpiresAt,
              metadata,
              status: ConnectionStatus.ACTIVE,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.platformConnections.id, existing.id));
        } else {
          await db.insert(schema.platformConnections).values({
            userId: userId,
            platform: PlatformType.EBAY,
            platformAccountId: connectionMetadata.userId,
            accessToken: encryptionService.encrypt(accessToken),
            refreshToken: encryptionService.encrypt(refreshToken),
            tokenExpiresAt,
            metadata,
            status: ConnectionStatus.ACTIVE,
          });
        }

        return reply.redirect('/api/v1/connections?success=ebay');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(400).send({
          error: 'OAUTH_FAILED',
          message,
        });
      }
    }
  );

  // =========================================================================
  // Connection Management
  // =========================================================================

  /**
   * List user's platform connections
   */
  fastify.get(
    '/connections',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'List user platform connections',
        tags: ['Connections'],
        response: {
          200: {
            type: 'object',
            properties: {
              connections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    platform: { type: 'string' },
                    platformAccountId: { type: 'string' },
                    status: { type: 'string' },
                    metadata: { type: 'object' },
                    lastError: { type: 'string', nullable: true },
                    lastUsedAt: { type: 'string' },
                    createdAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const db = getDatabase();

      const connections = await db
        .select({
          id: schema.platformConnections.id,
          platform: schema.platformConnections.platform,
          platformAccountId: schema.platformConnections.platformAccountId,
          status: schema.platformConnections.status,
          metadata: schema.platformConnections.metadata,
          lastError: schema.platformConnections.lastError,
          lastUsedAt: schema.platformConnections.lastUsedAt,
          createdAt: schema.platformConnections.createdAt,
        })
        .from(schema.platformConnections)
        .where(eq(schema.platformConnections.userId, request.user!.id));

      return reply.send({
        connections: connections.map((c) => ({
          ...c,
          lastUsedAt: c.lastUsedAt?.toISOString(),
          createdAt: c.createdAt.toISOString(),
        })),
      });
    }
  );

  /**
   * Get connection details
   */
  fastify.get(
    '/connections/:id',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get connection details',
        tags: ['Connections'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const db = getDatabase();

      const [connection] = await db
        .select()
        .from(schema.platformConnections)
        .where(
          and(
            eq(schema.platformConnections.id, id),
            eq(schema.platformConnections.userId, request.user!.id)
          )
        )
        .limit(1);

      if (!connection) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Connection not found',
        });
      }

      return reply.send({
        id: connection.id,
        platform: connection.platform,
        platformAccountId: connection.platformAccountId,
        status: connection.status,
        metadata: connection.metadata,
        lastError: connection.lastError,
        lastUsedAt: connection.lastUsedAt?.toISOString(),
        createdAt: connection.createdAt.toISOString(),
        updatedAt: connection.updatedAt.toISOString(),
      });
    }
  );

  /**
   * Delete/disconnect a platform connection
   */
  fastify.delete(
    '/connections/:id',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Disconnect a platform',
        tags: ['Connections'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const db = getDatabase();

      const [connection] = await db
        .select()
        .from(schema.platformConnections)
        .where(
          and(
            eq(schema.platformConnections.id, id),
            eq(schema.platformConnections.userId, request.user!.id)
          )
        )
        .limit(1);

      if (!connection) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Connection not found',
        });
      }

      await db
        .delete(schema.platformConnections)
        .where(eq(schema.platformConnections.id, id));

      return reply.send({
        success: true,
        message: 'Connection deleted',
      });
    }
  );

  /**
   * Test a connection
   */
  fastify.post(
    '/connections/:id/test',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Test a platform connection',
        tags: ['Connections'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        // Get valid token with user ownership verification
        const accessToken = await tokenRefreshService.getValidAccessToken(id, request.user!.id);

        // Get connection to determine platform
        const db = getDatabase();
        const [connection] = await db
          .select()
          .from(schema.platformConnections)
          .where(
            and(
              eq(schema.platformConnections.id, id),
              eq(schema.platformConnections.userId, request.user!.id)
            )
          )
          .limit(1);

        if (!connection) {
          return reply.status(404).send({
            error: 'NOT_FOUND',
            message: 'Connection not found',
          });
        }

        let isValid = false;

        switch (connection.platform) {
          case PlatformType.SHOPIFY: {
            const shopMetadata = connection.metadata as ShopifyConnectionMetadata;
            isValid = await shopifyOAuthService.verifyToken(shopMetadata.shop, accessToken);
            break;
          }
          case PlatformType.AMAZON:
            isValid = await amazonOAuthService.verifyToken(accessToken);
            break;
          case PlatformType.EBAY:
            isValid = await ebayOAuthService.verifyToken(accessToken);
            break;
        }

        // Update last used timestamp
        await db
          .update(schema.platformConnections)
          .set({ lastUsedAt: new Date() })
          .where(eq(schema.platformConnections.id, id));

        return reply.send({
          success: isValid,
          message: isValid ? 'Connection is valid' : 'Connection test failed',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(400).send({
          error: 'TEST_FAILED',
          message,
        });
      }
    }
  );
}

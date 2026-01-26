import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from '@fastify/rate-limit';
import { authService } from '../services/auth.service.js';
import { googleOAuthProvider } from '../providers/oauth/google.provider.js';
import { appleOAuthProvider } from '../providers/oauth/apple.provider.js';
import { requireUserAuth } from '../middleware/auth.middleware.js';
import { stateStoreService, type OAuthStateData } from '../services/state-store.service.js';
import { getRedis, initRedis } from '../queues/redis.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { formatAuthError } from '../utils/auth-errors.js';
import {
  oauthInitRequestSchema,
  oauthCallbackRequestSchema,
  refreshTokenRequestSchema,
  logoutRequestSchema,
  OAuthProvider,
  type OAuthCallbackRequest,
  type ClientPlatformType,
} from '../types/auth.types.js';

const logger = getLogger().child({ service: 'auth-routes' });

/**
 * Auth routes for OAuth login and JWT token management
 */
export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const config = getConfig();

  // Initialize state store for OAuth CSRF protection
  // This uses Redis if available, otherwise falls back to memory
  await stateStoreService.initialize();

  // Initialize Redis for rate limiting if available
  let redisClient;
  try {
    if (config.redis.url) {
      initRedis();
      redisClient = getRedis();
    }
  } catch (error) {
    logger.debug({ error }, 'Redis not available for rate limiting, using in-memory');
  }

  // Log state store status
  if (!stateStoreService.isUsingRedis()) {
    logger.warn('OAuth state store using in-memory storage - not suitable for multi-instance deployments');
  }

  // Register rate limiting for auth endpoints
  // More restrictive limits for security-sensitive endpoints
  await fastify.register(rateLimit, {
    global: false, // Don't apply globally, we'll apply per-route
    max: 100, // Default max requests per window
    timeWindow: '1 minute',
    ...(redisClient ? { redis: redisClient } : {}),
    keyGenerator: (request) => {
      // Use IP + user agent for rate limiting
      return `${request.ip}:${request.headers['user-agent'] || 'unknown'}`;
    },
    errorResponseBuilder: (_request, context) => ({
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests. Please try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  /**
   * Initialize OAuth flow - get authorization URL
   */
  fastify.post(
    '/auth/oauth/init',
    {
      config: {
        rateLimit: {
          max: 20, // 20 requests per minute for OAuth init
          timeWindow: '1 minute',
        },
      },
      schema: {
        description: 'Initialize OAuth flow and get authorization URL',
        tags: ['Auth'],
        body: {
          type: 'object',
          required: ['provider', 'redirectUri'],
          properties: {
            provider: { type: 'string', enum: ['google', 'apple'] },
            redirectUri: { type: 'string' }, // Allow custom schemes for mobile
            state: { type: 'string' },
            codeChallenge: { type: 'string' },
            codeChallengeMethod: { type: 'string', enum: ['S256', 'plain'] },
            platform: { type: 'string', enum: ['ios', 'android', 'web'], default: 'web' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              authorizationUrl: { type: 'string' },
              state: { type: 'string' },
              codeVerifier: { type: 'string' }, // Returned when server generates PKCE for mobile clients (camelCase)
              code_verifier: { type: 'string' }, // Same as above, snake_case for OAuth convention compatibility
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = oauthInitRequestSchema.parse(request.body);

      let authorizationUrl: string;
      let codeVerifier: string | undefined;

      // Generate state if not provided
      const state = body.state || randomBytes(32).toString('base64url');

      // PKCE handling:
      // - If client provides codeChallenge, they manage PKCE (mobile apps typically do this)
      // - If client doesn't provide codeChallenge, server generates PKCE and returns codeVerifier
      // - The codeVerifier is stored in state and returned to client for the callback

      switch (body.provider) {
        case OAuthProvider.GOOGLE: {
          if (!googleOAuthProvider.isConfigured()) {
            return reply.status(400).send({
              error: 'PROVIDER_NOT_CONFIGURED',
              message: 'Google OAuth is not configured',
            });
          }

          // Generate PKCE if client hasn't provided one
          let codeChallenge = body.codeChallenge;
          if (!codeChallenge) {
            const pkce = googleOAuthProvider.generatePKCE();
            codeChallenge = pkce.codeChallenge;
            codeVerifier = pkce.codeVerifier;
          }

          // Use platform-specific client ID
          const platform = body.platform as ClientPlatformType ?? 'web';
          logger.info({ platform, redirectUri: body.redirectUri }, 'Initializing Google OAuth');

          authorizationUrl = googleOAuthProvider.getAuthorizationUrl({
            redirectUri: body.redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod: body.codeChallengeMethod ?? 'S256',
            platform,
          });
          break;
        }

        case OAuthProvider.APPLE: {
          if (!appleOAuthProvider.isConfigured()) {
            return reply.status(400).send({
              error: 'PROVIDER_NOT_CONFIGURED',
              message: 'Apple OAuth is not configured',
            });
          }

          // Generate PKCE if client hasn't provided one
          let codeChallenge = body.codeChallenge;
          if (!codeChallenge) {
            const pkce = appleOAuthProvider.generatePKCE();
            codeChallenge = pkce.codeChallenge;
            codeVerifier = pkce.codeVerifier;
          }

          authorizationUrl = appleOAuthProvider.getAuthorizationUrl({
            redirectUri: body.redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod: body.codeChallengeMethod ?? 'S256',
          });
          break;
        }

        default:
          return reply.status(400).send({
            error: 'INVALID_PROVIDER',
            message: `Unknown OAuth provider: ${body.provider}`,
          });
      }

      // Store state for validation (including platform for callback)
      const stateData: OAuthStateData = {
        provider: body.provider,
        redirectUri: body.redirectUri,
        codeVerifier,
        platform: body.platform as 'ios' | 'android' | 'web' ?? 'web',
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      };
      await stateStoreService.set(state, stateData);

      // Log PKCE status for debugging
      if (codeVerifier) {
        logger.info(
          { platform: body.platform, state, codeVerifierLength: codeVerifier.length },
          'Generated PKCE code verifier for mobile client'
        );
      }

      // Response includes codeVerifier in both camelCase and snake_case for client compatibility:
      // - codeVerifier: JavaScript/TypeScript convention
      // - code_verifier: OAuth 2.0 PKCE specification convention (RFC 7636)
      // Both fields contain the identical value. Clients should use whichever matches their convention.
      return reply.send({
        authorizationUrl,
        state,
        ...(codeVerifier ? { codeVerifier, code_verifier: codeVerifier } : {}),
      });
    }
  );

  /**
   * OAuth callback - exchange code for tokens
   */
  fastify.post(
    '/auth/oauth/callback',
    {
      config: {
        rateLimit: {
          max: 10, // 10 requests per minute - strict limit for token exchange
          timeWindow: '1 minute',
        },
      },
      schema: {
        description: 'Exchange OAuth authorization code for tokens',
        tags: ['Auth'],
        body: {
          type: 'object',
          required: ['provider', 'code', 'redirectUri'],
          properties: {
            provider: { type: 'string', enum: ['google', 'apple'] },
            code: { type: 'string' },
            redirectUri: { type: 'string' }, // Allow custom schemes for mobile
            state: { type: 'string' },
            codeVerifier: { type: 'string' },
            platform: { type: 'string', enum: ['ios', 'android', 'web'], default: 'web' },
            deviceInfo: {
              type: 'object',
              properties: {
                deviceId: { type: 'string' },
                deviceName: { type: 'string' },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              refreshToken: { type: 'string' },
              expiresIn: { type: 'number' },
              tokenType: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  avatarUrl: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = oauthCallbackRequestSchema.parse(request.body) as OAuthCallbackRequest & { state?: string };

      // Validate state if provided
      let codeVerifier = body.codeVerifier;
      let platform: ClientPlatformType = body.platform ?? 'web';

      if (body.state) {
        const storedState = await stateStoreService.get(body.state, true); // deleteAfterGet
        if (!storedState) {
          return reply.status(400).send({
            error: 'INVALID_STATE',
            message: 'Invalid or expired state parameter',
          });
        }

        if (storedState.provider !== body.provider) {
          return reply.status(400).send({
            error: 'PROVIDER_MISMATCH',
            message: 'OAuth provider does not match state',
          });
        }

        // Use stored code verifier if not provided
        if (!codeVerifier && storedState.codeVerifier) {
          codeVerifier = storedState.codeVerifier;
        }

        // Use stored platform (takes precedence over body to ensure consistency)
        if (storedState.platform) {
          platform = storedState.platform;
        }
      }

      // Get device info
      const deviceInfo = {
        deviceId: body.deviceInfo?.deviceId,
        deviceName: body.deviceInfo?.deviceName,
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      };

      switch (body.provider) {
        case OAuthProvider.GOOGLE: {
          logger.info({ platform, redirectUri: body.redirectUri }, 'Processing Google OAuth callback');

          // Exchange code for tokens (using platform-specific client ID)
          const tokens = await googleOAuthProvider.exchangeCode(
            body.code,
            body.redirectUri,
            codeVerifier,
            platform
          );

          // Get user profile
          const profile = await googleOAuthProvider.getUserInfo(tokens.accessToken);

          // Find or create user (pass deviceInfo for signup credits grant)
          const user = await authService.findOrCreateUserFromOAuth(
            OAuthProvider.GOOGLE,
            profile,
            tokens,
            deviceInfo
          );

          // Create auth response
          const authResponse = await authService.createAuthResponse(user, deviceInfo);
          return reply.send(authResponse);
        }

        case OAuthProvider.APPLE: {
          // Exchange code for tokens
          const tokens = await appleOAuthProvider.exchangeCode(
            body.code,
            body.redirectUri,
            codeVerifier
          );

          // Decode ID token to get user info
          if (!tokens.idToken) {
            return reply.status(400).send({
              error: 'MISSING_ID_TOKEN',
              message: 'Apple did not return an ID token',
            });
          }

          const profile = await appleOAuthProvider.decodeIdToken(tokens.idToken);

          // Find or create user (pass deviceInfo for signup credits grant)
          const user = await authService.findOrCreateUserFromOAuth(
            OAuthProvider.APPLE,
            profile,
            tokens,
            deviceInfo
          );

          // Create auth response
          const authResponse = await authService.createAuthResponse(user, deviceInfo);
          return reply.send(authResponse);
        }

        default:
          return reply.status(400).send({
            error: 'INVALID_PROVIDER',
            message: `Unknown OAuth provider: ${body.provider}`,
          });
      }
    }
  );

  /**
   * Refresh access token
   */
  fastify.post(
    '/auth/refresh',
    {
      config: {
        rateLimit: {
          max: 30, // 30 requests per minute - allow some retries but prevent abuse
          timeWindow: '1 minute',
        },
      },
      schema: {
        description: 'Refresh access token using refresh token',
        tags: ['Auth'],
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              refreshToken: { type: 'string' },
              expiresIn: { type: 'number' },
              tokenType: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = refreshTokenRequestSchema.parse(request.body);

      const deviceInfo = {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      };

      try {
        const result = await authService.refreshAccessToken(body.refreshToken, deviceInfo);

        return reply.send({
          ...result,
          tokenType: 'Bearer',
        });
      } catch (error) {
        // Format error with specific code for debugging
        const authError = formatAuthError(error);

        // Log with context for debugging
        logger.info(
          {
            errorCode: authError.code,
            errorMessage: authError.message,
            context: authError.context,
            ip: request.ip,
          },
          'Token refresh failed'
        );

        return reply.status(401).send({
          error: authError.code,
          message: authError.message,
        });
      }
    }
  );

  /**
   * Logout - revoke refresh token
   */
  fastify.post(
    '/auth/logout',
    {
      schema: {
        description: 'Logout user by revoking refresh token(s)',
        tags: ['Auth'],
        body: {
          type: 'object',
          properties: {
            refreshToken: { type: 'string' },
            allDevices: { type: 'boolean', default: false },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = logoutRequestSchema.parse(request.body);

      // If allDevices is true and user is authenticated, revoke all tokens
      if (body.allDevices && request.user) {
        await authService.revokeAllRefreshTokens(request.user.id);
        return reply.send({
          success: true,
          message: 'Logged out from all devices',
        });
      }

      // Revoke specific refresh token
      if (body.refreshToken) {
        await authService.revokeRefreshToken(body.refreshToken);
        return reply.send({
          success: true,
          message: 'Logged out successfully',
        });
      }

      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: 'Provide refreshToken or set allDevices to true',
      });
    }
  );

  /**
   * Get current user profile
   */
  fastify.get(
    '/auth/me',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get current authenticated user profile',
        tags: ['Auth'],
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              emailVerified: { type: 'boolean' },
              name: { type: 'string' },
              avatarUrl: { type: 'string' },
              createdAt: { type: 'string' },
              lastLoginAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;

      return reply.send({
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString(),
      });
    }
  );

  /**
   * Check OAuth provider availability
   */
  fastify.get(
    '/auth/providers',
    {
      schema: {
        description: 'Get available OAuth providers',
        tags: ['Auth'],
        response: {
          200: {
            type: 'object',
            properties: {
              google: { type: 'boolean' },
              apple: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        google: googleOAuthProvider.isConfigured(),
        apple: appleOAuthProvider.isConfigured(),
      });
    }
  );

  /**
   * Debug endpoint to decode a token without verification
   * Useful for debugging token issues
   * Only available in development/staging
   */
  fastify.post(
    '/auth/debug/decode-token',
    {
      schema: {
        description: 'Decode a JWT token without verification (debug only)',
        tags: ['Auth'],
        body: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              decoded: { type: 'object' },
              header: { type: 'object' },
              isExpired: { type: 'boolean' },
              expiresAt: { type: 'string' },
              issuedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { token: string } }>, reply: FastifyReply) => {
      const { token } = request.body;

      // Only allow in non-production environments
      if (config.server.env === 'production') {
        return reply.status(403).send({
          error: 'FORBIDDEN',
          message: 'This endpoint is not available in production',
        });
      }

      try {
        // Decode without verification
        const decoded = jwt.decode(token, { complete: true });

        if (!decoded) {
          return reply.status(400).send({
            error: 'INVALID_TOKEN',
            message: 'Could not decode token - not a valid JWT format',
          });
        }

        const payload = decoded.payload as Record<string, unknown>;
        const now = Math.floor(Date.now() / 1000);
        const exp = payload.exp as number | undefined;
        const iat = payload.iat as number | undefined;

        return reply.send({
          decoded: payload,
          header: decoded.header,
          isExpired: exp ? exp < now : false,
          expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
          issuedAt: iat ? new Date(iat * 1000).toISOString() : null,
          hasTypeField: 'type' in payload,
          typeValue: payload.type,
        });
      } catch (error) {
        return reply.status(400).send({
          error: 'DECODE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to decode token',
        });
      }
    }
  );
}

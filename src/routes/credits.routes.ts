import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { creditsService } from '../services/credits.service.js';
import { stripeService } from '../services/stripe.service.js';
import { globalConfigService } from '../services/global-config.service.js';
import { requireUserAuth, requireAdmin } from '../middleware/auth.middleware.js';
import { getLogger } from '../utils/logger.js';
import {
  createCheckoutSessionSchema,
  spendCreditsSchema,
  jobCostEstimateSchema,
  CreditPacks,
  AddOnService,
  type CreditPackType,
} from '../types/credits.types.js';

const logger = getLogger().child({ service: 'credits-routes' });

/** Query schema for balance endpoint */
const balanceQuerySchema = z.object({
  includeHistory: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Schema for recalculate endpoint */
const recalculateBodySchema = z.object({
  userId: z.string().uuid(),
});

/** Extended request type with raw body */
interface FastifyRequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

/**
 * Credits routes for balance management and Stripe checkout
 */
export async function creditsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Get user's credit balance and recent transactions
   */
  fastify.get(
    '/credits/balance',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get current credit balance and recent transactions',
        tags: ['Credits'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            includeHistory: { type: 'boolean', default: true },
            limit: { type: 'number', default: 20, minimum: 1, maximum: 100 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              balance: { type: 'number' },
              transactions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    creditsDelta: { type: 'number' },
                    type: { type: 'string' },
                    description: { type: 'string', nullable: true },
                    createdAt: { type: 'string' },
                    jobId: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'User not authenticated' });
      }
      const user = request.user;
      const query = balanceQuerySchema.parse(request.query);
      const { includeHistory, limit } = query;

      if (includeHistory) {
        const result = await creditsService.getBalanceWithHistory(user.id, limit);
        return reply.send(result);
      }

      const balance = await creditsService.getBalance(user.id);
      return reply.send({ balance });
    }
  );

  /**
   * Get available credit packs
   */
  fastify.get(
    '/credits/packs',
    {
      schema: {
        description: 'Get available credit packs with pricing',
        tags: ['Credits'],
        response: {
          200: {
            type: 'object',
            properties: {
              packs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    packType: { type: 'string' },
                    credits: { type: 'number' },
                    priceUsd: { type: 'number' },
                    name: { type: 'string' },
                    available: { type: 'boolean' },
                  },
                },
              },
              stripeConfigured: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const stripeConfigured = stripeService.isConfigured();

      if (stripeConfigured) {
        const packs = stripeService.getAvailablePacks();
        return reply.send({
          packs: packs.map(({ stripePriceId: _stripePriceId, ...rest }) => rest),
          stripeConfigured: true,
        });
      }

      // Return basic pack info even if Stripe isn't configured
      const packs = Object.entries(CreditPacks).map(([key, pack]) => ({
        packType: key as CreditPackType,
        credits: pack.credits,
        priceUsd: pack.priceUsd,
        name: pack.name,
        available: false,
      }));

      return reply.send({ packs, stripeConfigured: false });
    }
  );

  /**
   * Get pricing configuration
   * Returns the current pricing model for job cost calculations
   */
  fastify.get(
    '/credits/pricing',
    {
      schema: {
        description: 'Get current pricing configuration for job costs',
        tags: ['Credits'],
        response: {
          200: {
            type: 'object',
            properties: {
              baseCredits: { type: 'number', description: 'Base cost per job' },
              creditsPerSecond: { type: 'number', description: 'Credits per second of video' },
              includedFrames: { type: 'number', description: 'Frames included in base price' },
              extraFrameCost: { type: 'number', description: 'Cost per extra frame' },
              addOns: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    cost: { type: 'number' },
                    enabled: { type: 'boolean' },
                  },
                },
              },
              minJobCost: { type: 'number', description: 'Minimum job cost' },
              maxJobCost: { type: 'number', description: 'Maximum job cost (0 = no limit)' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const pricing = await globalConfigService.getPricingConfig();

      return reply.send({
        baseCredits: pricing.baseCredits,
        creditsPerSecond: pricing.creditsPerSecond,
        includedFrames: pricing.includedFrames,
        extraFrameCost: pricing.extraFrameCost,
        addOns: [
          {
            id: AddOnService.EXTRA_FRAMES,
            name: 'Extra Frames',
            description: 'Extract additional frames beyond the default',
            cost: pricing.extraFrameCost,
            enabled: true,
          },
          {
            id: AddOnService.COMMERCIAL_VIDEO,
            name: 'Commercial Video Generation',
            description: 'Generate commercial-quality video from extracted frames',
            cost: pricing.commercialVideoCost,
            enabled: pricing.commercialVideoEnabled,
          },
        ],
        minJobCost: pricing.minJobCost,
        maxJobCost: pricing.maxJobCost,
      });
    }
  );

  /**
   * Estimate job cost
   * Calculate the credit cost for a job based on video duration and options
   *
   * Note: Uses Zod for validation instead of Fastify schema to provide detailed error messages.
   * Fastify schema is kept for OpenAPI documentation only (no validation duplication).
   */
  fastify.post(
    '/credits/estimate',
    {
      schema: {
        description: 'Estimate credit cost for a job based on video duration and options',
        tags: ['Credits'],
        // Schema for OpenAPI docs only - validation is done by Zod
        body: {
          type: 'object',
          required: ['videoDurationSeconds'],
          properties: {
            videoDurationSeconds: { type: 'number', minimum: 0, description: 'Video duration in seconds' },
            frameCount: { type: 'number', minimum: 1, description: 'Number of frames to extract (optional)' },
            addOns: {
              type: 'array',
              items: { type: 'string', enum: ['extra_frames', 'commercial_video'] },
              description: 'Add-on services to include',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              totalCredits: { type: 'number', description: 'Total credits required' },
              breakdown: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    description: { type: 'string' },
                    credits: { type: 'number' },
                    details: { type: 'object', additionalProperties: true },
                  },
                },
              },
              canAfford: { type: 'boolean', description: 'Whether current user can afford (if authenticated)' },
              currentBalance: { type: 'number', description: 'Current balance (if authenticated)' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Zod validation provides detailed error messages
      const parseResult = jobCostEstimateSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parseResult.error.issues,
        });
      }

      const body = parseResult.data;

      // If user is authenticated, include affordability check
      if (request.user) {
        const result = await creditsService.calculateJobCostWithAffordability(
          request.user.id,
          {
            videoDurationSeconds: body.videoDurationSeconds,
            frameCount: body.frameCount,
            addOns: body.addOns,
          }
        );
        return reply.send(result);
      }

      // Unauthenticated - just return cost estimate
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: body.videoDurationSeconds,
        frameCount: body.frameCount,
        addOns: body.addOns,
      });
      return reply.send(result);
    }
  );

  /**
   * Create Stripe checkout session
   */
  fastify.post(
    '/credits/checkout',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Create a Stripe checkout session to purchase credits',
        tags: ['Credits'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['packType', 'successUrl', 'cancelUrl'],
          properties: {
            packType: { type: 'string', enum: ['CREDIT_1', 'PACK_20', 'PACK_100', 'PACK_500'] },
            successUrl: { type: 'string', format: 'uri' },
            cancelUrl: { type: 'string', format: 'uri' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              checkoutUrl: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'User not authenticated' });
      }
      const user = request.user;

      if (!stripeService.isConfigured()) {
        return reply.status(503).send({
          error: 'STRIPE_NOT_CONFIGURED',
          message: 'Payment processing is not available',
        });
      }

      const parseResult = createCheckoutSessionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parseResult.error.issues,
        });
      }
      const body = parseResult.data;

      try {
        const session = await stripeService.createCheckoutSession(
          user.id,
          user.email,
          body.packType,
          body.successUrl,
          body.cancelUrl
        );

        return reply.send(session);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ userId: user.id, packType: body.packType, error: errorMessage }, 'Failed to create checkout session');

        // Differentiate between configuration errors and server errors
        if (errorMessage.includes('No price ID configured')) {
          return reply.status(400).send({
            error: 'PACK_NOT_AVAILABLE',
            message: `The selected pack is not available for purchase`,
          });
        }

        return reply.status(500).send({
          error: 'CHECKOUT_FAILED',
          message: 'Failed to create checkout session. Please try again.',
        });
      }
    }
  );

  /**
   * Stripe webhook handler
   * Note: This endpoint is excluded from auth middleware via AUTH_SKIP_PATHS
   */
  fastify.post(
    '/credits/webhook',
    {
      schema: {
        description: 'Stripe webhook endpoint',
        tags: ['Credits'],
        hide: true, // Hide from Swagger docs
      },
    },
    async (request: FastifyRequestWithRawBody, reply: FastifyReply) => {
      const signature = request.headers['stripe-signature'] as string;

      if (!signature) {
        return reply.status(400).send({
          error: 'MISSING_SIGNATURE',
          message: 'Missing stripe-signature header',
        });
      }

      if (!stripeService.isConfigured()) {
        logger.warn('Received Stripe webhook but Stripe is not configured');
        return reply.status(503).send({
          error: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        });
      }

      try {
        // Get the raw body preserved by the content type parser in app.ts
        const rawBody = request.rawBody;
        if (!rawBody) {
          logger.error('Raw body not available for webhook signature verification');
          return reply.status(500).send({
            error: 'INTERNAL_ERROR',
            message: 'Unable to verify webhook signature',
          });
        }

        // Verify webhook signature using the actual raw bytes
        const event = stripeService.verifyWebhookSignature(rawBody, signature);

        // Process the event
        await stripeService.processWebhookEvent(event);

        return reply.send({ received: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        if (errorMessage.includes('signature') || errorMessage.includes('Webhook')) {
          logger.warn({ error: errorMessage }, 'Invalid Stripe webhook signature');
          return reply.status(400).send({
            error: 'INVALID_SIGNATURE',
            message: 'Invalid webhook signature',
          });
        }

        logger.error({ error: errorMessage }, 'Failed to process Stripe webhook');
        return reply.status(500).send({
          error: 'WEBHOOK_FAILED',
          message: 'Failed to process webhook',
        });
      }
    }
  );

  /**
   * Spend credits (for internal/API use)
   */
  fastify.post(
    '/credits/spend',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Spend credits (idempotent via idempotencyKey)',
        tags: ['Credits'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['amount', 'idempotencyKey'],
          properties: {
            amount: { type: 'number', minimum: 1 },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 255 },
            jobId: { type: 'string', format: 'uuid' },
            description: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              newBalance: { type: 'number' },
              transactionId: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'User not authenticated' });
      }
      const user = request.user;

      const parseResult = spendCreditsSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parseResult.error.issues,
        });
      }
      const body = parseResult.data;

      const result = await creditsService.spendCredits(
        user.id,
        body.amount,
        body.idempotencyKey,
        body.jobId,
        body.description
      );

      if (!result.success) {
        return reply.status(402).send(result); // 402 Payment Required
      }

      return reply.send(result);
    }
  );

  /**
   * Recalculate balance (admin utility)
   * Requires admin API key authentication
   */
  fastify.post(
    '/credits/recalculate',
    {
      preHandler: [requireAdmin],
      schema: {
        description: 'Recalculate cached balance from ledger (admin only)',
        tags: ['Credits'],
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              previousBalance: { type: 'number' },
              calculatedBalance: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = recalculateBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parseResult.error.issues,
        });
      }

      const { userId } = parseResult.data;

      try {
        const previousBalance = await creditsService.getBalance(userId);
        const calculatedBalance = await creditsService.recalculateBalance(userId);

        if (previousBalance !== calculatedBalance) {
          logger.warn(
            { userId, previousBalance, calculatedBalance },
            'Balance discrepancy detected and corrected'
          );
        }

        return reply.send({ userId, previousBalance, calculatedBalance });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (errorMessage.includes('User not found')) {
          return reply.status(404).send({
            error: 'USER_NOT_FOUND',
            message: `User ${userId} not found`,
          });
        }
        throw error;
      }
    }
  );
}

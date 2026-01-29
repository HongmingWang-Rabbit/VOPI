import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { requireUserAuth } from '../middleware/auth.middleware.js';
import { getDatabase, schema } from '../db/index.js';
import { tokenRefreshService } from '../services/token-refresh.service.js';
import { shopifyProvider } from '../providers/ecommerce/shopify.provider.js';
import { amazonProvider } from '../providers/ecommerce/amazon.provider.js';
import { ebayProvider } from '../providers/ecommerce/ebay.provider.js';
import {
  pushListingRequestSchema,
  PlatformType,
  ListingStatus,
} from '../types/auth.types.js';
import type {
  ShopifyConnectionMetadata,
  AmazonConnectionMetadata,
  EbayConnectionMetadata,
} from '../types/auth.types.js';
import { z } from 'zod';
import { storageService } from '../services/storage.service.js';
import { extractS3KeyFromUrl } from '../utils/s3-url.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger().child({ service: 'listings' });

const listingIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const listingsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  status: z.enum(['pending', 'pushing', 'completed', 'failed']).optional(),
});

/**
 * Helper: Execute the product push to a platform
 * Shared between push and retry endpoints
 */
async function executePush(params: {
  db: ReturnType<typeof getDatabase>;
  listing: { id: string; metadata: unknown };
  connection: {
    id: string;
    platform: string;
    metadata: unknown;
    userId: string;
  };
  job: {
    productMetadata: { product?: Record<string, unknown> } | null;
    result?: { finalFrames?: string[]; commercialImages?: Record<string, Record<string, string>> } | null;
  };
  options?: {
    publishAsDraft?: boolean;
    skipImages?: boolean;
    overrideMetadata?: Record<string, unknown>;
  };
}): Promise<{
  success: boolean;
  productId?: string;
  productUrl?: string;
  error?: string;
}> {
  const { db, listing, connection, job, options } = params;

  try {
    // Get valid access token with user ownership verification
    const accessToken = await tokenRefreshService.getValidAccessToken(connection.id, connection.userId);

    // Prepare metadata
    const productData = job.productMetadata?.product || {};
    const metadata: Record<string, unknown> = options?.overrideMetadata
      ? { ...productData, ...options.overrideMetadata }
      : { ...productData };

    const publishAsDraft = options?.publishAsDraft !== false;

    let result;

    // Push to platform
    switch (connection.platform) {
      case PlatformType.SHOPIFY: {
        const shopMetadata = connection.metadata as ShopifyConnectionMetadata;
        result = await shopifyProvider.createProduct(accessToken, metadata, {
          publishAsDraft,
          shop: shopMetadata.shop,
        });
        break;
      }

      case PlatformType.AMAZON: {
        const amazonMetadata = connection.metadata as AmazonConnectionMetadata;
        result = await amazonProvider.createProduct(accessToken, metadata, {
          publishAsDraft,
          sellerId: amazonMetadata.sellerId,
          marketplaceId: amazonMetadata.marketplaceIds?.[0],
        });
        break;
      }

      case PlatformType.EBAY: {
        const ebayMetadata = connection.metadata as EbayConnectionMetadata;
        result = await ebayProvider.createProduct(accessToken, metadata, {
          publishAsDraft,
          marketplaceId: ebayMetadata.marketplaceId,
        });
        break;
      }

      default:
        throw new Error(`Unsupported platform: ${connection.platform}`);
    }

    if (!result.success) {
      // Update listing as failed
      await db
        .update(schema.platformListings)
        .set({
          status: ListingStatus.FAILED,
          lastError: result.error,
          updatedAt: new Date(),
        })
        .where(eq(schema.platformListings.id, listing.id));

      return { success: false, error: result.error };
    }

    // Upload images if not skipped
    // Prefer commercial images (processed with backgrounds removed, lifestyle shots, etc.)
    // over raw finalFrames (unprocessed video frames)
    let rawUrls: string[] = [];
    if (!options?.skipImages) {
      const commercialImages = job.result?.commercialImages;
      if (commercialImages && Object.keys(commercialImages).length > 0) {
        // Extract all commercial image URLs, flatten frameId -> variant -> url
        for (const variants of Object.values(commercialImages)) {
          for (const url of Object.values(variants)) {
            rawUrls.push(url);
          }
        }
        rawUrls = rawUrls.slice(0, 10);
        logger.info({ imageCount: rawUrls.length }, 'Using commercial images for listing push');
      } else if (job.result?.finalFrames?.length) {
        rawUrls = job.result.finalFrames.slice(0, 10);
        logger.info({ imageCount: rawUrls.length }, 'No commercial images, falling back to raw frames');
      }
    }

    if (rawUrls.length > 0) {

      // Convert private S3 URLs to presigned public URLs so Shopify/platforms can fetch them
      const config = getConfig();
      const imageUrls = await Promise.all(
        rawUrls.map(async (url) => {
          const s3Key = extractS3KeyFromUrl(url, config.storage, { allowAnyHost: true });
          if (s3Key) {
            return storageService.getPresignedUrl(s3Key, 3600); // 1 hour expiry
          }
          logger.warn({ url }, 'Could not extract S3 key from image URL, using raw URL');
          return url;
        })
      );

      switch (connection.platform) {
        case PlatformType.SHOPIFY: {
          const shopMetadata = connection.metadata as ShopifyConnectionMetadata;
          await shopifyProvider.uploadImages(
            accessToken,
            result.productId!,
            imageUrls,
            { shop: shopMetadata.shop }
          );
          break;
        }
        case PlatformType.AMAZON: {
          const amazonMetadata = connection.metadata as AmazonConnectionMetadata;
          await amazonProvider.uploadImages(
            accessToken,
            result.productId!,
            imageUrls,
            { sellerId: amazonMetadata.sellerId }
          );
          break;
        }
        case PlatformType.EBAY: {
          await ebayProvider.uploadImages(
            accessToken,
            result.productId!,
            imageUrls
          );
          break;
        }
      }
    }

    // Update listing as completed
    const existingMetadata = (listing.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(schema.platformListings)
      .set({
        status: ListingStatus.COMPLETED,
        platformProductId: result.productId,
        metadata: {
          ...existingMetadata,
          productUrl: result.productUrl,
          imageCount: job.result?.finalFrames?.length || 0,
        },
        updatedAt: new Date(),
      })
      .where(eq(schema.platformListings.id, listing.id));

    // Update connection last used
    await db
      .update(schema.platformConnections)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.platformConnections.id, connection.id));

    return {
      success: true,
      productId: result.productId,
      productUrl: result.productUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    // Update listing as failed
    await db
      .update(schema.platformListings)
      .set({
        status: ListingStatus.FAILED,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(schema.platformListings.id, listing.id));

    return { success: false, error: message };
  }
}

/**
 * Listings routes for pushing products to e-commerce platforms
 */
export async function listingsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Push a product to a platform
   */
  fastify.post(
    '/listings/push',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Push product from a job to an e-commerce platform',
        tags: ['Listings'],
        body: {
          type: 'object',
          required: ['jobId', 'connectionId'],
          properties: {
            jobId: { type: 'string', format: 'uuid' },
            connectionId: { type: 'string', format: 'uuid' },
            options: {
              type: 'object',
              properties: {
                publishAsDraft: { type: 'boolean', default: true },
                skipImages: { type: 'boolean', default: false },
                overrideMetadata: { type: 'object' },
              },
            },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              platformProductId: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = pushListingRequestSchema.parse(request.body);
      const db = getDatabase();

      // Verify connection belongs to user and is active
      const [connection] = await db
        .select()
        .from(schema.platformConnections)
        .where(
          and(
            eq(schema.platformConnections.id, body.connectionId),
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

      if (connection.status !== 'active') {
        return reply.status(400).send({
          error: 'CONNECTION_INACTIVE',
          message: `Connection is ${connection.status}`,
        });
      }

      // Get job and verify it belongs to user
      const [job] = await db
        .select()
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.id, body.jobId),
            eq(schema.jobs.userId, request.user!.id)
          )
        )
        .limit(1);

      if (!job) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Job not found',
        });
      }

      if (!job.productMetadata) {
        return reply.status(400).send({
          error: 'NO_METADATA',
          message: 'Job has no product metadata',
        });
      }

      // Create listing record
      const productMetadata = job.productMetadata as unknown as { product?: Record<string, unknown> } | null;
      const [listing] = await db
        .insert(schema.platformListings)
        .values({
          connectionId: body.connectionId,
          jobId: body.jobId,
          status: ListingStatus.PUSHING,
          metadata: {
            title: (productMetadata?.product?.title as string) ?? undefined,
            pushedAt: new Date().toISOString(),
          },
        })
        .returning();

      // Execute the push using the helper function
      const result = await executePush({
        db,
        listing: { id: listing.id, metadata: listing.metadata },
        connection: {
          id: connection.id,
          platform: connection.platform,
          metadata: connection.metadata,
          userId: request.user!.id,
        },
        job: {
          productMetadata,
          result: job.result as { finalFrames?: string[]; commercialImages?: Record<string, Record<string, string>> } | null,
        },
        options: body.options,
      });

      if (!result.success) {
        return reply.status(400).send({
          error: 'PUSH_FAILED',
          message: result.error,
          listingId: listing.id,
        });
      }

      return reply.status(201).send({
        id: listing.id,
        status: ListingStatus.COMPLETED,
        platformProductId: result.productId,
        productUrl: result.productUrl,
        message: 'Product pushed successfully',
      });
    }
  );

  /**
   * List user's listings
   */
  fastify.get(
    '/listings',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'List user listings',
        tags: ['Listings'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'number', minimum: 0, default: 0 },
            status: { type: 'string', enum: ['pending', 'pushing', 'completed', 'failed'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              listings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    connectionId: { type: 'string' },
                    jobId: { type: 'string' },
                    platformProductId: { type: 'string' },
                    status: { type: 'string' },
                    metadata: { type: 'object' },
                    lastError: { type: 'string' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
              total: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = listingsQuerySchema.parse(request.query);
      const db = getDatabase();

      // Get user's connection IDs
      const userConnections = await db
        .select({ id: schema.platformConnections.id })
        .from(schema.platformConnections)
        .where(eq(schema.platformConnections.userId, request.user!.id));

      const connectionIds = userConnections.map((c) => c.id);

      if (connectionIds.length === 0) {
        return reply.send({ listings: [], total: 0 });
      }

      // Build conditions using SQL inArray for efficient filtering
      const conditions = [inArray(schema.platformListings.connectionId, connectionIds)];

      // Add status filter if provided
      if (query.status) {
        conditions.push(eq(schema.platformListings.status, query.status));
      }

      const whereClause = and(...conditions);

      // Execute queries in parallel for better performance
      const [listings, countResult] = await Promise.all([
        db
          .select()
          .from(schema.platformListings)
          .where(whereClause)
          .orderBy(desc(schema.platformListings.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ count: sql<number>`count(*)` })
          .from(schema.platformListings)
          .where(whereClause),
      ]);

      const total = Number(countResult[0]?.count || 0);

      return reply.send({
        listings: listings.map((l) => ({
          id: l.id,
          connectionId: l.connectionId,
          jobId: l.jobId,
          platformProductId: l.platformProductId,
          status: l.status,
          metadata: l.metadata,
          lastError: l.lastError,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        })),
        total,
      });
    }
  );

  /**
   * Get listing details
   */
  fastify.get(
    '/listings/:id',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get listing details',
        tags: ['Listings'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              connectionId: { type: 'string' },
              jobId: { type: 'string' },
              platform: { type: 'string' },
              platformProductId: { type: 'string', nullable: true },
              status: { type: 'string' },
              metadata: { type: 'object', nullable: true },
              lastError: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = listingIdParamsSchema.parse(request.params);
      const db = getDatabase();

      const [listing] = await db
        .select()
        .from(schema.platformListings)
        .where(eq(schema.platformListings.id, id))
        .limit(1);

      if (!listing) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Listing not found',
        });
      }

      // Verify connection belongs to user
      const [connection] = await db
        .select()
        .from(schema.platformConnections)
        .where(
          and(
            eq(schema.platformConnections.id, listing.connectionId),
            eq(schema.platformConnections.userId, request.user!.id)
          )
        )
        .limit(1);

      if (!connection) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Listing not found',
        });
      }

      return reply.send({
        id: listing.id,
        connectionId: listing.connectionId,
        jobId: listing.jobId,
        platform: connection.platform,
        platformProductId: listing.platformProductId,
        status: listing.status,
        metadata: listing.metadata,
        lastError: listing.lastError,
        createdAt: listing.createdAt.toISOString(),
        updatedAt: listing.updatedAt.toISOString(),
      });
    }
  );

  /**
   * Retry a failed listing
   */
  fastify.post(
    '/listings/:id/retry',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Retry a failed listing',
        tags: ['Listings'],
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
      const { id } = listingIdParamsSchema.parse(request.params);
      const db = getDatabase();

      const [listing] = await db
        .select()
        .from(schema.platformListings)
        .where(eq(schema.platformListings.id, id))
        .limit(1);

      if (!listing) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Listing not found',
        });
      }

      // Verify connection belongs to user
      const [connection] = await db
        .select()
        .from(schema.platformConnections)
        .where(
          and(
            eq(schema.platformConnections.id, listing.connectionId),
            eq(schema.platformConnections.userId, request.user!.id)
          )
        )
        .limit(1);

      if (!connection) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Listing not found',
        });
      }

      if (listing.status !== ListingStatus.FAILED) {
        return reply.status(400).send({
          error: 'INVALID_STATUS',
          message: 'Only failed listings can be retried',
        });
      }

      if (!listing.jobId) {
        return reply.status(400).send({
          error: 'NO_JOB',
          message: 'Listing has no associated job',
        });
      }

      // Get the associated job
      const [job] = await db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, listing.jobId))
        .limit(1);

      if (!job) {
        return reply.status(404).send({
          error: 'JOB_NOT_FOUND',
          message: 'Associated job not found',
        });
      }

      if (!job.productMetadata) {
        return reply.status(400).send({
          error: 'NO_METADATA',
          message: 'Job has no product metadata',
        });
      }

      // Update listing status to pushing
      const existingMeta = listing.metadata as Record<string, unknown> || {};
      const retryCount = (existingMeta.retryCount as number || 0) + 1;
      await db
        .update(schema.platformListings)
        .set({
          status: ListingStatus.PUSHING,
          lastError: null,
          metadata: {
            ...existingMeta,
            retryCount,
          } as typeof listing.metadata,
          updatedAt: new Date(),
        })
        .where(eq(schema.platformListings.id, id));

      // Execute the push
      const productMetadata = job.productMetadata as unknown as { product?: Record<string, unknown> } | null;
      const result = await executePush({
        db,
        listing: { id: listing.id, metadata: listing.metadata },
        connection: {
          id: connection.id,
          platform: connection.platform,
          metadata: connection.metadata,
          userId: request.user!.id,
        },
        job: {
          productMetadata,
          result: job.result as { finalFrames?: string[]; commercialImages?: Record<string, Record<string, string>> } | null,
        },
        options: {
          publishAsDraft: true,
        },
      });

      if (!result.success) {
        return reply.status(400).send({
          error: 'RETRY_FAILED',
          message: result.error,
          listingId: listing.id,
          retryCount,
        });
      }

      return reply.send({
        id: listing.id,
        status: ListingStatus.COMPLETED,
        platformProductId: result.productId,
        productUrl: result.productUrl,
        message: 'Product pushed successfully on retry',
        retryCount,
      });
    }
  );
}

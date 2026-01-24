import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { jobsController } from '../controllers/jobs.controller.js';
import { createJobSchema, jobListQuerySchema } from '../types/job.types.js';
import { storageService } from '../services/storage.service.js';
import { getConfig } from '../config/index.js';
import { extractS3KeyFromUrl } from '../utils/s3-url.js';
import { requireUserAuth } from '../middleware/auth.middleware.js';
import { z } from 'zod';

const jobIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const presignBodySchema = z.object({
  filename: z.string().max(255).optional(),
  contentType: z.enum(['video/mp4', 'video/quicktime', 'video/webm']).default('video/mp4'),
  expiresIn: z.number().int().min(60).max(86400).optional(), // 1 minute to 24 hours
});

const downloadPresignQuerySchema = z.object({
  expiresIn: z.coerce.number().int().min(60).max(86400).default(3600), // 1 minute to 24 hours
});

const updateProductMetadataSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  shortDescription: z.string().max(500).optional(),
  bulletPoints: z.array(z.string().max(500)).max(10).optional(),
  brand: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  subcategory: z.string().max(100).optional(),
  materials: z.array(z.string().max(100)).max(20).optional(),
  color: z.string().max(50).optional(),
  colors: z.array(z.string().max(50)).max(20).optional(),
  size: z.string().max(50).optional(),
  sizes: z.array(z.string().max(50)).max(20).optional(),
  keywords: z.array(z.string().max(100)).max(50).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  sku: z.string().max(100).optional(),
  barcode: z.string().max(50).optional(),
  condition: z.enum(['new', 'refurbished', 'used', 'open_box']).optional(),
  careInstructions: z.array(z.string().max(500)).max(10).optional(),
  warnings: z.array(z.string().max(500)).max(10).optional(),
});

/**
 * Jobs routes
 */
export async function jobsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Create a new job
   */
  fastify.post(
    '/jobs',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Create a new pipeline job',
        tags: ['Jobs'],
        body: {
          type: 'object',
          required: ['videoUrl'],
          properties: {
            videoUrl: { type: 'string', format: 'uri' },
            config: {
              type: 'object',
              properties: {
                fps: { type: 'number', minimum: 1, maximum: 30, default: 10 },
                batchSize: { type: 'number', minimum: 1, maximum: 100, default: 30 },
                commercialVersions: {
                  type: 'array',
                  items: { type: 'string', enum: ['transparent', 'solid', 'real', 'creative'] },
                  default: ['transparent', 'solid', 'real', 'creative'],
                },
                aiCleanup: { type: 'boolean', default: true },
                geminiModel: { type: 'string', default: 'gemini-2.0-flash' },
              },
            },
            callbackUrl: { type: 'string', format: 'uri' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              videoUrl: { type: 'string' },
              config: { type: 'object' },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const validated = createJobSchema.parse(request.body);
      const job = await jobsController.createJob(validated, request.user!, request.apiKey);
      return reply.status(201).send(job);
    }
  );

  /**
   * List jobs
   */
  fastify.get(
    '/jobs',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'List jobs with optional filtering',
        tags: ['Jobs'],
        querystring: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: [
                'pending',
                'downloading',
                'extracting',
                'scoring',
                'classifying',
                'extracting_product',
                'generating',
                'completed',
                'failed',
                'cancelled',
              ],
            },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'number', minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              jobs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    videoUrl: { type: 'string' },
                    progress: { type: 'object' },
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
      const query = jobListQuerySchema.parse(request.query);
      const result = await jobsController.listJobs(request.user!.id, query);
      return reply.send(result);
    }
  );

  /**
   * Get job by ID
   */
  fastify.get(
    '/jobs/:id',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get job details by ID',
        tags: ['Jobs'],
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
              status: { type: 'string' },
              videoUrl: { type: 'string' },
              config: { type: 'object' },
              progress: { type: 'object' },
              result: { type: 'object' },
              error: { type: 'string' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
              startedAt: { type: 'string' },
              completedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const job = await jobsController.getJob(id, request.user!.id);
      return reply.send(job);
    }
  );

  /**
   * Get job status (lightweight)
   */
  fastify.get(
    '/jobs/:id/status',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get job status (lightweight endpoint)',
        tags: ['Jobs'],
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
              status: { type: 'string' },
              progress: { type: 'object' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const status = await jobsController.getJobStatus(id, request.user!.id);
      return reply.send(status);
    }
  );

  /**
   * Cancel a job
   */
  fastify.delete(
    '/jobs/:id',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Cancel a pending job',
        tags: ['Jobs'],
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
              status: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const job = await jobsController.cancelJob(id, request.user!.id);
      return reply.send({
        id: job.id,
        status: job.status,
        message: 'Job cancelled successfully',
      });
    }
  );

  /**
   * Get presigned download URLs for job assets
   * Converts stored S3 URLs to time-limited presigned URLs for secure access
   */
  fastify.get(
    '/jobs/:id/download-urls',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get presigned download URLs for job assets (frames and commercial images)',
        tags: ['Jobs'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            expiresIn: {
              type: 'number',
              minimum: 60,
              maximum: 86400,
              default: 3600,
              description: 'URL expiration in seconds (1 minute to 24 hours)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              jobId: { type: 'string' },
              expiresIn: { type: 'number' },
              frames: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    frameId: { type: 'string' },
                    downloadUrl: { type: 'string' },
                  },
                },
              },
              commercialImages: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              metadata: {
                type: 'object',
                nullable: true,
                properties: {
                  downloadUrl: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const { expiresIn } = downloadPresignQuerySchema.parse(request.query);

      // Get job to verify it exists, is complete, and belongs to user
      const job = await jobsController.getJob(id, request.user!.id);
      if (!job.result) {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'Job has no results yet. Wait for job to complete.',
        });
      }

      const config = getConfig();
      const storageConfig = {
        bucket: config.storage.bucket,
        endpoint: config.storage.endpoint,
        region: config.storage.region,
      };

      // Generate presigned URLs for frames in parallel
      const framePromises = (job.result.finalFrames || []).map(async (frameUrl) => {
        const s3Key = extractS3KeyFromUrl(frameUrl, storageConfig, { allowAnyHost: true });
        if (!s3Key) return null;

        const downloadUrl = await storageService.getPresignedUrl(s3Key, expiresIn);
        // Extract frameId from the URL pattern: ...product_X_variant_Y_frame_XXXXX_tX.XX.png
        const frameIdMatch = frameUrl.match(/(frame_\d+)/);
        return {
          frameId: frameIdMatch ? frameIdMatch[1] : path.basename(frameUrl),
          downloadUrl,
        };
      });

      const frameResults = await Promise.all(framePromises);
      const frames = frameResults.filter((f): f is { frameId: string; downloadUrl: string } => f !== null);

      // Generate presigned URLs for commercial images in parallel
      const commercialImages: Record<string, Record<string, string>> = {};
      const commercialPromises: Promise<void>[] = [];

      for (const [productVariant, versions] of Object.entries(job.result.commercialImages || {})) {
        commercialImages[productVariant] = {};

        // Type guard: ensure versions is a record of strings
        if (typeof versions !== 'object' || versions === null) continue;

        for (const [version, url] of Object.entries(versions as Record<string, string>)) {
          if (typeof url !== 'string') continue;

          const s3Key = extractS3KeyFromUrl(url, storageConfig, { allowAnyHost: true });
          if (s3Key) {
            commercialPromises.push(
              storageService.getPresignedUrl(s3Key, expiresIn).then((presignedUrl) => {
                commercialImages[productVariant][version] = presignedUrl;
              })
            );
          }
        }
      }

      await Promise.all(commercialPromises);

      // Include product metadata if available (now stored in database, not S3)
      const productMetadata = job.productMetadata || null;

      return reply.send({
        jobId: id,
        expiresIn,
        frames,
        commercialImages,
        productMetadata,
      });
    }
  );

  /**
   * Get product metadata for a job
   */
  fastify.get(
    '/jobs/:id/metadata',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get product metadata for a job',
        tags: ['Jobs'],
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
              transcript: { type: 'string' },
              product: { type: 'object' },
              platforms: {
                type: 'object',
                properties: {
                  shopify: { type: 'object' },
                  amazon: { type: 'object' },
                  ebay: { type: 'object' },
                },
              },
              extractedAt: { type: 'string' },
              audioDuration: { type: 'number' },
              pipelineVersion: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const metadata = await jobsController.getProductMetadata(id, request.user!.id);

      if (!metadata) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Job has no product metadata. Metadata is only available for jobs processed with audio analysis.',
        });
      }

      return reply.send(metadata);
    }
  );

  /**
   * Update product metadata for a job
   * Allows users to edit AI-extracted metadata before e-commerce upload
   */
  fastify.patch(
    '/jobs/:id/metadata',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Update product metadata for a job. Users can edit AI-extracted fields before uploading to e-commerce platforms.',
        tags: ['Jobs'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 500 },
            description: { type: 'string', maxLength: 10000 },
            shortDescription: { type: 'string', maxLength: 500 },
            bulletPoints: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 10 },
            brand: { type: 'string', maxLength: 100 },
            category: { type: 'string', maxLength: 100 },
            subcategory: { type: 'string', maxLength: 100 },
            materials: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 20 },
            color: { type: 'string', maxLength: 50 },
            colors: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 20 },
            size: { type: 'string', maxLength: 50 },
            sizes: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 20 },
            keywords: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 50 },
            tags: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 50 },
            price: { type: 'number', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            sku: { type: 'string', maxLength: 100 },
            barcode: { type: 'string', maxLength: 50 },
            condition: { type: 'string', enum: ['new', 'refurbished', 'used', 'open_box'] },
            careInstructions: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 10 },
            warnings: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 10 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              transcript: { type: 'string' },
              product: { type: 'object' },
              platforms: {
                type: 'object',
                properties: {
                  shopify: { type: 'object' },
                  amazon: { type: 'object' },
                  ebay: { type: 'object' },
                },
              },
              extractedAt: { type: 'string' },
              audioDuration: { type: 'number' },
              pipelineVersion: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const updates = updateProductMetadataSchema.parse(request.body);

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'No fields to update. Provide at least one field to update.',
        });
      }

      const updatedMetadata = await jobsController.updateProductMetadata(id, request.user!.id, updates);
      return reply.send(updatedMetadata);
    }
  );

  /**
   * Get presigned URL for video upload
   */
  fastify.post(
    '/uploads/presign',
    {
      preHandler: [requireUserAuth],
      schema: {
        description: 'Get a presigned URL for uploading a video',
        tags: ['Uploads'],
        body: {
          type: 'object',
          properties: {
            filename: { type: 'string', maxLength: 255, description: 'Original filename (for extension detection)' },
            contentType: {
              type: 'string',
              default: 'video/mp4',
              enum: ['video/mp4', 'video/quicktime', 'video/webm'],
              description: 'MIME type of the video'
            },
            expiresIn: {
              type: 'number',
              minimum: 60,
              maximum: 86400,
              default: 3600,
              description: 'Presigned URL expiration in seconds (1 minute to 24 hours)'
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              uploadUrl: { type: 'string', description: 'Presigned URL for PUT request' },
              key: { type: 'string', description: 'S3 key for the uploaded file' },
              publicUrl: { type: 'string', description: 'Public URL after upload completes' },
              expiresIn: { type: 'number', description: 'Seconds until the presigned URL expires' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = presignBodySchema.parse(request.body);

      // Generate unique key for the upload
      const uploadId = randomUUID();

      // Safely extract extension using path.extname (handles edge cases like .mp4, video..mp4)
      let ext = 'mp4';
      if (body.filename) {
        const parsed = path.extname(body.filename).toLowerCase();
        // Remove the leading dot and validate it's a safe extension
        if (parsed && /^\.[a-z0-9]+$/.test(parsed)) {
          ext = parsed.slice(1);
        }
      }

      const s3Key = `uploads/${uploadId}.${ext}`;
      const config = getConfig();
      const expiresIn = body.expiresIn ?? config.upload.presignExpirationSeconds;
      const result = await storageService.getPresignedUploadUrl(s3Key, body.contentType, expiresIn);

      return reply.send({
        ...result,
        expiresIn,
      });
    }
  );
}

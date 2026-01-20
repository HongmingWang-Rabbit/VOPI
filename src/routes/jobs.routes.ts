import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { jobsController } from '../controllers/jobs.controller.js';
import { createJobSchema, jobListQuerySchema } from '../types/job.types.js';
import { storageService } from '../services/storage.service.js';
import { z } from 'zod';

const jobIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const presignBodySchema = z.object({
  filename: z.string().max(255).optional(),
  contentType: z.enum(['video/mp4', 'video/quicktime', 'video/webm']).default('video/mp4'),
  expiresIn: z.number().int().min(60).max(86400).optional(), // 1 minute to 24 hours
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
      const job = await jobsController.createJob(validated, request.apiKey);
      return reply.status(201).send(job);
    }
  );

  /**
   * List jobs
   */
  fastify.get(
    '/jobs',
    {
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
      const result = await jobsController.listJobs(query);
      return reply.send(result);
    }
  );

  /**
   * Get job by ID
   */
  fastify.get(
    '/jobs/:id',
    {
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
      const job = await jobsController.getJob(id);
      return reply.send(job);
    }
  );

  /**
   * Get job status (lightweight)
   */
  fastify.get(
    '/jobs/:id/status',
    {
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
      const status = await jobsController.getJobStatus(id);
      return reply.send(status);
    }
  );

  /**
   * Cancel a job
   */
  fastify.delete(
    '/jobs/:id',
    {
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
      const job = await jobsController.cancelJob(id);
      return reply.send({
        id: job.id,
        status: job.status,
        message: 'Job cancelled successfully',
      });
    }
  );

  /**
   * Get presigned URL for video upload
   */
  fastify.post(
    '/uploads/presign',
    {
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
      const expiresIn = body.expiresIn ?? 3600; // Default 1 hour
      const result = await storageService.getPresignedUploadUrl(s3Key, body.contentType, expiresIn);

      return reply.send({
        ...result,
        expiresIn,
      });
    }
  );
}

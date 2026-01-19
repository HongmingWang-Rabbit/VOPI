import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { jobsController } from '../controllers/jobs.controller.js';
import { createJobSchema, jobListQuerySchema } from '../types/job.types.js';
import { z } from 'zod';

const jobIdParamsSchema = z.object({
  id: z.string().uuid(),
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
      const job = await jobsController.createJob(validated);
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
}

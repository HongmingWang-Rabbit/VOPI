import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { framesController } from '../controllers/frames.controller.js';
import { z } from 'zod';

const jobIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Frames routes
 */
export async function framesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Get video metadata for a job
   */
  fastify.get(
    '/jobs/:id/video',
    {
      schema: {
        description: 'Get video metadata for a job',
        tags: ['Frames'],
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
              jobId: { type: 'string' },
              sourceUrl: { type: 'string' },
              duration: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              fps: { type: 'number' },
              codec: { type: 'string' },
              metadata: { type: 'object' },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const video = await framesController.getVideo(id);
      return reply.send(video);
    }
  );

  /**
   * Get all frames for a job
   */
  fastify.get(
    '/jobs/:id/frames',
    {
      schema: {
        description: 'Get all extracted frames for a job',
        tags: ['Frames'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                jobId: { type: 'string' },
                videoId: { type: 'string' },
                frameId: { type: 'string' },
                timestamp: { type: 'number' },
                s3Url: { type: 'string' },
                scores: { type: 'object' },
                productId: { type: 'string' },
                variantId: { type: 'string' },
                angleEstimate: { type: 'string' },
                isBestPerSecond: { type: 'boolean' },
                isFinalSelection: { type: 'boolean' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const frames = await framesController.getFrames(id);
      return reply.send(frames);
    }
  );

  /**
   * Get final selected frames for a job
   */
  fastify.get(
    '/jobs/:id/frames/final',
    {
      schema: {
        description: 'Get final selected frames for a job',
        tags: ['Frames'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                jobId: { type: 'string' },
                frameId: { type: 'string' },
                timestamp: { type: 'number' },
                s3Url: { type: 'string' },
                productId: { type: 'string' },
                variantId: { type: 'string' },
                angleEstimate: { type: 'string' },
                variantDescription: { type: 'string' },
                obstructions: { type: 'object' },
                backgroundRecommendations: { type: 'object' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const frames = await framesController.getFinalFrames(id);
      return reply.send(frames);
    }
  );

  /**
   * Get all commercial images for a job
   */
  fastify.get(
    '/jobs/:id/images',
    {
      schema: {
        description: 'Get all commercial images for a job',
        tags: ['Frames'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                jobId: { type: 'string' },
                frameId: { type: 'string' },
                version: { type: 'string' },
                s3Url: { type: 'string' },
                backgroundColor: { type: 'string' },
                backgroundPrompt: { type: 'string' },
                success: { type: 'boolean' },
                error: { type: 'string' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const images = await framesController.getCommercialImages(id);
      return reply.send(images);
    }
  );

  /**
   * Get commercial images grouped by variant
   */
  fastify.get(
    '/jobs/:id/images/grouped',
    {
      schema: {
        description: 'Get commercial images grouped by product variant',
        tags: ['Frames'],
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
            additionalProperties: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = jobIdParamsSchema.parse(request.params);
      const images = await framesController.getCommercialImagesByVariant(id);
      return reply.send(images);
    }
  );
}

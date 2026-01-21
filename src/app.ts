import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { getConfig } from './config/index.js';
import { getLogger } from './utils/logger.js';
import { errorHandler } from './middleware/error.middleware.js';
import { authMiddleware, shouldSkipAuth } from './middleware/auth.middleware.js';
import { healthRoutes } from './routes/health.routes.js';
import { jobsRoutes } from './routes/jobs.routes.js';
import { framesRoutes } from './routes/frames.routes.js';
import { configRoutes } from './routes/config.routes.js';
import { setupDefaultProviders } from './providers/setup.js';

/**
 * Build and configure Fastify application
 */
export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig();
  const logger = getLogger();

  // Initialize providers
  setupDefaultProviders();

  const app = Fastify({
    logger: false, // We use our own Pino logger
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
  });

  // Security plugins
  await app.register(helmet, {
    contentSecurityPolicy: false, // Disable for API
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g., mobile apps, curl)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Check against configured allowed domains
      const isAllowed = config.cors.allowedDomains.some((domain) => {
        const pattern = new RegExp(`^https?:\\/\\/([a-z0-9-]+\\.)*${domain}$`);
        return pattern.test(origin);
      });

      if (isAllowed) {
        callback(null, true);
        return;
      }

      // In development, also allow localhost
      if (config.server.env === 'development') {
        const localhostPattern = /^https?:\/\/localhost(:\d+)?$/;
        if (localhostPattern.test(origin)) {
          callback(null, true);
          return;
        }
      }

      callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });

  // Swagger documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'VOPI API',
        description: 'Video Object Processing Infrastructure API',
        version: '2.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.server.port}`,
          description: 'Development server',
        },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'x-api-key',
            in: 'header',
          },
        },
      },
      security: [{ apiKey: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });

  // Request logging
  app.addHook('onRequest', async (request) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
      },
      'Incoming request'
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed'
    );
  });

  // Auth middleware (skip for health routes)
  app.addHook('preHandler', async (request, reply) => {
    if (shouldSkipAuth(request.url)) {
      return;
    }
    await authMiddleware(request, reply);
  });

  // Error handler
  app.setErrorHandler(errorHandler);

  // Register routes
  await app.register(healthRoutes);
  await app.register(jobsRoutes, { prefix: '/api/v1' });
  await app.register(framesRoutes, { prefix: '/api/v1' });
  await app.register(configRoutes, { prefix: '/api/v1' });

  return app;
}

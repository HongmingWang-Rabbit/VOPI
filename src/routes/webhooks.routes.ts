import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { shopifyOAuthService } from '../services/oauth/shopify-oauth.service.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger().child({ service: 'shopify-webhooks' });

interface WebhookRequest extends FastifyRequest {
  rawBody: Buffer;
}

function verifyShopifyHmac(request: WebhookRequest): boolean {
  const hmac = request.headers['x-shopify-hmac-sha256'];
  if (!hmac || typeof hmac !== 'string') {
    return false;
  }

  try {
    return shopifyOAuthService.verifyWebhookHmac(request.rawBody, hmac);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Shopify webhook HMAC verification error (is Shopify OAuth configured?)');
    throw err;
  }
}

const webhookBodySchema = {
  type: 'object',
  additionalProperties: true,
} as const;

function shopifyWebhookHandler(topic: string, logMessage: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyShopifyHmac(request as WebhookRequest)) {
      return reply.status(401).send({ error: 'Invalid HMAC signature' });
    }
    logger.info({ topic }, logMessage);
    return reply.status(200).send({ received: true });
  };
}

export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  const schema = { body: webhookBodySchema };

  app.post('/webhooks/shopify/customers/data_request', { schema },
    shopifyWebhookHandler('customers/data_request', 'Shopify customer data request received (no customer data stored)'),
  );

  app.post('/webhooks/shopify/customers/redact', { schema },
    shopifyWebhookHandler('customers/redact', 'Shopify customer redact received (no customer data stored)'),
  );

  app.post('/webhooks/shopify/shop/redact', { schema },
    shopifyWebhookHandler('shop/redact', 'Shopify shop redact received (no shop data stored beyond OAuth tokens)'),
  );
}

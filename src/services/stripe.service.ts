import Stripe from 'stripe';
import { eq, sql, and } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { getLogger } from '../utils/logger.js';
import { creditsService } from './credits.service.js';
import {
  CreditPacks,
  type CreditPackType,
  type CheckoutSessionResponse,
} from '../types/credits.types.js';

const logger = getLogger().child({ service: 'stripe' });

/**
 * Price ID to pack type mappings (cached for efficiency)
 */
class PricePackMapper {
  private priceToPackCache: Map<string, CreditPackType> | null = null;
  private packToPriceCache: Map<CreditPackType, string | undefined> | null = null;

  /**
   * Get pack type for a Stripe price ID
   */
  getPackType(priceId: string): CreditPackType | undefined {
    const map = this.getPriceToPackMap();
    return map.get(priceId);
  }

  /**
   * Get Stripe price ID for a pack type
   */
  getPriceId(packType: CreditPackType): string | undefined {
    const map = this.getPackToPriceMap();
    return map.get(packType);
  }

  /**
   * Build reverse mapping from price IDs to pack types
   */
  private getPriceToPackMap(): Map<string, CreditPackType> {
    if (this.priceToPackCache) return this.priceToPackCache;

    const config = getConfig();
    const map = new Map<string, CreditPackType>();

    if (config.stripe.priceIds.credit1) map.set(config.stripe.priceIds.credit1, 'CREDIT_1');
    if (config.stripe.priceIds.pack20) map.set(config.stripe.priceIds.pack20, 'PACK_20');
    if (config.stripe.priceIds.pack100) map.set(config.stripe.priceIds.pack100, 'PACK_100');
    if (config.stripe.priceIds.pack500) map.set(config.stripe.priceIds.pack500, 'PACK_500');

    this.priceToPackCache = map;
    return map;
  }

  /**
   * Build mapping from pack types to price IDs
   */
  private getPackToPriceMap(): Map<CreditPackType, string | undefined> {
    if (this.packToPriceCache) return this.packToPriceCache;

    const config = getConfig();
    const map = new Map<CreditPackType, string | undefined>();

    map.set('CREDIT_1', config.stripe.priceIds.credit1);
    map.set('PACK_20', config.stripe.priceIds.pack20);
    map.set('PACK_100', config.stripe.priceIds.pack100);
    map.set('PACK_500', config.stripe.priceIds.pack500);

    this.packToPriceCache = map;
    return map;
  }

  /**
   * Clear cached mappings (useful for testing)
   */
  clearCache(): void {
    this.priceToPackCache = null;
    this.packToPriceCache = null;
  }
}

const pricePackMapper = new PricePackMapper();

/**
 * Stripe service - handles Stripe checkout and webhooks
 */
class StripeService {
  private stripe: Stripe | null = null;

  /**
   * Get Stripe client (lazy initialization)
   */
  private getStripeClient(): Stripe {
    if (!this.stripe) {
      const config = getConfig();
      if (!config.stripe.secretKey) {
        throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
      }
      this.stripe = new Stripe(config.stripe.secretKey);
    }
    return this.stripe;
  }

  /**
   * Check if Stripe is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!(
      config.stripe.secretKey &&
      config.stripe.webhookSecret &&
      (config.stripe.priceIds.credit1 ||
        config.stripe.priceIds.pack20 ||
        config.stripe.priceIds.pack100 ||
        config.stripe.priceIds.pack500)
    );
  }

  /**
   * Get or create a Stripe customer for a user
   *
   * Uses optimistic approach to minimize database lock time:
   * 1. Check if customer exists (no lock)
   * 2. If not, create in Stripe (external call, no lock held)
   * 3. Use atomic conditional update to save (handles race conditions)
   *
   * This prevents holding DB locks during external API calls.
   */
  async getOrCreateCustomer(userId: string, email: string): Promise<string> {
    const db = getDatabase();
    const stripe = this.getStripeClient();

    // Step 1: Quick check without locking
    const [user] = await db
      .select({ id: schema.users.id, stripeCustomerId: schema.users.stripeCustomerId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    // If customer already exists, return it
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    // Step 2: Create Stripe customer (outside any transaction)
    const customer = await stripe.customers.create({
      email,
      metadata: {
        userId,
      },
    });

    // Step 3: Atomic conditional update - only update if still null
    // This handles race conditions: if another request created a customer
    // between our check and now, we'll get 0 rows updated
    const [updated] = await db
      .update(schema.users)
      .set({
        stripeCustomerId: customer.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.users.id, userId),
          sql`${schema.users.stripeCustomerId} IS NULL`
        )
      )
      .returning({ stripeCustomerId: schema.users.stripeCustomerId });

    if (updated) {
      // We won the race - our customer ID was saved
      logger.info({ userId, customerId: customer.id }, 'Created Stripe customer');
      return customer.id;
    }

    // Another request created a customer first - fetch the winning ID
    // We have an orphaned Stripe customer, but this is rare and acceptable
    // (Stripe customers are free, unused ones can be cleaned up periodically)
    logger.warn(
      { userId, orphanedCustomerId: customer.id },
      'Race condition: another request created Stripe customer first, orphaned customer created'
    );

    const [finalUser] = await db
      .select({ stripeCustomerId: schema.users.stripeCustomerId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!finalUser?.stripeCustomerId) {
      // This shouldn't happen - something is very wrong
      throw new Error('Failed to get or create Stripe customer');
    }

    return finalUser.stripeCustomerId;
  }

  /**
   * Create a Stripe Checkout session for credit purchase
   */
  async createCheckoutSession(
    userId: string,
    email: string,
    packType: CreditPackType,
    successUrl: string,
    cancelUrl: string
  ): Promise<CheckoutSessionResponse> {
    const stripe = this.getStripeClient();
    const priceId = pricePackMapper.getPriceId(packType);

    if (!priceId) {
      throw new Error(`No price ID configured for pack type: ${packType}`);
    }

    // Get or create Stripe customer
    const customerId = await this.getOrCreateCustomer(userId, email);

    // Create checkout session
    const pack = CreditPacks[packType];
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId,
        packType,
        credits: String(pack.credits),
        priceUsd: String(pack.priceUsd),
      },
      client_reference_id: userId,
      // Add metadata to payment intent for better traceability
      payment_intent_data: {
        metadata: {
          userId,
          packType,
          credits: String(pack.credits),
        },
      },
    });

    // Validate session URL exists
    if (!session.url) {
      logger.error({ sessionId: session.id }, 'Stripe returned session without URL');
      throw new Error('Failed to create checkout session: no URL returned');
    }

    logger.info(
      { userId, packType, sessionId: session.id },
      'Created Stripe checkout session'
    );

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: Buffer, signature: string): Stripe.Event {
    const config = getConfig();
    const stripe = this.getStripeClient();

    if (!config.stripe.webhookSecret) {
      throw new Error('Stripe webhook secret not configured');
    }

    return stripe.webhooks.constructEvent(
      payload,
      signature,
      config.stripe.webhookSecret
    );
  }

  /**
   * Check if a Stripe event has already been processed
   */
  async isEventProcessed(eventId: string): Promise<boolean> {
    const db = getDatabase();

    const [existing] = await db
      .select({ processed: schema.stripeEvents.processed })
      .from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.eventId, eventId))
      .limit(1);

    return existing?.processed ?? false;
  }

  /**
   * Record a Stripe event (for idempotency)
   */
  async recordEvent(
    eventId: string,
    eventType: string,
    processed: boolean,
    error?: string
  ): Promise<void> {
    const db = getDatabase();

    await db
      .insert(schema.stripeEvents)
      .values({
        eventId,
        eventType,
        processed,
        processedAt: processed ? new Date() : null,
        error,
      })
      .onConflictDoUpdate({
        target: schema.stripeEvents.eventId,
        set: {
          processed,
          processedAt: processed ? new Date() : null,
          error,
        },
      });
  }

  /**
   * Process a Stripe webhook event
   */
  async processWebhookEvent(event: Stripe.Event): Promise<void> {
    // Check if already processed
    if (await this.isEventProcessed(event.id)) {
      logger.info({ eventId: event.id }, 'Stripe event already processed');
      return;
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(event);
          break;

        default:
          logger.debug({ eventType: event.type }, 'Ignoring unhandled Stripe event type');
      }

      // Mark event as processed
      await this.recordEvent(event.id, event.type, true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.recordEvent(event.id, event.type, false, errorMessage);
      throw error;
    }
  }

  /**
   * Handle checkout.session.completed event
   */
  private async handleCheckoutCompleted(event: Stripe.Event): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;

    const userId = session.metadata?.userId || session.client_reference_id;
    const packType = session.metadata?.packType as CreditPackType | undefined;

    if (!userId) {
      logger.error({ sessionId: session.id }, 'Checkout session missing userId');
      throw new Error('Checkout session missing userId metadata');
    }

    // Resolve pack type using helper
    const resolvedPackType = await this.resolvePackTypeFromSession(session, packType);

    if (!resolvedPackType) {
      logger.error({ sessionId: session.id }, 'Could not determine pack type from checkout session');
      throw new Error('Could not determine pack type');
    }

    // Add credits to user
    const result = await creditsService.addPurchasedCredits(
      userId,
      resolvedPackType,
      event.id,
      session.payment_intent as string | undefined,
      session.id
    );

    logger.info(
      {
        userId,
        packType: resolvedPackType,
        sessionId: session.id,
        newBalance: result.newBalance,
      },
      'Checkout completed and credits added'
    );
  }

  /**
   * Resolve pack type from checkout session
   * Tries metadata first, then line items, then fetches line items if needed
   */
  private async resolvePackTypeFromSession(
    session: Stripe.Checkout.Session,
    metadataPackType?: CreditPackType
  ): Promise<CreditPackType | undefined> {
    // First try metadata
    if (metadataPackType) {
      return metadataPackType;
    }

    // Try expanded line items
    if (session.line_items?.data[0]?.price?.id) {
      const packType = pricePackMapper.getPackType(session.line_items.data[0].price.id);
      if (packType) return packType;
    }

    // Fetch line items from Stripe
    try {
      const stripe = this.getStripeClient();
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
      if (lineItems.data[0]?.price?.id) {
        return pricePackMapper.getPackType(lineItems.data[0].price.id);
      }
    } catch (error) {
      logger.warn({ sessionId: session.id, error }, 'Failed to fetch line items');
    }

    return undefined;
  }

  /**
   * Get available packs with their Stripe price IDs
   */
  getAvailablePacks(): Array<{
    packType: CreditPackType;
    credits: number;
    priceUsd: number;
    name: string;
    stripePriceId?: string;
    available: boolean;
  }> {
    const packs = Object.entries(CreditPacks).map(([key, pack]) => {
      const priceId = pricePackMapper.getPriceId(key as CreditPackType);
      return {
        packType: key as CreditPackType,
        credits: pack.credits,
        priceUsd: pack.priceUsd,
        name: pack.name,
        stripePriceId: priceId,
        available: !!priceId,
      };
    });

    return packs;
  }
}

export const stripeService = new StripeService();

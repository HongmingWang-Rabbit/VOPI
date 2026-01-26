import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// Use vi.hoisted to create mock functions that can be used in vi.mock
const {
  mockGetConfig,
  mockDbSelect,
  mockDbUpdate,
  mockDbInsert,
  mockDbTransaction,
  mockAddPurchasedCredits,
  mockStripeCustomersCreate,
  mockStripeCheckoutSessionsCreate,
  mockStripeCheckoutSessionsListLineItems,
  mockStripeWebhooksConstructEvent,
} = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockAddPurchasedCredits: vi.fn(),
  mockStripeCustomersCreate: vi.fn(),
  mockStripeCheckoutSessionsCreate: vi.fn(),
  mockStripeCheckoutSessionsListLineItems: vi.fn(),
  mockStripeWebhooksConstructEvent: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockLogger.child = vi.fn(() => mockLogger);
  return {
    createChildLogger: vi.fn(() => mockLogger),
    getLogger: vi.fn(() => mockLogger),
  };
});

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: mockGetConfig,
}));

// Mock database
vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn(() => ({
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: mockDbInsert,
    transaction: mockDbTransaction,
  })),
  schema: {
    users: {
      id: 'id',
      stripeCustomerId: 'stripe_customer_id',
      updatedAt: 'updated_at',
    },
    stripeEvents: {
      eventId: 'event_id',
      eventType: 'event_type',
      processed: 'processed',
      processedAt: 'processed_at',
      error: 'error',
    },
  },
}));

// Mock credits service
vi.mock('./credits.service.js', () => ({
  creditsService: {
    addPurchasedCredits: mockAddPurchasedCredits,
  },
}));

// Mock Stripe as a class constructor using class syntax
vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      customers = {
        create: mockStripeCustomersCreate,
      };
      checkout = {
        sessions: {
          create: mockStripeCheckoutSessionsCreate,
          listLineItems: mockStripeCheckoutSessionsListLineItems,
        },
      };
      webhooks = {
        constructEvent: mockStripeWebhooksConstructEvent,
      };
    },
  };
});

// Import after mocks
import { stripeService } from './stripe.service.js';

describe('StripeService', () => {
  const mockUserId = 'user-123';
  const mockEmail = 'test@example.com';
  const mockCustomerId = 'cus_123456';

  const defaultConfig = {
    stripe: {
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_123',
      priceIds: {
        credit1: 'price_credit1',
        pack20: 'price_pack20',
        pack100: 'price_pack100',
        pack500: 'price_pack500',
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(defaultConfig);
  });

  describe('isConfigured', () => {
    it('should return true when all required config is present', () => {
      expect(stripeService.isConfigured()).toBe(true);
    });

    it('should return false when secretKey is missing', () => {
      mockGetConfig.mockReturnValue({
        stripe: {
          secretKey: '',
          webhookSecret: 'whsec_123',
          priceIds: { pack20: 'price_pack20' },
        },
      });

      expect(stripeService.isConfigured()).toBe(false);
    });

    it('should return false when webhookSecret is missing', () => {
      mockGetConfig.mockReturnValue({
        stripe: {
          secretKey: 'sk_test_123',
          webhookSecret: '',
          priceIds: { pack20: 'price_pack20' },
        },
      });

      expect(stripeService.isConfigured()).toBe(false);
    });

    it('should return false when no price IDs are configured', () => {
      mockGetConfig.mockReturnValue({
        stripe: {
          secretKey: 'sk_test_123',
          webhookSecret: 'whsec_123',
          priceIds: {},
        },
      });

      expect(stripeService.isConfigured()).toBe(false);
    });

    it('should return true with only one price ID configured', () => {
      mockGetConfig.mockReturnValue({
        stripe: {
          secretKey: 'sk_test_123',
          webhookSecret: 'whsec_123',
          priceIds: { pack100: 'price_pack100' },
        },
      });

      expect(stripeService.isConfigured()).toBe(true);
    });
  });

  describe('getOrCreateCustomer', () => {
    // Helper to setup select mock for checking existing customer
    const setupSelectMock = (userResult: { id: string; stripeCustomerId: string | null } | undefined) => {
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(userResult ? [userResult] : []),
          }),
        }),
      });
    };

    // Helper to setup update mock for conditional update
    const setupUpdateMock = (updatedResult: { stripeCustomerId: string } | undefined) => {
      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(updatedResult ? [updatedResult] : []),
          }),
        }),
      });
    };

    it('should return existing customer ID if present', async () => {
      setupSelectMock({ id: mockUserId, stripeCustomerId: mockCustomerId });

      const result = await stripeService.getOrCreateCustomer(mockUserId, mockEmail);

      expect(result).toBe(mockCustomerId);
      expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
    });

    it('should create new customer if none exists', async () => {
      // First select returns user without customer ID
      setupSelectMock({ id: mockUserId, stripeCustomerId: null });
      setupUpdateMock({ stripeCustomerId: mockCustomerId });

      mockStripeCustomersCreate.mockResolvedValue({ id: mockCustomerId });

      const result = await stripeService.getOrCreateCustomer(mockUserId, mockEmail);

      expect(result).toBe(mockCustomerId);
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: mockEmail,
        metadata: { userId: mockUserId },
      });
    });

    it('should throw error if user not found', async () => {
      setupSelectMock(undefined);

      await expect(
        stripeService.getOrCreateCustomer(mockUserId, mockEmail)
      ).rejects.toThrow(`User ${mockUserId} not found`);
    });

    it('should handle race condition gracefully when another request creates customer first', async () => {
      const otherCustomerId = 'cus_other';
      let selectCallCount = 0;

      // First select returns user without customer ID
      // Third select (after race condition) returns the winning customer ID
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1) {
                return Promise.resolve([{ id: mockUserId, stripeCustomerId: null }]);
              }
              return Promise.resolve([{ stripeCustomerId: otherCustomerId }]);
            }),
          }),
        }),
      });

      // Update returns empty (another request won the race)
      setupUpdateMock(undefined);

      mockStripeCustomersCreate.mockResolvedValue({ id: mockCustomerId });

      const result = await stripeService.getOrCreateCustomer(mockUserId, mockEmail);

      // Should return the winning customer ID
      expect(result).toBe(otherCustomerId);
      expect(mockStripeCustomersCreate).toHaveBeenCalled();
    });
  });

  describe('createCheckoutSession', () => {
    beforeEach(() => {
      // Setup default mocks for customer lookup (existing customer)
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: mockUserId, stripeCustomerId: mockCustomerId }]),
          }),
        }),
      });
    });

    it('should create checkout session successfully', async () => {
      const mockSession = {
        id: 'cs_123',
        url: 'https://checkout.stripe.com/session123',
      };

      mockStripeCheckoutSessionsCreate.mockResolvedValue(mockSession);

      const result = await stripeService.createCheckoutSession(
        mockUserId,
        mockEmail,
        'PACK_20',
        'https://example.com/success',
        'https://example.com/cancel'
      );

      expect(result).toEqual({
        checkoutUrl: mockSession.url,
        sessionId: mockSession.id,
      });

      expect(mockStripeCheckoutSessionsCreate).toHaveBeenCalledWith({
        customer: mockCustomerId,
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [{ price: 'price_pack20', quantity: 1 }],
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
        metadata: {
          userId: mockUserId,
          packType: 'PACK_20',
          credits: '20',
          priceUsd: '14.99',
        },
        client_reference_id: mockUserId,
        payment_intent_data: {
          metadata: {
            userId: mockUserId,
            packType: 'PACK_20',
            credits: '20',
          },
        },
      });
    });

    it('should throw error when session URL is missing', async () => {
      mockStripeCheckoutSessionsCreate.mockResolvedValue({
        id: 'cs_123',
        url: null, // No URL
      });

      await expect(
        stripeService.createCheckoutSession(
          mockUserId,
          mockEmail,
          'PACK_20',
          'https://example.com/success',
          'https://example.com/cancel'
        )
      ).rejects.toThrow('Failed to create checkout session: no URL returned');
    });
  });

  describe('verifyWebhookSignature', () => {
    it('should verify signature successfully', () => {
      const mockEvent = { id: 'evt_123', type: 'checkout.session.completed' };
      mockStripeWebhooksConstructEvent.mockReturnValue(mockEvent);

      const payload = Buffer.from('test payload');
      const signature = 'test_signature';

      const result = stripeService.verifyWebhookSignature(payload, signature);

      expect(result).toEqual(mockEvent);
      expect(mockStripeWebhooksConstructEvent).toHaveBeenCalledWith(
        payload,
        signature,
        'whsec_123'
      );
    });

    it('should throw error when webhook secret not configured', () => {
      mockGetConfig.mockReturnValue({
        stripe: {
          secretKey: 'sk_test_123',
          webhookSecret: '', // No webhook secret
          priceIds: { pack20: 'price_pack20' },
        },
      });

      expect(() =>
        stripeService.verifyWebhookSignature(Buffer.from('test'), 'sig')
      ).toThrow('Stripe webhook secret not configured');
    });
  });

  describe('isEventProcessed', () => {
    it('should return true for processed event', async () => {
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ processed: true }]),
          }),
        }),
      });

      const result = await stripeService.isEventProcessed('evt_123');

      expect(result).toBe(true);
    });

    it('should return false for unprocessed event', async () => {
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ processed: false }]),
          }),
        }),
      });

      const result = await stripeService.isEventProcessed('evt_123');

      expect(result).toBe(false);
    });

    it('should return false for non-existent event', async () => {
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await stripeService.isEventProcessed('evt_123');

      expect(result).toBe(false);
    });
  });

  describe('recordEvent', () => {
    it('should record event with upsert', async () => {
      const mockOnConflict = vi.fn().mockResolvedValue(undefined);
      mockDbInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: mockOnConflict,
        }),
      });

      await stripeService.recordEvent('evt_123', 'checkout.session.completed', true);

      expect(mockDbInsert).toHaveBeenCalled();
      expect(mockOnConflict).toHaveBeenCalled();
    });

    it('should record event with error', async () => {
      const mockOnConflict = vi.fn().mockResolvedValue(undefined);
      mockDbInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: mockOnConflict,
        }),
      });

      await stripeService.recordEvent('evt_123', 'checkout.session.completed', false, 'Some error');

      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe('processWebhookEvent', () => {
    const createMockEvent = (type: string, sessionData: Partial<Stripe.Checkout.Session> = {}): Stripe.Event => ({
      id: 'evt_123',
      type,
      data: {
        object: {
          id: 'cs_123',
          metadata: { userId: mockUserId, packType: 'PACK_20' },
          payment_intent: 'pi_123',
          ...sessionData,
        } as Stripe.Checkout.Session,
      },
      object: 'event',
      api_version: '2023-10-16',
      created: Date.now(),
      livemode: false,
      pending_webhooks: 0,
      request: null,
    } as Stripe.Event);

    beforeEach(() => {
      // Default: event not processed
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      // Default: record event succeeds
      mockDbInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Default: add credits succeeds
      mockAddPurchasedCredits.mockResolvedValue({
        success: true,
        newBalance: 25,
        transactionId: 'txn_123',
      });
    });

    it('should skip already processed events (idempotency)', async () => {
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ processed: true }]),
          }),
        }),
      });

      const event = createMockEvent('checkout.session.completed');

      await stripeService.processWebhookEvent(event);

      expect(mockAddPurchasedCredits).not.toHaveBeenCalled();
    });

    it('should process checkout.session.completed and add credits', async () => {
      const event = createMockEvent('checkout.session.completed');

      await stripeService.processWebhookEvent(event);

      expect(mockAddPurchasedCredits).toHaveBeenCalledWith(
        mockUserId,
        'PACK_20',
        'evt_123',
        'pi_123',
        'cs_123'
      );
    });

    it('should use client_reference_id if metadata.userId is missing', async () => {
      const event = createMockEvent('checkout.session.completed', {
        metadata: { packType: 'PACK_20' },
        client_reference_id: 'user-fallback',
      });

      await stripeService.processWebhookEvent(event);

      expect(mockAddPurchasedCredits).toHaveBeenCalledWith(
        'user-fallback',
        'PACK_20',
        'evt_123',
        'pi_123',
        'cs_123'
      );
    });

    it('should throw error when userId is missing from session', async () => {
      const event = createMockEvent('checkout.session.completed', {
        metadata: { packType: 'PACK_20' },
        client_reference_id: null,
      });

      await expect(stripeService.processWebhookEvent(event)).rejects.toThrow(
        'Checkout session missing userId metadata'
      );
    });

    it('should resolve pack type from line items when metadata is missing', async () => {
      const event = createMockEvent('checkout.session.completed', {
        metadata: { userId: mockUserId }, // No packType
        line_items: {
          data: [{ price: { id: 'price_pack100' } }],
        } as unknown as Stripe.ApiList<Stripe.LineItem>,
      });

      await stripeService.processWebhookEvent(event);

      expect(mockAddPurchasedCredits).toHaveBeenCalledWith(
        mockUserId,
        'PACK_100',
        'evt_123',
        'pi_123',
        'cs_123'
      );
    });

    it('should fetch line items from Stripe when not expanded', async () => {
      mockStripeCheckoutSessionsListLineItems.mockResolvedValue({
        data: [{ price: { id: 'price_pack500' } }],
      });

      const event = createMockEvent('checkout.session.completed', {
        metadata: { userId: mockUserId }, // No packType
        line_items: undefined, // Not expanded
      });

      await stripeService.processWebhookEvent(event);

      expect(mockStripeCheckoutSessionsListLineItems).toHaveBeenCalledWith('cs_123');
      expect(mockAddPurchasedCredits).toHaveBeenCalledWith(
        mockUserId,
        'PACK_500',
        'evt_123',
        'pi_123',
        'cs_123'
      );
    });

    it('should throw error when pack type cannot be resolved', async () => {
      mockStripeCheckoutSessionsListLineItems.mockResolvedValue({
        data: [],
      });

      const event = createMockEvent('checkout.session.completed', {
        metadata: { userId: mockUserId }, // No packType
        line_items: undefined,
      });

      await expect(stripeService.processWebhookEvent(event)).rejects.toThrow(
        'Could not determine pack type'
      );
    });

    it('should ignore unhandled event types', async () => {
      const event = createMockEvent('customer.created');

      await stripeService.processWebhookEvent(event);

      expect(mockAddPurchasedCredits).not.toHaveBeenCalled();
      // Should still record the event
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should record error when processing fails', async () => {
      mockAddPurchasedCredits.mockRejectedValue(new Error('Database error'));

      const event = createMockEvent('checkout.session.completed');

      await expect(stripeService.processWebhookEvent(event)).rejects.toThrow('Database error');

      // Verify error was recorded (insert called twice - once for error)
      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe('getAvailablePacks', () => {
    it('should return all packs with availability status', () => {
      const packs = stripeService.getAvailablePacks();

      expect(packs).toHaveLength(4);

      const pack20 = packs.find(p => p.packType === 'PACK_20');
      expect(pack20).toBeDefined();
      expect(pack20?.credits).toBe(20);
      expect(pack20?.priceUsd).toBe(14.99);
      expect(pack20?.name).toBe('20 Credit Pack');
      expect(pack20?.stripePriceId).toBe('price_pack20');
      expect(pack20?.available).toBe(true);
    });
  });
});

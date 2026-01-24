import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Mock global-config.service before it gets loaded
vi.mock('./global-config.service.js', () => ({
  globalConfigService: {
    getPricingConfig: vi.fn().mockResolvedValue({
      baseCredits: 1,
      creditsPerSecond: 0.05,
      includedFrames: 4,
      extraFrameCost: 0.25,
      commercialVideoEnabled: false,
      commercialVideoCost: 2,
      minJobCost: 1,
      maxJobCost: 0,
    }),
  },
}));

// Mock chain for database queries
const createChainMock = () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = [
    'insert', 'values', 'returning', 'select', 'from', 'where', 'orderBy',
    'limit', 'offset', 'update', 'set', 'delete', 'onConflictDoUpdate',
    'transaction', 'execute'
  ];

  methods.forEach(method => {
    chain[method] = vi.fn().mockReturnValue(chain);
  });

  // Make transaction pass through the callback and return its result
  chain.transaction = vi.fn().mockImplementation(async (callback) => {
    return callback(chain);
  });

  // Default execute to return empty rows (for raw SQL queries like FOR UPDATE)
  chain.execute = vi.fn().mockResolvedValue({ rows: [] });

  return chain;
};

const mockDb = createChainMock();

vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn(() => mockDb),
  schema: {
    users: {
      id: 'id',
      email: 'email',
      creditsBalance: 'credits_balance',
      updatedAt: 'updated_at',
    },
    creditTransactions: {
      id: 'id',
      userId: 'user_id',
      creditsDelta: 'credits_delta',
      type: 'type',
      idempotencyKey: 'idempotency_key',
      description: 'description',
      createdAt: 'created_at',
      jobId: 'job_id',
    },
    signupGrants: {
      id: 'id',
      userId: 'user_id',
      ipAddress: 'ip_address',
      deviceFingerprint: 'device_fingerprint',
      email: 'email',
    },
    jobs: {
      id: 'id',
    },
  },
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    abusePrevention: {
      signupGrantIpLimit: 3,
      signupGrantDeviceLimit: 2,
    },
  })),
}));

// Import after mocks
import { creditsService } from './credits.service.js';
import { SIGNUP_GRANT_CREDITS, MAX_VIDEO_DURATION_SECONDS } from '../types/credits.types.js';

describe('CreditsService', () => {
  const mockUserId = 'user-123';
  const mockEmail = 'test@example.com';

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock chains
    Object.keys(mockDb).forEach(key => {
      if (key !== 'transaction') {
        mockDb[key].mockReturnValue(mockDb);
      }
    });

    // Ensure transaction passes through
    mockDb.transaction.mockImplementation(async (callback) => {
      return callback(mockDb);
    });
  });

  describe('getBalance', () => {
    it('should return user balance', async () => {
      mockDb.limit.mockResolvedValue([{ balance: 25 }]);

      const result = await creditsService.getBalance(mockUserId);

      expect(result).toBe(25);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it('should throw when user not found', async () => {
      mockDb.limit.mockResolvedValue([]);

      await expect(creditsService.getBalance(mockUserId)).rejects.toThrow(`User ${mockUserId} not found`);
    });
  });

  describe('grantSignupCredits', () => {
    it('should grant exactly 5 credits on first call', async () => {
      // Flow:
      // 1. hasReceivedSignupGrant: select().from().where().limit() -> false
      // 2. checkSignupAbuse: select({count}).from().where() -> under limit
      // 3. Transaction:
      //    - Double-check: select().from().where().limit() -> false
      //    - Insert transaction
      //    - Update balance
      //    - getBalance: select().from().where().limit() -> new balance
      let limitCallCount = 0;
      let whereCallCount = 0;

      mockDb.limit.mockImplementation(() => {
        limitCallCount++;
        if (limitCallCount <= 2) {
          return Promise.resolve([]); // No existing grant (initial + transaction recheck)
        }
        return Promise.resolve([{ balance: SIGNUP_GRANT_CREDITS }]); // Final balance
      });

      // hasReceivedSignupGrant (1st where) needs chain for limit
      // checkSignupAbuse (2nd where) ends with where, returns count directly
      // Transaction recheck (3rd where) needs chain for limit
      // getBalance (4th where) needs chain for limit
      mockDb.where.mockImplementation(() => {
        whereCallCount++;
        // 2nd where is checkSignupAbuse count query - resolve directly
        if (whereCallCount === 2) {
          return Promise.resolve([{ count: 1 }]); // Under limit
        }
        return mockDb; // Others chain to limit
      });

      // Insert returning the transaction
      mockDb.returning.mockResolvedValue([{ id: 'txn-123' }]);

      const result = await creditsService.grantSignupCredits(
        mockUserId,
        mockEmail,
        '192.168.1.1'
      );

      expect(result.granted).toBe(true);
      expect(result.balance).toBe(SIGNUP_GRANT_CREDITS);
      expect(result.transactionId).toBe('txn-123');
    });

    it('should return granted: false on second call (idempotent)', async () => {
      // User already has a grant
      mockDb.limit.mockResolvedValue([{ id: 'existing-grant' }]);

      const result = await creditsService.grantSignupCredits(
        mockUserId,
        mockEmail,
        '192.168.1.1'
      );

      expect(result.granted).toBe(false);
      expect(result.reason).toContain('already received');
    });

    it('should reject if IP limit exceeded', async () => {
      // Flow:
      // 1. hasReceivedSignupGrant: select().from().where().limit() -> false (no grant)
      // 2. checkSignupAbuse: select({count}).from().where() -> over limit
      // 3. getBalance (for return): select().from().where().limit() -> user with balance
      let whereCallCount = 0;
      let limitCallCount = 0;

      mockDb.limit.mockImplementation(() => {
        limitCallCount++;
        if (limitCallCount === 1) {
          return Promise.resolve([]); // No existing grant
        }
        // getBalance call - return user with 0 balance
        return Promise.resolve([{ balance: 0 }]);
      });

      mockDb.where.mockImplementation(() => {
        whereCallCount++;
        // 2nd where is checkSignupAbuse count query - resolve directly with over limit
        if (whereCallCount === 2) {
          return Promise.resolve([{ count: 3 }]); // At limit
        }
        return mockDb; // Others chain to limit
      });

      const result = await creditsService.grantSignupCredits(
        mockUserId,
        mockEmail,
        '192.168.1.1'
      );

      expect(result.granted).toBe(false);
      expect(result.reason).toContain('IP address');
    });
  });

  describe('addPurchasedCredits', () => {
    it('should add correct credits for PACK_20', async () => {
      let limitCallCount = 0;
      mockDb.limit.mockImplementation(() => {
        limitCallCount++;
        if (limitCallCount === 1) {
          return Promise.resolve([]); // No existing transaction
        }
        return Promise.resolve([{ balance: 25 }]); // New balance (5 signup + 20 pack)
      });

      mockDb.returning.mockResolvedValue([{ id: 'txn-456' }]);

      const result = await creditsService.addPurchasedCredits(
        mockUserId,
        'PACK_20',
        'evt_123456'
      );

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(25);
      expect(result.transactionId).toBe('txn-456');
    });

    it('should be idempotent - same stripeEventId returns success without new deduction', async () => {
      // Existing transaction found
      mockDb.limit.mockImplementation(() => {
        return Promise.resolve([{ id: 'existing-txn', balance: 25 }]);
      });

      const result = await creditsService.addPurchasedCredits(
        mockUserId,
        'PACK_20',
        'evt_123456'
      );

      expect(result.success).toBe(true);
      // Should not create a new transaction
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('spendCredits', () => {
    it('should deduct credits when sufficient balance', async () => {
      // First limit call: No existing idempotent transaction
      mockDb.limit.mockResolvedValue([]);

      // Mock execute for FOR UPDATE locking - returns current balance
      mockDb.execute.mockResolvedValue({ rows: [{ credits_balance: 10 }] });

      mockDb.returning.mockResolvedValue([{ id: 'spend-txn-123' }]);

      const result = await creditsService.spendCredits(
        mockUserId,
        1,
        'job-123-spend'
      );

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(9);
      expect(result.transactionId).toBe('spend-txn-123');
    });

    it('should fail when insufficient balance', async () => {
      // No existing idempotent transaction
      mockDb.limit.mockResolvedValue([]);

      // Mock execute for FOR UPDATE locking - returns zero balance
      mockDb.execute.mockResolvedValue({ rows: [{ credits_balance: 0 }] });

      const result = await creditsService.spendCredits(
        mockUserId,
        1,
        'job-123-spend'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient credits');
      expect(result.newBalance).toBe(0);
    });

    it('should be idempotent - same idempotencyKey returns success', async () => {
      // Existing transaction found
      mockDb.limit.mockImplementation(() => {
        return Promise.resolve([{ id: 'existing-spend', balance: 9 }]);
      });

      const result = await creditsService.spendCredits(
        mockUserId,
        1,
        'job-123-spend'
      );

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe('existing-spend');
    });

    it('should reject non-positive amounts', async () => {
      mockDb.limit.mockResolvedValue([{ balance: 10 }]);

      const result = await creditsService.spendCredits(
        mockUserId,
        0,
        'job-123-spend'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be positive');
    });
  });

  describe('checkSignupAbuse', () => {
    it('should allow if under limits', async () => {
      // Mock count queries returning under limit
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        }),
      });

      const result = await creditsService.checkSignupAbuse('192.168.1.1', 'device-fingerprint');

      expect(result.allowed).toBe(true);
    });

    it('should block if IP limit exceeded', async () => {
      // Mock count query for IP
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 3 }]), // At limit (3)
        }),
      });

      const result = await creditsService.checkSignupAbuse('192.168.1.1');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('IP address');
    });

    it('should block if device limit exceeded', async () => {
      // First call for IP (under limit), second for device (at limit)
      let callCount = 0;
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve([{ count: 1 }]); // IP under limit
            }
            return Promise.resolve([{ count: 2 }]); // Device at limit
          }),
        }),
      });

      const result = await creditsService.checkSignupAbuse('192.168.1.1', 'device-fp');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('device');
    });
  });

  describe('recalculateBalance', () => {
    it('should recalculate from ledger and update cache', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ sum: 15 }]),
        }),
      });

      const result = await creditsService.recalculateBalance(mockUserId);

      expect(result).toBe(15);
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('calculateJobCost', () => {
    // Uses mocked pricing config:
    // baseCredits: 1, creditsPerSecond: 0.05, includedFrames: 4,
    // extraFrameCost: 0.25, minJobCost: 1, maxJobCost: 0

    it('should reject negative video duration', async () => {
      await expect(
        creditsService.calculateJobCost({ videoDurationSeconds: -1 })
      ).rejects.toThrow('Video duration cannot be negative');
    });

    it('should reject video duration exceeding max limit', async () => {
      await expect(
        creditsService.calculateJobCost({ videoDurationSeconds: MAX_VIDEO_DURATION_SECONDS + 1 })
      ).rejects.toThrow(`Video duration cannot exceed ${MAX_VIDEO_DURATION_SECONDS} seconds`);
    });

    it('should accept video duration at max limit', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
      });

      // Should not throw, and calculate valid cost
      expect(result.totalCredits).toBeGreaterThan(0);
    });

    it('should accept zero duration video', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 0,
      });

      // base (1) + duration (0) = 1 (minimum)
      expect(result.totalCredits).toBe(1);
    });

    it('should calculate base cost for short video', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 10,
      });

      // base (1) + duration (10 * 0.05 = 0.5) = 1.5
      expect(result.totalCredits).toBe(1.5);
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0].type).toBe('base');
      expect(result.breakdown[0].credits).toBe(1);
      expect(result.breakdown[1].type).toBe('duration');
      expect(result.breakdown[1].credits).toBe(0.5);
    });

    it('should calculate duration-based cost correctly', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 60, // 1 minute
      });

      // base (1) + duration (60 * 0.05 = 3) = 4
      expect(result.totalCredits).toBe(4);
    });

    it('should add extra frames cost when exceeding included frames', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 10,
        frameCount: 8, // 4 extra frames beyond the included 4
      });

      // base (1) + duration (0.5) + extra frames (4 * 0.25 = 1) = 2.5
      expect(result.totalCredits).toBe(2.5);
      expect(result.breakdown).toHaveLength(3);
      expect(result.breakdown[2].type).toBe('extra_frames');
      expect(result.breakdown[2].credits).toBe(1);
    });

    it('should not charge for frames within included count', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 10,
        frameCount: 4, // Exactly included frames
      });

      // base (1) + duration (0.5) = 1.5 (no extra frames charge)
      expect(result.totalCredits).toBe(1.5);
      expect(result.breakdown).toHaveLength(2);
    });

    it('should not charge for frames below included count', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 10,
        frameCount: 2, // Below included frames
      });

      // base (1) + duration (0.5) = 1.5 (no extra frames charge)
      expect(result.totalCredits).toBe(1.5);
      expect(result.breakdown).toHaveLength(2);
    });

    it('should apply minimum cost floor', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 1, // Very short video
      });

      // base (1) + duration (1 * 0.05 = 0.05) = 1.05
      // But min is 1, so stays at 1.05 (already above min)
      expect(result.totalCredits).toBe(1.05);
    });

    it('should round to 2 decimal places', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 7, // 7 * 0.05 = 0.35
      });

      // base (1) + duration (0.35) = 1.35
      expect(result.totalCredits).toBe(1.35);
    });

    it('should include itemized breakdown', async () => {
      const result = await creditsService.calculateJobCost({
        videoDurationSeconds: 30,
        frameCount: 6,
      });

      // base (1) + duration (1.5) + extra frames (2 * 0.25 = 0.5) = 3
      expect(result.totalCredits).toBe(3);
      expect(result.breakdown).toHaveLength(3);

      // Check base cost
      expect(result.breakdown[0].type).toBe('base');
      expect(result.breakdown[0].credits).toBe(1);

      // Check duration cost
      expect(result.breakdown[1].type).toBe('duration');
      expect(result.breakdown[1].credits).toBe(1.5);
      expect(result.breakdown[1].details).toMatchObject({
        videoDurationSeconds: 30,
        creditsPerSecond: 0.05,
      });

      // Check extra frames cost
      expect(result.breakdown[2].type).toBe('extra_frames');
      expect(result.breakdown[2].credits).toBe(0.5);
      expect(result.breakdown[2].details).toMatchObject({
        extraFrames: 2,
        includedFrames: 4,
        costPerFrame: 0.25,
      });
    });
  });

  describe('calculateJobCostWithAffordability', () => {
    it('should return canAfford: true when balance is sufficient', async () => {
      // Mock getBalance to return sufficient balance
      mockDb.limit.mockResolvedValue([{ balance: 10 }]);

      const result = await creditsService.calculateJobCostWithAffordability(mockUserId, {
        videoDurationSeconds: 30,
      });

      // base (1) + duration (1.5) = 2.5
      expect(result.totalCredits).toBe(2.5);
      expect(result.canAfford).toBe(true);
      expect(result.currentBalance).toBe(10);
    });

    it('should return canAfford: false when balance is insufficient', async () => {
      // Mock getBalance to return insufficient balance
      mockDb.limit.mockResolvedValue([{ balance: 1 }]);

      const result = await creditsService.calculateJobCostWithAffordability(mockUserId, {
        videoDurationSeconds: 60,
        frameCount: 10,
      });

      // base (1) + duration (3) + extra frames (6 * 0.25 = 1.5) = 5.5
      expect(result.totalCredits).toBe(5.5);
      expect(result.canAfford).toBe(false);
      expect(result.currentBalance).toBe(1);
    });

    it('should return canAfford: true when balance equals cost', async () => {
      mockDb.limit.mockResolvedValue([{ balance: 2.5 }]);

      const result = await creditsService.calculateJobCostWithAffordability(mockUserId, {
        videoDurationSeconds: 30,
      });

      expect(result.totalCredits).toBe(2.5);
      expect(result.canAfford).toBe(true);
      expect(result.currentBalance).toBe(2.5);
    });
  });
});

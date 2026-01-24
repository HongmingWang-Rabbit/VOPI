import { eq, sql, desc, count } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { getDatabase, schema } from '../db/index.js';
import { getLogger } from '../utils/logger.js';
import { NotFoundError } from '../utils/errors.js';
import { globalConfigService } from './global-config.service.js';
import {
  CreditTransactionType,
  CreditPacks,
  SIGNUP_GRANT_CREDITS,
  MAX_VIDEO_DURATION_SECONDS,
  AddOnService,
  type CreditPackType,
  type CreditBalanceResponse,
  type CreditTransactionResponse,
  type SpendCreditsResponse,
  type SignupGrantResponse,
  type SignupAbuseCheckResult,
  type CreditTransactionMetadata,
  type JobCostRequest,
  type JobCostResponse,
  type CostBreakdownItem,
} from '../types/credits.types.js';

const logger = getLogger().child({ service: 'credits' });

/** Type for values that can be converted to number (common DB return types) */
type NumberConvertible = string | number | bigint | null | undefined;

/**
 * Convert bigint/string count to number safely
 * Handles common database return types from aggregate functions
 */
function toNumber(value: NumberConvertible): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    return parseInt(value, 10) || 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  return 0;
}

/**
 * Credits service - manages credit ledger operations
 */
class CreditsService {
  /**
   * Get cached balance from users table
   */
  async getBalance(userId: string): Promise<number> {
    const db = getDatabase();

    const [user] = await db
      .select({ balance: schema.users.creditsBalance })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundError(`User ${userId} not found`);
    }

    return user.balance;
  }

  /**
   * Get balance with recent transaction history
   */
  async getBalanceWithHistory(
    userId: string,
    limit = 20
  ): Promise<CreditBalanceResponse> {
    const db = getDatabase();

    const [user] = await db
      .select({ balance: schema.users.creditsBalance })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundError(`User ${userId} not found`);
    }

    const transactions = await db
      .select({
        id: schema.creditTransactions.id,
        creditsDelta: schema.creditTransactions.creditsDelta,
        type: schema.creditTransactions.type,
        description: schema.creditTransactions.description,
        createdAt: schema.creditTransactions.createdAt,
        jobId: schema.creditTransactions.jobId,
      })
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, userId))
      .orderBy(desc(schema.creditTransactions.createdAt))
      .limit(limit);

    return {
      balance: user.balance,
      transactions: transactions.map((t) => ({
        id: t.id,
        creditsDelta: t.creditsDelta,
        type: t.type as CreditTransactionResponse['type'],
        description: t.description,
        createdAt: t.createdAt.toISOString(),
        jobId: t.jobId,
      })),
    };
  }

  /**
   * Check if user has already received signup grant
   */
  async hasReceivedSignupGrant(userId: string): Promise<boolean> {
    const db = getDatabase();

    const [grant] = await db
      .select({ id: schema.signupGrants.id })
      .from(schema.signupGrants)
      .where(eq(schema.signupGrants.userId, userId))
      .limit(1);

    return !!grant;
  }

  /**
   * Check IP/device limits for abuse prevention
   */
  async checkSignupAbuse(
    ip?: string,
    deviceFingerprint?: string
  ): Promise<SignupAbuseCheckResult> {
    const config = getConfig();
    const db = getDatabase();

    let ipCount = 0;
    let deviceCount = 0;

    // Check IP limit
    if (ip) {
      const [ipResult] = await db
        .select({ count: count() })
        .from(schema.signupGrants)
        .where(eq(schema.signupGrants.ipAddress, ip));

      ipCount = toNumber(ipResult?.count);

      if (ipCount >= config.abusePrevention.signupGrantIpLimit) {
        logger.warn({ ip, ipCount, limit: config.abusePrevention.signupGrantIpLimit }, 'IP limit exceeded for signup grant');
        return {
          allowed: false,
          reason: 'Too many signup grants from this IP address',
          ipCount,
        };
      }
    }

    // Check device fingerprint limit
    if (deviceFingerprint) {
      const [deviceResult] = await db
        .select({ count: count() })
        .from(schema.signupGrants)
        .where(eq(schema.signupGrants.deviceFingerprint, deviceFingerprint));

      deviceCount = toNumber(deviceResult?.count);

      if (deviceCount >= config.abusePrevention.signupGrantDeviceLimit) {
        logger.warn(
          { deviceFingerprint, deviceCount, limit: config.abusePrevention.signupGrantDeviceLimit },
          'Device limit exceeded for signup grant'
        );
        return {
          allowed: false,
          reason: 'Too many signup grants from this device',
          deviceCount,
        };
      }
    }

    return { allowed: true, ipCount, deviceCount };
  }

  /**
   * Grant signup credits to new user (idempotent)
   */
  async grantSignupCredits(
    userId: string,
    email: string,
    ip?: string,
    deviceFingerprint?: string
  ): Promise<SignupGrantResponse> {
    const db = getDatabase();

    // Check if already granted (idempotent)
    const hasGrant = await this.hasReceivedSignupGrant(userId);
    if (hasGrant) {
      const balance = await this.getBalance(userId);
      return { granted: false, balance, reason: 'Signup grant already received' };
    }

    // Check abuse limits
    const abuseCheck = await this.checkSignupAbuse(ip, deviceFingerprint);
    if (!abuseCheck.allowed) {
      const balance = await this.getBalance(userId);
      return { granted: false, balance, reason: abuseCheck.reason };
    }

    // Use transaction for atomicity
    const result = await db.transaction(async (tx) => {
      // Double-check inside transaction (race condition protection)
      const [existingGrant] = await tx
        .select({ id: schema.signupGrants.id })
        .from(schema.signupGrants)
        .where(eq(schema.signupGrants.userId, userId))
        .limit(1);

      if (existingGrant) {
        const [user] = await tx
          .select({ balance: schema.users.creditsBalance })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        return { granted: false, balance: user?.balance ?? 0, reason: 'Signup grant already received' };
      }

      // Create credit transaction
      const idempotencyKey = `signup_grant:${userId}`;
      const [transaction] = await tx
        .insert(schema.creditTransactions)
        .values({
          userId,
          creditsDelta: SIGNUP_GRANT_CREDITS,
          type: CreditTransactionType.SIGNUP_GRANT,
          idempotencyKey,
          description: `Welcome bonus: ${SIGNUP_GRANT_CREDITS} free credits`,
          metadata: { email } as CreditTransactionMetadata,
        })
        .returning();

      // Record signup grant for abuse tracking
      await tx.insert(schema.signupGrants).values({
        userId,
        email,
        ipAddress: ip,
        deviceFingerprint,
        transactionId: transaction.id,
      });

      // Update cached balance
      await tx
        .update(schema.users)
        .set({
          creditsBalance: sql`${schema.users.creditsBalance} + ${SIGNUP_GRANT_CREDITS}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, userId));

      // Get new balance
      const [user] = await tx
        .select({ balance: schema.users.creditsBalance })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      return {
        granted: true,
        balance: user?.balance ?? SIGNUP_GRANT_CREDITS,
        transactionId: transaction.id,
      };
    });

    if (result.granted) {
      logger.info({ userId, email, credits: SIGNUP_GRANT_CREDITS }, 'Signup credits granted');
    }

    return result;
  }

  /**
   * Add credits from Stripe purchase (idempotent via stripeEventId)
   */
  async addPurchasedCredits(
    userId: string,
    packType: CreditPackType,
    stripeEventId: string,
    stripePaymentIntentId?: string,
    stripeCheckoutSessionId?: string
  ): Promise<{ success: boolean; newBalance: number; transactionId?: string }> {
    const db = getDatabase();
    const pack = CreditPacks[packType];

    const idempotencyKey = `stripe:${stripeEventId}`;

    try {
      const result = await db.transaction(async (tx) => {
        // Check for existing transaction (idempotency)
        const [existing] = await tx
          .select({ id: schema.creditTransactions.id })
          .from(schema.creditTransactions)
          .where(eq(schema.creditTransactions.idempotencyKey, idempotencyKey))
          .limit(1);

        if (existing) {
          // Already processed, return current balance
          const [user] = await tx
            .select({ balance: schema.users.creditsBalance })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1);
          return { success: true, newBalance: user?.balance ?? 0, alreadyProcessed: true };
        }

        // Create credit transaction
        const [transaction] = await tx
          .insert(schema.creditTransactions)
          .values({
            userId,
            creditsDelta: pack.credits,
            type: CreditTransactionType.PURCHASE,
            idempotencyKey,
            stripePaymentIntentId,
            stripeCheckoutSessionId,
            description: `Purchased ${pack.name} (${pack.credits} credits)`,
            metadata: {
              packType,
              priceUsd: pack.priceUsd,
              stripeEventId,
            } as CreditTransactionMetadata,
          })
          .returning();

        // Update cached balance
        await tx
          .update(schema.users)
          .set({
            creditsBalance: sql`${schema.users.creditsBalance} + ${pack.credits}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, userId));

        // Get new balance
        const [user] = await tx
          .select({ balance: schema.users.creditsBalance })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);

        return {
          success: true,
          newBalance: user?.balance ?? pack.credits,
          transactionId: transaction.id,
          alreadyProcessed: false,
        };
      });

      if (!result.alreadyProcessed) {
        logger.info(
          { userId, packType, credits: pack.credits, stripeEventId },
          'Credits purchased'
        );
      }

      return {
        success: result.success,
        newBalance: result.newBalance,
        transactionId: result.transactionId,
      };
    } catch (error) {
      logger.error({ userId, packType, stripeEventId, error }, 'Failed to add purchased credits');
      throw error;
    }
  }

  /**
   * Spend credits (idempotent via idempotencyKey)
   * Uses FOR UPDATE lock to prevent race conditions on balance check
   */
  async spendCredits(
    userId: string,
    amount: number,
    idempotencyKey: string,
    jobId?: string,
    description?: string
  ): Promise<SpendCreditsResponse> {
    const db = getDatabase();

    if (amount <= 0) {
      try {
        const balance = await this.getBalance(userId);
        return { success: false, newBalance: balance, error: 'Amount must be positive' };
      } catch {
        return { success: false, newBalance: 0, error: 'Amount must be positive' };
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        // Check for existing transaction (idempotency)
        const [existing] = await tx
          .select({ id: schema.creditTransactions.id })
          .from(schema.creditTransactions)
          .where(eq(schema.creditTransactions.idempotencyKey, idempotencyKey))
          .limit(1);

        if (existing) {
          // Already processed, return current balance
          const [user] = await tx
            .select({ balance: schema.users.creditsBalance })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1);
          return {
            success: true,
            newBalance: user?.balance ?? 0,
            transactionId: existing.id,
            alreadyProcessed: true,
          };
        }

        // Get current balance with row lock using FOR UPDATE
        // This prevents concurrent spends from causing overdraft
        const lockResult = await tx.execute(
          sql`SELECT credits_balance FROM users WHERE id = ${userId} FOR UPDATE`
        );

        const userRow = lockResult.rows[0] as { credits_balance: number } | undefined;
        if (!userRow) {
          return { success: false, newBalance: 0, error: `User ${userId} not found` };
        }

        const currentBalance = toNumber(userRow.credits_balance);

        // Check sufficient balance
        if (currentBalance < amount) {
          return {
            success: false,
            newBalance: currentBalance,
            error: `Insufficient credits. Available: ${currentBalance}, required: ${amount}`,
          };
        }

        // Create debit transaction
        const [transaction] = await tx
          .insert(schema.creditTransactions)
          .values({
            userId,
            creditsDelta: -amount,
            type: CreditTransactionType.SPEND,
            idempotencyKey,
            jobId,
            description: description || `Spent ${amount} credit${amount > 1 ? 's' : ''}`,
          })
          .returning();

        // Update cached balance atomically
        const newBalance = currentBalance - amount;
        await tx
          .update(schema.users)
          .set({
            creditsBalance: newBalance,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, userId));

        return {
          success: true,
          newBalance,
          transactionId: transaction.id,
          alreadyProcessed: false,
        };
      });

      if (result.success && !result.alreadyProcessed) {
        logger.info({ userId, amount, jobId, idempotencyKey }, 'Credits spent');
      }

      return {
        success: result.success,
        newBalance: result.newBalance,
        transactionId: result.transactionId,
        error: result.error,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ userId, amount, idempotencyKey, error: errorMessage }, 'Failed to spend credits');
      throw error;
    }
  }

  /**
   * Recalculate cached balance from ledger (for reconciliation)
   */
  async recalculateBalance(userId: string): Promise<number> {
    const db = getDatabase();

    const [result] = await db
      .select({
        sum: sql<number>`COALESCE(SUM(${schema.creditTransactions.creditsDelta}), 0)`,
      })
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, userId));

    const calculatedBalance = result?.sum ?? 0;

    // Update cached balance
    await db
      .update(schema.users)
      .set({
        creditsBalance: calculatedBalance,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId));

    logger.info({ userId, calculatedBalance }, 'Balance recalculated');

    return calculatedBalance;
  }

  /**
   * Refund credits (admin operation)
   */
  async refundCredits(
    userId: string,
    amount: number,
    reason: string,
    originalTransactionId?: string
  ): Promise<{ success: boolean; newBalance: number; transactionId?: string }> {
    const db = getDatabase();

    if (amount <= 0) {
      throw new Error('Refund amount must be positive');
    }

    const idempotencyKey = originalTransactionId
      ? `refund:${originalTransactionId}`
      : `refund:${userId}:${Date.now()}`;

    const result = await db.transaction(async (tx) => {
      // Check for duplicate refund
      if (originalTransactionId) {
        const [existing] = await tx
          .select({ id: schema.creditTransactions.id })
          .from(schema.creditTransactions)
          .where(eq(schema.creditTransactions.idempotencyKey, idempotencyKey))
          .limit(1);

        if (existing) {
          const [user] = await tx
            .select({ balance: schema.users.creditsBalance })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1);
          return { success: true, newBalance: user?.balance ?? 0 };
        }
      }

      // Create refund transaction
      const [transaction] = await tx
        .insert(schema.creditTransactions)
        .values({
          userId,
          creditsDelta: amount,
          type: CreditTransactionType.REFUND,
          idempotencyKey,
          description: `Refund: ${reason}`,
          metadata: { adminReason: reason, originalTransactionId } as CreditTransactionMetadata,
        })
        .returning();

      // Update cached balance
      await tx
        .update(schema.users)
        .set({
          creditsBalance: sql`${schema.users.creditsBalance} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, userId));

      // Get new balance
      const [user] = await tx
        .select({ balance: schema.users.creditsBalance })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      return {
        success: true,
        newBalance: user?.balance ?? amount,
        transactionId: transaction.id,
      };
    });

    logger.info({ userId, amount, reason }, 'Credits refunded');

    return result;
  }

  /**
   * Calculate job cost based on video duration, frames, and add-ons.
   * Uses pricing configuration from global config.
   *
   * @param request - Job cost calculation parameters
   * @param request.videoDurationSeconds - Video duration in seconds (max: 1800 / 30 minutes)
   * @param request.frameCount - Number of frames to extract (optional)
   * @param request.addOns - Add-on services requested (optional)
   * @returns Total credits required and itemized breakdown
   * @throws Error if videoDurationSeconds exceeds MAX_VIDEO_DURATION_SECONDS
   */
  async calculateJobCost(request: JobCostRequest): Promise<JobCostResponse> {
    // Validate video duration
    if (request.videoDurationSeconds < 0) {
      throw new Error('Video duration cannot be negative');
    }
    if (request.videoDurationSeconds > MAX_VIDEO_DURATION_SECONDS) {
      throw new Error(
        `Video duration cannot exceed ${MAX_VIDEO_DURATION_SECONDS} seconds (30 minutes)`
      );
    }

    const pricing = await globalConfigService.getPricingConfig();
    const breakdown: CostBreakdownItem[] = [];

    // 1. Base cost
    breakdown.push({
      type: 'base',
      description: 'Base processing fee',
      credits: pricing.baseCredits,
    });

    // 2. Duration cost (base + per-second)
    const durationCost = request.videoDurationSeconds * pricing.creditsPerSecond;
    if (durationCost > 0) {
      breakdown.push({
        type: 'duration',
        description: `Video duration (${Math.round(request.videoDurationSeconds)}s @ ${pricing.creditsPerSecond}/s)`,
        credits: durationCost,
        details: {
          videoDurationSeconds: request.videoDurationSeconds,
          creditsPerSecond: pricing.creditsPerSecond,
        },
      });
    }

    // 3. Extra frames cost (if requesting more than included)
    const requestedFrames = request.frameCount ?? pricing.includedFrames;
    const extraFrames = Math.max(0, requestedFrames - pricing.includedFrames);
    if (extraFrames > 0) {
      const extraFramesCost = extraFrames * pricing.extraFrameCost;
      breakdown.push({
        type: 'extra_frames',
        description: `Extra frames (${extraFrames} @ ${pricing.extraFrameCost}/frame)`,
        credits: extraFramesCost,
        details: {
          requestedFrames,
          includedFrames: pricing.includedFrames,
          extraFrames,
          costPerFrame: pricing.extraFrameCost,
        },
      });
    }

    // 4. Add-on services
    if (request.addOns?.includes(AddOnService.COMMERCIAL_VIDEO)) {
      if (pricing.commercialVideoEnabled) {
        breakdown.push({
          type: 'commercial_video',
          description: 'Commercial video generation',
          credits: pricing.commercialVideoCost,
        });
      } else {
        // Add-on requested but not enabled - add with 0 cost and note
        breakdown.push({
          type: 'commercial_video',
          description: 'Commercial video generation (coming soon)',
          credits: 0,
          details: { enabled: false, message: 'This feature is coming soon' },
        });
      }
    }

    // Calculate raw total
    let totalCredits = breakdown.reduce((sum, item) => sum + item.credits, 0);

    // Apply floor (minimum cost)
    if (totalCredits < pricing.minJobCost) {
      const adjustment = pricing.minJobCost - totalCredits;
      breakdown.push({
        type: 'adjustment',
        description: `Minimum job cost adjustment`,
        credits: adjustment,
        details: { reason: 'minimum', minJobCost: pricing.minJobCost },
      });
      totalCredits = pricing.minJobCost;
    }

    // Apply ceiling (maximum cost) if set
    if (pricing.maxJobCost > 0 && totalCredits > pricing.maxJobCost) {
      const adjustment = pricing.maxJobCost - totalCredits;
      breakdown.push({
        type: 'adjustment',
        description: `Maximum job cost cap`,
        credits: adjustment,
        details: { reason: 'maximum', maxJobCost: pricing.maxJobCost },
      });
      totalCredits = pricing.maxJobCost;
    }

    // Round to 2 decimal places
    totalCredits = Math.round(totalCredits * 100) / 100;

    return {
      totalCredits,
      breakdown,
    };
  }

  /**
   * Calculate job cost and check if user can afford it
   */
  async calculateJobCostWithAffordability(
    userId: string,
    request: JobCostRequest
  ): Promise<JobCostResponse> {
    const [costResponse, balance] = await Promise.all([
      this.calculateJobCost(request),
      this.getBalance(userId),
    ]);

    return {
      ...costResponse,
      canAfford: balance >= costResponse.totalCredits,
      currentBalance: balance,
    };
  }
}

export const creditsService = new CreditsService();

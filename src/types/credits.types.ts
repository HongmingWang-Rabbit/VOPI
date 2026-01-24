import { z } from 'zod';

/**
 * Credit transaction types
 */
export const CreditTransactionType = {
  SIGNUP_GRANT: 'signup_grant',
  PURCHASE: 'purchase',
  SPEND: 'spend',
  REFUND: 'refund',
  ADMIN_ADJUSTMENT: 'admin_adjustment',
} as const;

export type CreditTransactionType = (typeof CreditTransactionType)[keyof typeof CreditTransactionType];

/**
 * Credit packs available for purchase
 */
export const CreditPacks = {
  CREDIT_1: { credits: 1, priceUsd: 0.99, name: 'Single Credit' },
  PACK_20: { credits: 20, priceUsd: 14.99, name: '20 Credit Pack' },
  PACK_100: { credits: 100, priceUsd: 59, name: '100 Credit Pack' },
  PACK_500: { credits: 500, priceUsd: 199, name: '500 Credit Pack' },
} as const;

export type CreditPackType = keyof typeof CreditPacks;

export const CreditPackTypeSchema = z.enum(['CREDIT_1', 'PACK_20', 'PACK_100', 'PACK_500']);

/**
 * Number of free credits granted on signup
 */
export const SIGNUP_GRANT_CREDITS = 5;

/**
 * Maximum video duration in seconds (30 minutes)
 * Used for input validation to prevent abuse
 */
export const MAX_VIDEO_DURATION_SECONDS = 1800;

/**
 * Metadata stored with credit transactions
 */
export interface CreditTransactionMetadata {
  /** Pack type for purchase transactions */
  packType?: CreditPackType;
  /** Price in USD for purchase transactions */
  priceUsd?: number;
  /** Stripe event ID for webhook-triggered transactions */
  stripeEventId?: string;
  /** Reason for admin adjustments */
  adminReason?: string;
  /** Additional context */
  [key: string]: unknown;
}

/**
 * Request schemas
 */
export const createCheckoutSessionSchema = z.object({
  packType: CreditPackTypeSchema,
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export type CreateCheckoutSessionRequest = z.infer<typeof createCheckoutSessionSchema>;

export const spendCreditsSchema = z.object({
  amount: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(255),
  jobId: z.string().uuid().optional(),
  description: z.string().optional(),
});

export type SpendCreditsRequest = z.infer<typeof spendCreditsSchema>;

/**
 * Response types
 */
export interface CreditBalanceResponse {
  balance: number;
  transactions?: CreditTransactionResponse[];
}

export interface CreditTransactionResponse {
  id: string;
  creditsDelta: number;
  type: CreditTransactionType;
  description: string | null;
  createdAt: string;
  jobId?: string | null;
}

export interface CreditPackResponse {
  packType: CreditPackType;
  credits: number;
  priceUsd: number;
  name: string;
  stripePriceId?: string;
}

export interface CheckoutSessionResponse {
  checkoutUrl: string;
  sessionId: string;
}

export interface SpendCreditsResponse {
  success: boolean;
  newBalance: number;
  transactionId?: string;
  error?: string;
}

export interface SignupGrantResponse {
  granted: boolean;
  balance: number;
  transactionId?: string;
  reason?: string;
}

export interface SignupAbuseCheckResult {
  allowed: boolean;
  reason?: string;
  ipCount?: number;
  deviceCount?: number;
}

/**
 * ============================================
 * DYNAMIC PRICING CONFIGURATION
 * ============================================
 */

/**
 * Add-on service types
 */
export const AddOnService = {
  EXTRA_FRAMES: 'extra_frames',
  COMMERCIAL_VIDEO: 'commercial_video', // Coming soon
} as const;

export type AddOnServiceType = (typeof AddOnService)[keyof typeof AddOnService];

/**
 * Pricing configuration stored in global_config
 */
export interface PricingConfig {
  /** Base cost per job in credits */
  baseCredits: number;
  /** Additional credits per second of video duration */
  creditsPerSecond: number;
  /** Default number of frames included in base price */
  includedFrames: number;
  /** Cost per extra frame beyond included amount */
  extraFrameCost: number;
  /** Whether commercial video generation is enabled */
  commercialVideoEnabled: boolean;
  /** Cost for commercial video generation (when enabled) */
  commercialVideoCost: number;
  /** Minimum job cost (floor) */
  minJobCost: number;
  /** Maximum job cost (ceiling, 0 = no limit) */
  maxJobCost: number;
}

/**
 * Default pricing configuration values
 */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  baseCredits: 1,
  creditsPerSecond: 0.05, // 1 credit per 20 seconds
  includedFrames: 4,
  extraFrameCost: 0.25, // 0.25 credits per extra frame
  commercialVideoEnabled: false,
  commercialVideoCost: 2,
  minJobCost: 1,
  maxJobCost: 0, // No limit
};

/**
 * Job cost calculation request
 */
export interface JobCostRequest {
  /** Video duration in seconds */
  videoDurationSeconds: number;
  /** Number of frames to extract (optional, uses config default) */
  frameCount?: number;
  /** Add-on services requested */
  addOns?: AddOnServiceType[];
}

/**
 * Cost breakdown item
 */
export interface CostBreakdownItem {
  /** Type of charge */
  type: 'base' | 'duration' | 'extra_frames' | 'commercial_video' | 'adjustment';
  /** Description of the charge */
  description: string;
  /** Credit amount for this item */
  credits: number;
  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Job cost calculation response
 */
export interface JobCostResponse {
  /** Total credits required */
  totalCredits: number;
  /** Itemized cost breakdown */
  breakdown: CostBreakdownItem[];
  /** Whether the user can afford this job */
  canAfford?: boolean;
  /** User's current balance (if checked) */
  currentBalance?: number;
}

/**
 * Zod schema for job cost estimate request
 */
export const jobCostEstimateSchema = z.object({
  videoDurationSeconds: z
    .number()
    .nonnegative()
    .max(MAX_VIDEO_DURATION_SECONDS, `Video duration cannot exceed ${MAX_VIDEO_DURATION_SECONDS} seconds (30 minutes)`),
  frameCount: z.number().int().positive().optional(),
  addOns: z.array(z.enum(['extra_frames', 'commercial_video'])).optional(),
});

export type JobCostEstimateRequest = z.infer<typeof jobCostEstimateSchema>;

/**
 * Extended spend credits metadata for job-based spending
 */
export interface JobSpendMetadata extends CreditTransactionMetadata {
  /** Video duration in seconds */
  videoDurationSeconds?: number;
  /** Number of frames extracted */
  frameCount?: number;
  /** Add-on services used */
  addOns?: AddOnServiceType[];
  /** Cost breakdown */
  costBreakdown?: CostBreakdownItem[];
}

/**
 * Error codes for credit-related failures
 */
export const CreditErrorCode = {
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  INVALID_DURATION: 'INVALID_DURATION',
  CALCULATION_ERROR: 'CALCULATION_ERROR',
} as const;

export type CreditErrorCode = (typeof CreditErrorCode)[keyof typeof CreditErrorCode];

/**
 * Structured credit error for API responses and logging
 */
export interface CreditError {
  /** Error code for machine processing */
  code: CreditErrorCode;
  /** Credits required for the operation */
  creditsRequired: number;
  /** Credits currently available */
  creditsAvailable: number;
  /** Itemized cost breakdown */
  breakdown?: CostBreakdownItem[];
  /** Video duration in seconds */
  videoDurationSeconds?: number;
}

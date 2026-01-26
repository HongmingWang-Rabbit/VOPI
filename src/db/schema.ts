import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, real, boolean, unique, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type {
  JobConfig,
  JobProgress,
  JobResult,
  VideoMetadata,
  FrameScores,
  FrameObstructions,
  BackgroundRecommendations,
} from '../types/job.types.js';
import type { GlobalConfigValue } from '../types/config.types.js';
import type { MetadataFileOutput } from '../types/product-metadata.types.js';
import type { OAuthProviderData, PlatformConnectionMetadata, PlatformListingMetadata } from '../types/auth.types.js';
import type { CreditTransactionMetadata } from '../types/credits.types.js';

/**
 * API Keys table - invitation codes with usage limits
 */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 128 }).notNull().unique(), // 128 chars for future key format flexibility
  name: varchar('name', { length: 100 }), // e.g., "John's beta access"
  maxUses: integer('max_uses').notNull().default(10),
  usedCount: integer('used_count').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'), // Optional time-based expiry
  revokedAt: timestamp('revoked_at'), // Soft delete
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

/**
 * Users table - user accounts (OAuth-based login)
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: varchar('name', { length: 255 }),
  avatarUrl: text('avatar_url'),
  /** Cached credit balance (sum of credit_transactions) */
  creditsBalance: integer('credits_balance').notNull().default(0),
  /** Stripe customer ID for payment processing */
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
  deletedAt: timestamp('deleted_at'),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * OAuth Accounts table - social OAuth providers linked to users
 */
export const oauthAccounts = pgTable('oauth_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 50 }).notNull(), // 'google', 'apple'
  providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at'),
  providerData: jsonb('provider_data').$type<OAuthProviderData>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  providerAccountUnique: unique('oauth_provider_account_unique').on(table.provider, table.providerAccountId),
  userIdIdx: index('idx_oauth_accounts_user_id').on(table.userId),
}));

export type OAuthAccount = typeof oauthAccounts.$inferSelect;
export type NewOAuthAccount = typeof oauthAccounts.$inferInsert;

/**
 * Refresh Tokens table - JWT refresh token tracking
 */
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
  deviceId: varchar('device_id', { length: 255 }),
  deviceName: varchar('device_name', { length: 255 }),
  userAgent: text('user_agent'),
  ipAddress: varchar('ip_address', { length: 45 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
}, (table) => ({
  userIdIdx: index('idx_refresh_tokens_user_id').on(table.userId),
  expiresAtIdx: index('idx_refresh_tokens_expires_at').on(table.expiresAt),
}));

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

/**
 * Platform Connections table - E-commerce platform OAuth tokens
 */
export const platformConnections = pgTable('platform_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: varchar('platform', { length: 20 }).notNull(), // 'shopify', 'amazon', 'ebay'
  platformAccountId: varchar('platform_account_id', { length: 255 }).notNull(),
  accessToken: text('access_token').notNull(), // encrypted
  refreshToken: text('refresh_token'), // encrypted
  tokenExpiresAt: timestamp('token_expires_at'),
  metadata: jsonb('metadata').$type<PlatformConnectionMetadata>(), // platform-specific data
  status: varchar('status', { length: 20 }).notNull().default('active'),
  lastError: text('last_error'),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  uniqueConnection: unique('platform_connection_unique').on(table.userId, table.platform, table.platformAccountId),
  // Note: tokenExpiresAt index is defined as a partial index in migration 0006
  // Partial indexes cannot be expressed in Drizzle schema, so managed via SQL migration
}));

export type PlatformConnection = typeof platformConnections.$inferSelect;
export type NewPlatformConnection = typeof platformConnections.$inferInsert;

/**
 * Jobs table - tracks extraction/commercial jobs
 */
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  videoUrl: text('video_url').notNull(),
  config: jsonb('config').$type<JobConfig>().notNull(),
  progress: jsonb('progress').$type<JobProgress>(),
  result: jsonb('result').$type<JobResult>(),
  error: text('error'),
  callbackUrl: text('callback_url'),
  /** Product metadata extracted from audio analysis (transcript, e-commerce data) */
  productMetadata: jsonb('product_metadata').$type<MetadataFileOutput>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  userIdIdx: index('idx_jobs_user_id').on(table.userId),
  statusIdx: index('idx_jobs_status').on(table.status),
  userStatusIdx: index('idx_jobs_user_status').on(table.userId, table.status),
}));

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/**
 * Videos table - video metadata
 */
export const videos = pgTable('videos', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  sourceUrl: text('source_url').notNull(),
  localPath: text('local_path'),
  duration: real('duration'),
  width: integer('width'),
  height: integer('height'),
  fps: real('fps'),
  codec: varchar('codec', { length: 50 }),
  metadata: jsonb('metadata').$type<VideoMetadata>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;

/**
 * Frames table - extracted frames
 */
export const frames = pgTable('frames', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  videoId: uuid('video_id')
    .notNull()
    .references(() => videos.id, { onDelete: 'cascade' }),
  frameId: varchar('frame_id', { length: 50 }).notNull(), // e.g., frame_00001
  timestamp: real('timestamp').notNull(), // Timestamp in seconds
  localPath: text('local_path'),
  s3Url: text('s3_url'),
  scores: jsonb('scores').$type<FrameScores>(),
  // Gemini classification
  productId: varchar('product_id', { length: 50 }),
  variantId: varchar('variant_id', { length: 50 }),
  angleEstimate: varchar('angle_estimate', { length: 50 }),
  variantDescription: text('variant_description'),
  obstructions: jsonb('obstructions').$type<FrameObstructions>(),
  backgroundRecommendations: jsonb('background_recommendations').$type<BackgroundRecommendations>(),
  isBestPerSecond: boolean('is_best_per_second').default(false),
  isFinalSelection: boolean('is_final_selection').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Frame = typeof frames.$inferSelect;
export type NewFrame = typeof frames.$inferInsert;

/**
 * Commercial images table - generated commercial images
 */
export const commercialImages = pgTable('commercial_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  frameId: uuid('frame_id')
    .notNull()
    .references(() => frames.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 20 }).notNull(), // transparent, solid, real, creative
  localPath: text('local_path'),
  s3Url: text('s3_url'),
  backgroundColor: varchar('background_color', { length: 20 }),
  backgroundPrompt: text('background_prompt'),
  success: boolean('success').default(true),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type CommercialImage = typeof commercialImages.$inferSelect;
export type NewCommercialImage = typeof commercialImages.$inferInsert;

/**
 * Platform Listings table - Products pushed to e-commerce platforms
 */
export const platformListings = pgTable('platform_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => platformConnections.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  platformProductId: varchar('platform_product_id', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending, pushing, completed, failed
  metadata: jsonb('metadata').$type<PlatformListingMetadata>(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type PlatformListing = typeof platformListings.$inferSelect;
export type NewPlatformListing = typeof platformListings.$inferInsert;

/**
 * Global config table - runtime configuration with A/B testing support
 */
export const globalConfig = pgTable('global_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 100 }).notNull().unique(),
  value: jsonb('value').$type<GlobalConfigValue>().notNull(),
  category: varchar('category', { length: 50 }).notNull().default('system'),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type GlobalConfig = typeof globalConfig.$inferSelect;
export type NewGlobalConfig = typeof globalConfig.$inferInsert;

/**
 * Credit transactions table - ledger for all credit changes
 * Balance is calculated as SUM(credits_delta) for a user
 */
export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Credit amount change: positive for additions, negative for spends */
  creditsDelta: integer('credits_delta').notNull(),
  /** Transaction type: signup_grant, purchase, spend, refund, admin_adjustment */
  type: varchar('type', { length: 30 }).notNull(),
  /** Unique key to prevent duplicate transactions (e.g., webhook replay) */
  idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
  /** Stripe Payment Intent ID for purchase transactions */
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  /** Stripe Checkout Session ID for purchase transactions */
  stripeCheckoutSessionId: varchar('stripe_checkout_session_id', { length: 255 }),
  /** Associated job ID for spend transactions */
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  /** Human-readable description of the transaction */
  description: text('description'),
  /** Additional metadata (pack type, stripe event details, etc.) */
  metadata: jsonb('metadata').$type<CreditTransactionMetadata>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('credit_transactions_user_id_idx').on(table.userId),
  typeIdx: index('credit_transactions_type_idx').on(table.type),
  createdAtIdx: index('credit_transactions_created_at_idx').on(table.createdAt),
}));

export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type NewCreditTransaction = typeof creditTransactions.$inferInsert;

/**
 * Stripe events table - webhook idempotency tracking
 * Prevents double-processing of webhooks
 */
export const stripeEvents = pgTable('stripe_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stripe event ID (evt_xxx) - unique constraint prevents duplicates */
  eventId: varchar('event_id', { length: 255 }).notNull().unique(),
  /** Stripe event type (e.g., checkout.session.completed) */
  eventType: varchar('event_type', { length: 100 }).notNull(),
  /** Whether the event has been fully processed */
  processed: boolean('processed').notNull().default(false),
  /** When the event was processed */
  processedAt: timestamp('processed_at'),
  /** Error message if processing failed */
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type StripeEvent = typeof stripeEvents.$inferSelect;
export type NewStripeEvent = typeof stripeEvents.$inferInsert;

/**
 * Signup grants table - abuse prevention for free signup credits
 * Tracks IP addresses and device fingerprints to prevent farming
 */
export const signupGrants = pgTable('signup_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** User who received the grant - one grant per user */
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  /** IP address at time of signup */
  ipAddress: varchar('ip_address', { length: 45 }),
  /** Device fingerprint for additional abuse detection */
  deviceFingerprint: varchar('device_fingerprint', { length: 255 }),
  /** Email address (for logging/debugging) */
  email: varchar('email', { length: 255 }).notNull(),
  /** When the grant was issued */
  grantedAt: timestamp('granted_at').notNull().defaultNow(),
  /** Reference to the credit transaction */
  transactionId: uuid('transaction_id').references(() => creditTransactions.id, { onDelete: 'set null' }),
}, (table) => ({
  ipAddressIdx: index('signup_grants_ip_address_idx').on(table.ipAddress),
  deviceFingerprintIdx: index('signup_grants_device_fingerprint_idx').on(table.deviceFingerprint),
}));

export type SignupGrant = typeof signupGrants.$inferSelect;
export type NewSignupGrant = typeof signupGrants.$inferInsert;

/**
 * Relations
 */
export const usersRelations = relations(users, ({ many }) => ({
  oauthAccounts: many(oauthAccounts),
  refreshTokens: many(refreshTokens),
  platformConnections: many(platformConnections),
  jobs: many(jobs),
  creditTransactions: many(creditTransactions),
  signupGrant: many(signupGrants),
}));

export const oauthAccountsRelations = relations(oauthAccounts, ({ one }) => ({
  user: one(users, {
    fields: [oauthAccounts.userId],
    references: [users.id],
  }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

export const platformConnectionsRelations = relations(platformConnections, ({ one, many }) => ({
  user: one(users, {
    fields: [platformConnections.userId],
    references: [users.id],
  }),
  listings: many(platformListings),
}));

export const platformListingsRelations = relations(platformListings, ({ one }) => ({
  connection: one(platformConnections, {
    fields: [platformListings.connectionId],
    references: [platformConnections.id],
  }),
  job: one(jobs, {
    fields: [platformListings.jobId],
    references: [jobs.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ many }) => ({
  jobs: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  apiKey: one(apiKeys, {
    fields: [jobs.apiKeyId],
    references: [apiKeys.id],
  }),
  user: one(users, {
    fields: [jobs.userId],
    references: [users.id],
  }),
  video: one(videos, {
    fields: [jobs.id],
    references: [videos.jobId],
  }),
  frames: many(frames),
  commercialImages: many(commercialImages),
  platformListings: many(platformListings),
}));

export const videosRelations = relations(videos, ({ one, many }) => ({
  job: one(jobs, {
    fields: [videos.jobId],
    references: [jobs.id],
  }),
  frames: many(frames),
}));

export const framesRelations = relations(frames, ({ one, many }) => ({
  job: one(jobs, {
    fields: [frames.jobId],
    references: [jobs.id],
  }),
  video: one(videos, {
    fields: [frames.videoId],
    references: [videos.id],
  }),
  commercialImages: many(commercialImages),
}));

export const commercialImagesRelations = relations(commercialImages, ({ one }) => ({
  job: one(jobs, {
    fields: [commercialImages.jobId],
    references: [jobs.id],
  }),
  frame: one(frames, {
    fields: [commercialImages.frameId],
    references: [frames.id],
  }),
}));

export const creditTransactionsRelations = relations(creditTransactions, ({ one }) => ({
  user: one(users, {
    fields: [creditTransactions.userId],
    references: [users.id],
  }),
  job: one(jobs, {
    fields: [creditTransactions.jobId],
    references: [jobs.id],
  }),
}));

export const signupGrantsRelations = relations(signupGrants, ({ one }) => ({
  user: one(users, {
    fields: [signupGrants.userId],
    references: [users.id],
  }),
  transaction: one(creditTransactions, {
    fields: [signupGrants.transactionId],
    references: [creditTransactions.id],
  }),
}));

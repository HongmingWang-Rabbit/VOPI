/**
 * Seed script for credit system
 *
 * Run with: npx tsx src/db/seed-credits.ts
 *
 * This script:
 * 1. Creates default pricing configuration in global_config
 * 2. Optionally creates a test user with credits (if TEST_USER_EMAIL is set)
 */

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { initDatabase, getDatabase, schema } from './index.js';
import { DEFAULT_PRICING_CONFIG, SIGNUP_GRANT_CREDITS, CreditTransactionType } from '../types/credits.types.js';
import { ConfigValueType, ConfigCategory, type GlobalConfigValue } from '../types/config.types.js';

async function seedPricingConfig() {
  const db = getDatabase();

  console.log('Seeding pricing configuration...');

  // Pricing config keys to seed
  const pricingConfigs: Array<{
    key: string;
    value: GlobalConfigValue;
    category: string;
    description: string;
  }> = [
    {
      key: 'pricing.baseCredits',
      value: { value: DEFAULT_PRICING_CONFIG.baseCredits, type: ConfigValueType.NUMBER },
      category: ConfigCategory.PRICING,
      description: 'Base cost per job in credits',
    },
    {
      key: 'pricing.creditsPerSecond',
      value: { value: DEFAULT_PRICING_CONFIG.creditsPerSecond, type: ConfigValueType.NUMBER },
      category: ConfigCategory.PRICING,
      description: 'Additional credits per second of video duration',
    },
    {
      key: 'pricing.includedFrames',
      value: { value: DEFAULT_PRICING_CONFIG.includedFrames, type: ConfigValueType.NUMBER },
      category: ConfigCategory.PRICING,
      description: 'Number of frames included in base price',
    },
    {
      key: 'pricing.extraFrameCost',
      value: { value: DEFAULT_PRICING_CONFIG.extraFrameCost, type: ConfigValueType.NUMBER },
      category: ConfigCategory.PRICING,
      description: 'Cost per extra frame beyond included amount',
    },
    {
      key: 'pricing.commercialVideoEnabled',
      value: { value: DEFAULT_PRICING_CONFIG.commercialVideoEnabled, type: ConfigValueType.BOOLEAN },
      category: ConfigCategory.PRICING,
      description: 'Whether commercial video generation add-on is enabled',
    },
    {
      key: 'pricing.commercialVideoCost',
      value: { value: DEFAULT_PRICING_CONFIG.commercialVideoCost, type: ConfigValueType.NUMBER },
      category: ConfigCategory.PRICING,
      description: 'Cost for commercial video generation (when enabled)',
    },
    {
      key: 'pricing.minJobCost',
      value: { value: DEFAULT_PRICING_CONFIG.minJobCost, type: ConfigValueType.NUMBER },
      category: ConfigCategory.PRICING,
      description: 'Minimum job cost (floor)',
    },
    {
      key: 'pricing.maxJobCost',
      value: { value: DEFAULT_PRICING_CONFIG.maxJobCost, type: ConfigValueType.NUMBER },
      category: ConfigCategory.PRICING,
      description: 'Maximum job cost (ceiling, 0 = no limit)',
    },
  ];

  for (const config of pricingConfigs) {
    // Check if config already exists
    const [existing] = await db
      .select()
      .from(schema.globalConfig)
      .where(eq(schema.globalConfig.key, config.key))
      .limit(1);

    if (existing) {
      console.log(`  - ${config.key}: already exists (skipping)`);
      continue;
    }

    await db.insert(schema.globalConfig).values({
      key: config.key,
      value: config.value,
      category: config.category,
      description: config.description,
      isActive: true,
    });

    console.log(`  - ${config.key}: ${JSON.stringify(config.value.value)}`);
  }

  console.log('Pricing configuration seeded successfully!');
}

async function seedTestUser() {
  const testEmail = process.env.TEST_USER_EMAIL;

  if (!testEmail) {
    console.log('\nNo TEST_USER_EMAIL set, skipping test user creation.');
    console.log('To create a test user, run:');
    console.log('  TEST_USER_EMAIL=test@example.com pnpm db:seed');
    return;
  }

  const db = getDatabase();
  console.log(`\nSeeding test user: ${testEmail}...`);

  // Check if user already exists
  const [existingUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, testEmail))
    .limit(1);

  let userId: string;

  if (existingUser) {
    console.log(`  - User already exists: ${existingUser.id}`);
    userId = existingUser.id;
  } else {
    // Create user
    const [newUser] = await db
      .insert(schema.users)
      .values({
        email: testEmail,
        emailVerified: true,
        name: 'Test User',
        creditsBalance: 0,
      })
      .returning();

    userId = newUser.id;
    console.log(`  - Created user: ${userId}`);
  }

  // Check if user already has signup grant
  const [existingGrant] = await db
    .select()
    .from(schema.signupGrants)
    .where(eq(schema.signupGrants.userId, userId))
    .limit(1);

  if (existingGrant) {
    console.log('  - Signup grant already exists (skipping)');
  } else {
    // Grant signup credits
    const idempotencyKey = `signup_grant:${userId}`;

    const [transaction] = await db
      .insert(schema.creditTransactions)
      .values({
        userId,
        creditsDelta: SIGNUP_GRANT_CREDITS,
        type: CreditTransactionType.SIGNUP_GRANT,
        idempotencyKey,
        description: `Welcome bonus: ${SIGNUP_GRANT_CREDITS} free credits`,
        metadata: { email: testEmail, seeded: true },
      })
      .returning();

    await db.insert(schema.signupGrants).values({
      userId,
      email: testEmail,
      ipAddress: '127.0.0.1',
      transactionId: transaction.id,
    });

    // Update cached balance
    await db
      .update(schema.users)
      .set({ creditsBalance: SIGNUP_GRANT_CREDITS })
      .where(eq(schema.users.id, userId));

    console.log(`  - Granted ${SIGNUP_GRANT_CREDITS} signup credits`);
  }

  // Optionally add bonus credits for testing
  const bonusCredits = parseInt(process.env.TEST_BONUS_CREDITS || '0', 10);

  if (bonusCredits > 0) {
    const bonusIdempotencyKey = `seed_bonus:${userId}:${Date.now()}`;

    await db.insert(schema.creditTransactions).values({
      userId,
      creditsDelta: bonusCredits,
      type: CreditTransactionType.ADMIN_ADJUSTMENT,
      idempotencyKey: bonusIdempotencyKey,
      description: `Seed bonus: ${bonusCredits} credits`,
      metadata: { reason: 'seed_script', seeded: true },
    });

    // Update cached balance
    const [user] = await db
      .select({ balance: schema.users.creditsBalance })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    await db
      .update(schema.users)
      .set({ creditsBalance: (user?.balance || 0) + bonusCredits })
      .where(eq(schema.users.id, userId));

    console.log(`  - Added ${bonusCredits} bonus credits`);
  }

  // Show final balance
  const [finalUser] = await db
    .select({ email: schema.users.email, balance: schema.users.creditsBalance })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  console.log(`\nTest user ready:`);
  console.log(`  Email: ${finalUser?.email}`);
  console.log(`  Balance: ${finalUser?.balance} credits`);
}

async function main() {
  console.log('=== VOPI Credit System Seed Script ===\n');

  try {
    // Initialize database connection
    console.log('Connecting to database...');
    await initDatabase();
    console.log('Connected!\n');

    await seedPricingConfig();
    await seedTestUser();

    console.log('\n=== Seed completed successfully! ===');
    process.exit(0);
  } catch (error) {
    console.error('\nSeed failed:', error);
    process.exit(1);
  }
}

main();

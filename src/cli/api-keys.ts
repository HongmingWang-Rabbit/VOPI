#!/usr/bin/env node
/**
 * CLI for API Key Management
 *
 * Usage:
 *   npx tsx src/cli/api-keys.ts create [--name "Key Name"] [--max-uses 10] [--expires "2025-12-31"]
 *   npx tsx src/cli/api-keys.ts list [--all]
 *   npx tsx src/cli/api-keys.ts revoke <key-id>
 *   npx tsx src/cli/api-keys.ts info <key-id>
 */

// Load environment variables from .env file
import 'dotenv/config';

import { randomBytes } from 'crypto';
import { eq, isNull, and, or, gt } from 'drizzle-orm';
import { initDatabase, getDatabase, schema } from '../db/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  console.log(`
API Key Management CLI

Usage:
  npx tsx src/cli/api-keys.ts <command> [options]

Commands:
  create    Create a new API key
  list      List API keys
  revoke    Revoke an API key
  info      Get API key details

Options for 'create':
  --name <name>       Optional name/description for the key
  --max-uses <n>      Maximum number of job creations (default: 10, 0 = unlimited)
  --unlimited         Create key with no usage limit (same as --max-uses 0)
  --expires <date>    Expiration date (ISO format, e.g., 2025-12-31)
  --quiet             Only output the API key value (for scripting)

Options for 'list':
  --all               Include revoked and expired keys

Options for 'revoke':
  <key-id>            UUID of the key to revoke

Options for 'info':
  <key-id>            UUID of the key to get info about

Examples:
  npx tsx src/cli/api-keys.ts create --name "John's Beta Access" --max-uses 20
  npx tsx src/cli/api-keys.ts create --name "Master Key" --unlimited
  npx tsx src/cli/api-keys.ts list
  npx tsx src/cli/api-keys.ts list --all
  npx tsx src/cli/api-keys.ts revoke 550e8400-e29b-41d4-a716-446655440000
  npx tsx src/cli/api-keys.ts info 550e8400-e29b-41d4-a716-446655440000
`);
}

function parseArgs(
  args: string[]
): Record<string, string | boolean | undefined> {
  const result: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      // Check if next arg exists and is not a flag
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        result[key] = args[i + 1];
        i++;
      } else {
        result[key] = true;
      }
    } else if (!args[i].startsWith('-')) {
      result['_positional'] = args[i];
    }
  }
  return result;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, paramName: string): void {
  if (!UUID_REGEX.test(value)) {
    console.error(`\nError: ${paramName} must be a valid UUID.\n`);
    console.error(`Received: ${value}\n`);
    process.exit(1);
  }
}

function generateApiKey(): string {
  // Generate a secure 32-byte random key, encode as base64url
  return randomBytes(32).toString('base64url');
}

/** Value used in database to represent unlimited usage (max safe integer) */
const UNLIMITED_USES = Number.MAX_SAFE_INTEGER;

async function createKey(options: Record<string, string | boolean | undefined>): Promise<void> {
  const db = getDatabase();

  const name = options['name'] as string | undefined;
  const unlimited = options['unlimited'] === true;
  const quiet = options['quiet'] === true;
  const expiresAt = options['expires']
    ? new Date(options['expires'] as string)
    : null;

  // Handle --unlimited flag or --max-uses 0
  let maxUses: number;
  if (unlimited) {
    maxUses = UNLIMITED_USES;
  } else if (options['max-uses'] !== undefined) {
    const parsed = parseInt(options['max-uses'] as string, 10);
    if (isNaN(parsed) || parsed < 0) {
      console.error('Error: --max-uses must be a non-negative integer (0 = unlimited)');
      process.exit(1);
    }
    maxUses = parsed === 0 ? UNLIMITED_USES : parsed;
  } else {
    maxUses = 10; // Default
  }

  if (expiresAt && isNaN(expiresAt.getTime())) {
    console.error('Error: --expires must be a valid date');
    process.exit(1);
  }

  const key = generateApiKey();

  const [created] = await db
    .insert(schema.apiKeys)
    .values({
      key,
      name,
      maxUses,
      expiresAt,
    })
    .returning();

  if (quiet) {
    // Only output the key value for scripting/piping
    console.log(created.key);
  } else {
    const maxUsesDisplay = created.maxUses >= UNLIMITED_USES ? 'Unlimited' : String(created.maxUses);
    console.log('\n✓ API Key Created\n');
    console.log('Key Details:');
    console.log(`  ID:        ${created.id}`);
    console.log(`  Key:       ${created.key}`);
    console.log(`  Name:      ${created.name || '(none)'}`);
    console.log(`  Max Uses:  ${maxUsesDisplay}`);
    console.log(`  Expires:   ${created.expiresAt?.toISOString() || 'Never'}`);
    console.log(`  Created:   ${created.createdAt.toISOString()}`);
    console.log('\n⚠️  Save this key securely - it cannot be retrieved later!\n');
  }
}

async function listKeys(options: Record<string, string | boolean | undefined>): Promise<void> {
  const db = getDatabase();
  const showAll = options['all'] === true;
  const now = new Date();

  let query = db.select().from(schema.apiKeys);

  if (!showAll) {
    // Only show active keys (not revoked and not expired)
    query = query.where(
      and(
        isNull(schema.apiKeys.revokedAt),
        or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, now))
      )
    ) as typeof query;
  }

  const keys = await query.orderBy(schema.apiKeys.createdAt);

  if (keys.length === 0) {
    console.log('\nNo API keys found.\n');
    return;
  }

  console.log(`\nAPI Keys (${keys.length} total):\n`);
  console.log(
    'ID'.padEnd(38) +
      'Name'.padEnd(25) +
      'Usage'.padEnd(12) +
      'Status'.padEnd(12) +
      'Created'
  );
  console.log('-'.repeat(100));

  for (const key of keys) {
    const status = key.revokedAt
      ? 'Revoked'
      : key.expiresAt && key.expiresAt < now
        ? 'Expired'
        : 'Active';
    const isUnlimited = key.maxUses >= UNLIMITED_USES;
    const usage = isUnlimited ? `${key.usedCount}/∞` : `${key.usedCount}/${key.maxUses}`;
    const name = key.name || '(unnamed)';

    console.log(
      key.id.padEnd(38) +
        name.slice(0, 23).padEnd(25) +
        usage.padEnd(12) +
        status.padEnd(12) +
        key.createdAt.toISOString().slice(0, 10)
    );
  }
  console.log('');
}

async function revokeKey(keyId: string): Promise<void> {
  const db = getDatabase();

  // Check if key exists
  const [existing] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, keyId))
    .limit(1);

  if (!existing) {
    console.error(`\nError: API key with ID '${keyId}' not found.\n`);
    process.exit(1);
  }

  if (existing.revokedAt) {
    console.log(`\nAPI key '${keyId}' is already revoked.\n`);
    return;
  }

  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, keyId));

  console.log(`\n✓ API key '${keyId}' has been revoked.\n`);
}

async function getKeyInfo(keyId: string): Promise<void> {
  const db = getDatabase();

  const [key] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, keyId))
    .limit(1);

  if (!key) {
    console.error(`\nError: API key with ID '${keyId}' not found.\n`);
    process.exit(1);
  }

  const now = new Date();
  const status = key.revokedAt
    ? 'Revoked'
    : key.expiresAt && key.expiresAt < now
      ? 'Expired'
      : 'Active';

  const isUnlimited = key.maxUses >= UNLIMITED_USES;
  const maxUsesDisplay = isUnlimited ? 'Unlimited' : String(key.maxUses);
  const remainingDisplay = isUnlimited ? 'Unlimited' : String(Math.max(0, key.maxUses - key.usedCount));

  console.log('\nAPI Key Details:\n');
  console.log(`  ID:         ${key.id}`);
  console.log(`  Name:       ${key.name || '(none)'}`);
  console.log(`  Status:     ${status}`);
  console.log(`  Usage:      ${key.usedCount} / ${maxUsesDisplay}`);
  console.log(`  Remaining:  ${remainingDisplay}`);
  console.log(`  Created:    ${key.createdAt.toISOString()}`);
  console.log(`  Expires:    ${key.expiresAt?.toISOString() || 'Never'}`);
  console.log(`  Revoked:    ${key.revokedAt?.toISOString() || 'No'}`);
  console.log('');
}

async function main(): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  // Initialize database
  await initDatabase();

  const options = parseArgs(args.slice(1));

  switch (command) {
    case 'create':
      await createKey(options);
      break;
    case 'list':
      await listKeys(options);
      break;
    case 'revoke': {
      const keyId = options['_positional'] as string;
      if (!keyId) {
        console.error('\nError: Please provide the key ID to revoke.\n');
        console.error('Usage: npx tsx src/cli/api-keys.ts revoke <key-id>\n');
        process.exit(1);
      }
      validateUuid(keyId, 'key-id');
      await revokeKey(keyId);
      break;
    }
    case 'info': {
      const infoKeyId = options['_positional'] as string;
      if (!infoKeyId) {
        console.error('\nError: Please provide the key ID.\n');
        console.error('Usage: npx tsx src/cli/api-keys.ts info <key-id>\n');
        process.exit(1);
      }
      validateUuid(infoKeyId, 'key-id');
      await getKeyInfo(infoKeyId);
      break;
    }
    default:
      console.error(`\nUnknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });

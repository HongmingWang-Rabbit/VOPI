/**
 * Seed script for global configuration
 *
 * Run with: pnpm db:seed:config
 *
 * This script seeds all default configuration values from DEFAULT_CONFIG
 * into the global_config table. It only inserts missing keys - existing
 * values are not overwritten.
 */

import 'dotenv/config';
import { initDatabase } from './index.js';
import { globalConfigService } from '../services/global-config.service.js';
import { DEFAULT_CONFIG } from '../types/config.types.js';

async function main() {
  console.log('=== VOPI Global Config Seed Script ===\n');

  try {
    // Initialize database connection
    console.log('Connecting to database...');
    await initDatabase();
    console.log('Connected!\n');

    // Show what will be seeded
    console.log(`Default config keys (${Object.keys(DEFAULT_CONFIG).length} total):`);
    for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
      console.log(`  - ${key}: ${JSON.stringify(def.value)} (${def.type})`);
    }
    console.log('');

    // Seed defaults
    console.log('Seeding missing config values...');
    const seededCount = await globalConfigService.seedDefaults();

    if (seededCount > 0) {
      console.log(`\nSeeded ${seededCount} new config value(s).`);
    } else {
      console.log('\nAll config values already exist in database.');
    }

    // Show current config
    console.log('\n--- Current Global Config ---');
    const allConfig = await globalConfigService.getAllConfigWithMetadata();
    for (const config of allConfig) {
      const source = config.isDefault ? '(default)' : '(database)';
      console.log(`  ${config.key}: ${JSON.stringify(config.value)} ${source}`);
    }

    console.log('\n=== Seed completed successfully! ===');
    process.exit(0);
  } catch (error) {
    console.error('\nSeed failed:', error);
    process.exit(1);
  }
}

main();

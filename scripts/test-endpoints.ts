#!/usr/bin/env tsx
/**
 * Manual endpoint testing script
 * Tests all OAuth, Auth, and Credits endpoints using .env configuration
 *
 * Usage: pnpm tsx scripts/test-endpoints.ts
 */

import 'dotenv/config';

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const API_KEY = process.env.API_KEYS?.split(',')[0] || '';

interface TestResult {
  name: string;
  endpoint: string;
  status: 'pass' | 'fail' | 'skip';
  statusCode?: number;
  message?: string;
  data?: unknown;
}

const results: TestResult[] = [];

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testEndpoint(
  name: string,
  endpoint: string,
  options: RequestInit = {},
  expectedStatus?: number | number[]
): Promise<TestResult> {
  const url = `${BASE_URL}${endpoint}`;
  log(`\n  Testing: ${name}`, 'cyan');
  log(`  ${options.method || 'GET'} ${endpoint}`, 'dim');

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const data = await response.json().catch(() => null);
    const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus || 200];
    const isExpectedStatus = expectedStatuses.includes(response.status);

    const result: TestResult = {
      name,
      endpoint,
      status: isExpectedStatus ? 'pass' : 'fail',
      statusCode: response.status,
      data,
    };

    if (isExpectedStatus) {
      log(`  ✓ Status: ${response.status}`, 'green');
    } else {
      log(`  ✗ Status: ${response.status} (expected: ${expectedStatuses.join(' or ')})`, 'red');
      result.message = `Unexpected status: ${response.status}`;
    }

    if (data) {
      log(`  Response: ${JSON.stringify(data, null, 2).split('\n').slice(0, 10).join('\n')}`, 'dim');
    }

    results.push(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log(`  ✗ Error: ${message}`, 'red');
    const result: TestResult = {
      name,
      endpoint,
      status: 'fail',
      message,
    };
    results.push(result);
    return result;
  }
}

function skipTest(name: string, endpoint: string, reason: string): TestResult {
  log(`\n  Skipping: ${name}`, 'yellow');
  log(`  Reason: ${reason}`, 'dim');
  const result: TestResult = {
    name,
    endpoint,
    status: 'skip',
    message: reason,
  };
  results.push(result);
  return result;
}

async function main() {
  log('\n' + '='.repeat(60), 'blue');
  log('  VOPI Endpoint Test Script', 'blue');
  log('='.repeat(60), 'blue');
  log(`\nBase URL: ${BASE_URL}`);
  log(`API Key: ${API_KEY ? API_KEY.slice(0, 8) + '...' : '(not set)'}`);

  // ==========================================================================
  // Health & Status Endpoints (No Auth)
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  Health & Status Endpoints', 'blue');
  log('-'.repeat(60), 'blue');

  await testEndpoint('Health Check', '/health');
  await testEndpoint('Ready Check', '/ready');

  // ==========================================================================
  // Auth Provider Endpoints (No Auth Required)
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  Auth Provider Endpoints', 'blue');
  log('-'.repeat(60), 'blue');

  await testEndpoint('Get Available OAuth Providers', '/api/v1/auth/providers');

  // ==========================================================================
  // Credits Endpoints (Public)
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  Credits Endpoints (Public)', 'blue');
  log('-'.repeat(60), 'blue');

  await testEndpoint('Get Credit Packs', '/api/v1/credits/packs');
  await testEndpoint('Get Pricing Config', '/api/v1/credits/pricing');

  await testEndpoint(
    'Estimate Job Cost (30s video)',
    '/api/v1/credits/estimate',
    {
      method: 'POST',
      body: JSON.stringify({
        videoDurationSeconds: 30,
        frameCount: 4,
      }),
    }
  );

  await testEndpoint(
    'Estimate Job Cost (5min video with add-ons)',
    '/api/v1/credits/estimate',
    {
      method: 'POST',
      body: JSON.stringify({
        videoDurationSeconds: 300,
        frameCount: 8,
        addOns: ['extra_frames'],
      }),
    }
  );

  // ==========================================================================
  // OAuth Init Endpoints (No Auth, but needs provider config)
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  OAuth Init Endpoints', 'blue');
  log('-'.repeat(60), 'blue');

  const testRedirectUri = 'https://example.com/callback';

  if (process.env.GOOGLE_CLIENT_ID) {
    await testEndpoint(
      'Init Google OAuth',
      '/api/v1/auth/oauth/init',
      {
        method: 'POST',
        body: JSON.stringify({
          provider: 'google',
          redirectUri: testRedirectUri,
        }),
      }
    );
  } else {
    skipTest('Init Google OAuth', '/api/v1/auth/oauth/init', 'GOOGLE_CLIENT_ID not set');
  }

  if (process.env.APPLE_CLIENT_ID) {
    await testEndpoint(
      'Init Apple OAuth',
      '/api/v1/auth/oauth/init',
      {
        method: 'POST',
        body: JSON.stringify({
          provider: 'apple',
          redirectUri: testRedirectUri,
        }),
      }
    );
  } else {
    skipTest('Init Apple OAuth', '/api/v1/auth/oauth/init', 'APPLE_CLIENT_ID not set');
  }

  // ==========================================================================
  // Protected Endpoints (Require Auth - will fail without valid token)
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  Protected Endpoints (API Key Auth)', 'blue');
  log('-'.repeat(60), 'blue');

  if (API_KEY) {
    // These require API key auth
    await testEndpoint(
      'Get Global Config (Admin)',
      '/api/v1/config',
      {
        headers: { 'x-api-key': API_KEY },
      },
      [200, 403] // 403 if not admin key
    );
  } else {
    skipTest('Protected Endpoints', '/api/v1/*', 'API_KEYS not set in .env');
  }

  // ==========================================================================
  // User Auth Protected Endpoints (Require JWT - expected to fail)
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  User Auth Endpoints (Expected 401 without JWT)', 'blue');
  log('-'.repeat(60), 'blue');

  await testEndpoint(
    'Get Current User (no auth)',
    '/api/v1/auth/me',
    {},
    401
  );

  await testEndpoint(
    'Get Credit Balance (no auth)',
    '/api/v1/credits/balance',
    {},
    401
  );

  await testEndpoint(
    'Create Checkout Session (no auth)',
    '/api/v1/credits/checkout',
    {
      method: 'POST',
      body: JSON.stringify({
        packType: 'PACK_20',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      }),
    },
    401
  );

  // ==========================================================================
  // E-Commerce OAuth Endpoints
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  E-Commerce OAuth Endpoints', 'blue');
  log('-'.repeat(60), 'blue');

  if (process.env.SHOPIFY_API_KEY) {
    await testEndpoint(
      'Shopify OAuth Authorize (missing shop param)',
      '/api/v1/oauth/shopify/authorize',
      {},
      400 // Expected to fail without shop param
    );
  } else {
    skipTest('Shopify OAuth', '/api/v1/oauth/shopify/*', 'SHOPIFY_API_KEY not set');
  }

  if (process.env.AMAZON_CLIENT_ID) {
    await testEndpoint(
      'Amazon OAuth Authorize (no auth)',
      '/api/v1/oauth/amazon/authorize',
      {},
      401 // Requires user auth
    );
  } else {
    skipTest('Amazon OAuth', '/api/v1/oauth/amazon/*', 'AMAZON_CLIENT_ID not set');
  }

  // eBay is not set up per user request
  skipTest('eBay OAuth', '/api/v1/oauth/ebay/*', 'EBAY credentials not set (as requested)');

  // ==========================================================================
  // Stripe Webhook Test
  // ==========================================================================
  log('\n' + '-'.repeat(60), 'blue');
  log('  Stripe Webhook Endpoint', 'blue');
  log('-'.repeat(60), 'blue');

  if (process.env.STRIPE_WEBHOOK_SECRET) {
    await testEndpoint(
      'Stripe Webhook (no signature - expected 400)',
      '/api/v1/credits/webhook',
      {
        method: 'POST',
        body: JSON.stringify({ type: 'test' }),
      },
      400 // Expected to fail without valid signature
    );
  } else {
    skipTest('Stripe Webhook', '/api/v1/credits/webhook', 'STRIPE_WEBHOOK_SECRET not set');
  }

  // ==========================================================================
  // Summary
  // ==========================================================================
  log('\n' + '='.repeat(60), 'blue');
  log('  Test Summary', 'blue');
  log('='.repeat(60), 'blue');

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  log(`\n  ${colors.green}Passed:  ${passed}${colors.reset}`);
  log(`  ${colors.red}Failed:  ${failed}${colors.reset}`);
  log(`  ${colors.yellow}Skipped: ${skipped}${colors.reset}`);
  log(`  Total:   ${results.length}\n`);

  if (failed > 0) {
    log('Failed Tests:', 'red');
    results
      .filter(r => r.status === 'fail')
      .forEach(r => {
        log(`  - ${r.name}: ${r.message || `Status ${r.statusCode}`}`, 'red');
      });
    log('');
  }

  // Configuration Status
  log('-'.repeat(60), 'blue');
  log('  Configuration Status', 'blue');
  log('-'.repeat(60), 'blue');

  const configs = [
    { name: 'Google OAuth', set: !!process.env.GOOGLE_CLIENT_ID },
    { name: 'Apple OAuth', set: !!process.env.APPLE_CLIENT_ID },
    { name: 'JWT Auth', set: !!process.env.JWT_SECRET },
    { name: 'Stripe', set: !!process.env.STRIPE_SECRET_KEY },
    { name: 'Stripe Webhook', set: !!process.env.STRIPE_WEBHOOK_SECRET },
    { name: 'Shopify', set: !!process.env.SHOPIFY_API_KEY },
    { name: 'Amazon', set: !!process.env.AMAZON_CLIENT_ID },
    { name: 'eBay', set: !!process.env.EBAY_CLIENT_ID },
    { name: 'Token Encryption', set: !!process.env.TOKEN_ENCRYPTION_KEY },
  ];

  configs.forEach(c => {
    const status = c.set ? `${colors.green}✓ Configured${colors.reset}` : `${colors.yellow}○ Not set${colors.reset}`;
    console.log(`  ${c.name.padEnd(20)} ${status}`);
  });

  log('\n');

  // Exit with error code if any tests failed unexpectedly
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Script error:', error);
  process.exit(1);
});

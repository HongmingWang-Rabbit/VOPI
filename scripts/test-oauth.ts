#!/usr/bin/env tsx
/**
 * Interactive OAuth Testing Script
 * Tests OAuth flows step-by-step with manual verification
 *
 * Usage: pnpm test:oauth
 */

import 'dotenv/config';
import { select, input, confirm } from '@inquirer/prompts';
import { createServer } from 'http';
import { URL } from 'url';

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const API_KEY = process.env.API_KEYS?.split(',')[0] || '';
const CALLBACK_PORT = 3001;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step: number, message: string) {
  log(`\n${colors.bold}Step ${step}:${colors.reset} ${message}`, 'cyan');
}

function logSuccess(message: string) {
  log(`  ✓ ${message}`, 'green');
}

function logError(message: string) {
  log(`  ✗ ${message}`, 'red');
}

function logInfo(message: string) {
  log(`  ${message}`, 'dim');
}

interface OAuthProvider {
  name: string;
  key: string;
  configured: boolean;
  requiresUserAuth: boolean;
  extraParams?: () => Promise<Record<string, string>>;
}

async function checkProviderConfig(): Promise<OAuthProvider[]> {
  const providers: OAuthProvider[] = [
    {
      name: 'Google',
      key: 'google',
      configured: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
      requiresUserAuth: false,
    },
    {
      name: 'Apple',
      key: 'apple',
      configured: !!process.env.APPLE_CLIENT_ID && !!process.env.APPLE_PRIVATE_KEY,
      requiresUserAuth: false,
    },
    {
      name: 'Shopify',
      key: 'shopify',
      configured: !!process.env.SHOPIFY_API_KEY && !!process.env.SHOPIFY_API_SECRET,
      requiresUserAuth: false,
      extraParams: async () => {
        const shop = await input({
          message: 'Enter your Shopify shop domain (e.g., mystore.myshopify.com):',
          validate: (value) => {
            if (!value.includes('.myshopify.com') && !value.includes('.')) {
              return 'Please enter a valid shop domain';
            }
            return true;
          },
        });
        return { shop };
      },
    },
    {
      name: 'Amazon',
      key: 'amazon',
      configured: !!process.env.AMAZON_CLIENT_ID && !!process.env.AMAZON_CLIENT_SECRET,
      requiresUserAuth: true,
    },
    {
      name: 'eBay',
      key: 'ebay',
      configured: !!process.env.EBAY_CLIENT_ID && !!process.env.EBAY_CLIENT_SECRET,
      requiresUserAuth: false,
    },
  ];

  return providers;
}

async function startCallbackServer(): Promise<{ code: string; state: string; error?: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);

      // Handle GET callbacks (Google, Shopify, Amazon, eBay)
      if (req.method === 'GET' && url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        res.writeHead(200, { 'Content-Type': 'text/html' });

        if (error) {
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #dc3545;">OAuth Error</h1>
                <p><strong>Error:</strong> ${error}</p>
                <p><strong>Description:</strong> ${errorDescription || 'No description'}</p>
                <p style="color: #666;">You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          resolve({ code: '', state: state || '', error: errorDescription || error });
        } else if (code) {
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #28a745;">OAuth Success!</h1>
                <p>Authorization code received.</p>
                <p style="color: #666;">You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);
          server.close();
          resolve({ code, state: state || '' });
        } else {
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #ffc107;">Missing Code</h1>
                <p>No authorization code received.</p>
              </body>
            </html>
          `);
        }
        return;
      }

      // Handle POST callbacks (Apple)
      if (req.method === 'POST' && url.pathname === '/callback') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const code = params.get('code');
          const state = params.get('state');
          const error = params.get('error');
          const idToken = params.get('id_token');
          const user = params.get('user'); // Apple sends user info on first auth

          res.writeHead(200, { 'Content-Type': 'text/html' });

          if (error) {
            res.end(`
              <html>
                <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                  <h1 style="color: #dc3545;">OAuth Error</h1>
                  <p><strong>Error:</strong> ${error}</p>
                  <p style="color: #666;">You can close this window.</p>
                </body>
              </html>
            `);
            server.close();
            resolve({ code: '', state: state || '', error });
          } else if (code) {
            res.end(`
              <html>
                <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                  <h1 style="color: #28a745;">Apple OAuth Success!</h1>
                  <p>Authorization code received.</p>
                  ${idToken ? '<p>ID Token received.</p>' : ''}
                  ${user ? '<p>User info received.</p>' : ''}
                  <p style="color: #666;">You can close this window and return to the terminal.</p>
                </body>
              </html>
            `);
            server.close();
            resolve({ code, state: state || '' });
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(CALLBACK_PORT, () => {
      logInfo(`Callback server listening on port ${CALLBACK_PORT}`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      resolve({ code: '', state: '', error: 'Timeout waiting for callback' });
    }, 5 * 60 * 1000);
  });
}

async function testGoogleOAuth(): Promise<void> {
  log('\n' + '='.repeat(60), 'blue');
  log('  Testing Google OAuth Flow', 'blue');
  log('='.repeat(60), 'blue');

  // Step 1: Initialize OAuth
  logStep(1, 'Initialize OAuth flow');

  const initResponse = await fetch(`${BASE_URL}/api/v1/auth/oauth/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      redirectUri: CALLBACK_URL,
    }),
  });

  if (!initResponse.ok) {
    const error = await initResponse.json();
    logError(`Failed to initialize: ${error.message}`);
    return;
  }

  const { authorizationUrl, state, codeVerifier } = await initResponse.json();
  logSuccess('OAuth initialized');
  logInfo(`State: ${state}`);
  if (codeVerifier) {
    logInfo(`Code verifier received (PKCE enabled)`);
  }

  // Step 2: Open browser
  logStep(2, 'Open authorization URL in browser');
  log(`\n  ${colors.yellow}Please open this URL in your browser:${colors.reset}`);
  log(`\n  ${authorizationUrl}\n`, 'cyan');

  const shouldOpen = await confirm({
    message: 'Press Enter when ready to start listening for callback...',
    default: true,
  });

  if (!shouldOpen) {
    log('Cancelled by user', 'yellow');
    return;
  }

  // Step 3: Wait for callback
  logStep(3, 'Waiting for OAuth callback...');
  logInfo('Complete the Google login in your browser');

  const callbackResult = await startCallbackServer();

  if (callbackResult.error) {
    logError(`OAuth error: ${callbackResult.error}`);
    return;
  }

  if (!callbackResult.code) {
    logError('No authorization code received');
    return;
  }

  logSuccess('Authorization code received');
  logInfo(`Code: ${callbackResult.code.substring(0, 20)}...`);

  // Step 4: Exchange code for tokens
  logStep(4, 'Exchange code for tokens');

  const callbackResponse = await fetch(`${BASE_URL}/api/v1/auth/oauth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      code: callbackResult.code,
      state: callbackResult.state,
      redirectUri: CALLBACK_URL,
      codeVerifier, // Include PKCE code verifier
    }),
  });

  if (!callbackResponse.ok) {
    const error = await callbackResponse.json();
    logError(`Token exchange failed: ${error.message}`);
    logInfo(`Full error: ${JSON.stringify(error, null, 2)}`);
    return;
  }

  const tokens = await callbackResponse.json();
  logSuccess('Tokens received!');
  logInfo(`Access token: ${tokens.accessToken?.substring(0, 30)}...`);
  logInfo(`Refresh token: ${tokens.refreshToken ? 'Yes' : 'No'}`);
  logInfo(`User ID: ${tokens.user?.id}`);
  logInfo(`Email: ${tokens.user?.email}`);

  // Step 5: Verify token works
  logStep(5, 'Verify token by fetching user profile');

  const meResponse = await fetch(`${BASE_URL}/api/v1/auth/me`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
    },
  });

  if (meResponse.ok) {
    const user = await meResponse.json();
    logSuccess('Token verified!');
    logInfo(`User: ${JSON.stringify(user, null, 2)}`);
  } else {
    const error = await meResponse.json();
    logError(`Token verification failed: ${error.message}`);
  }

  log('\n' + '='.repeat(60), 'green');
  log('  Google OAuth Test Complete!', 'green');
  log('='.repeat(60), 'green');
}

async function testAppleOAuth(): Promise<void> {
  log('\n' + '='.repeat(60), 'blue');
  log('  Testing Apple OAuth Flow', 'blue');
  log('='.repeat(60), 'blue');

  logStep(1, 'Initialize OAuth flow');

  const initResponse = await fetch(`${BASE_URL}/api/v1/auth/oauth/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'apple',
      redirectUri: CALLBACK_URL,
    }),
  });

  if (!initResponse.ok) {
    const error = await initResponse.json();
    logError(`Failed to initialize: ${error.message}`);
    return;
  }

  const { authorizationUrl, state, codeVerifier } = await initResponse.json();
  logSuccess('OAuth initialized');
  logInfo(`State: ${state}`);
  if (codeVerifier) {
    logInfo(`Code verifier received (PKCE enabled)`);
  }

  logStep(2, 'Open authorization URL in browser');
  log(`\n  ${colors.yellow}Please open this URL in your browser:${colors.reset}`);
  log(`\n  ${authorizationUrl}\n`, 'cyan');

  log(`\n  ${colors.yellow}Note: Apple OAuth uses POST callback (form_post).${colors.reset}`);
  log(`  ${colors.yellow}The callback server will handle this automatically.${colors.reset}\n`);

  const shouldOpen = await confirm({
    message: 'Press Enter when ready to start listening for callback...',
    default: true,
  });

  if (!shouldOpen) {
    log('Cancelled by user', 'yellow');
    return;
  }

  logStep(3, 'Waiting for OAuth callback...');
  logInfo('Complete the Apple login in your browser');

  const callbackResult = await startCallbackServer();

  if (callbackResult.error) {
    logError(`OAuth error: ${callbackResult.error}`);
    return;
  }

  if (!callbackResult.code) {
    logError('No authorization code received');
    return;
  }

  logSuccess('Authorization code received');
  logInfo(`Code: ${callbackResult.code.substring(0, 20)}...`);

  logStep(4, 'Exchange code for tokens');

  const callbackResponse = await fetch(`${BASE_URL}/api/v1/auth/oauth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'apple',
      code: callbackResult.code,
      state: callbackResult.state,
      redirectUri: CALLBACK_URL,
      codeVerifier, // Include PKCE code verifier
    }),
  });

  if (!callbackResponse.ok) {
    const error = await callbackResponse.json();
    logError(`Token exchange failed: ${error.message}`);
    logInfo(`Full error: ${JSON.stringify(error, null, 2)}`);
    return;
  }

  const tokens = await callbackResponse.json();
  logSuccess('Tokens received!');
  logInfo(`Access token: ${tokens.accessToken?.substring(0, 30)}...`);
  logInfo(`User ID: ${tokens.user?.id}`);
  logInfo(`Email: ${tokens.user?.email}`);

  logStep(5, 'Verify token by fetching user profile');

  const meResponse = await fetch(`${BASE_URL}/api/v1/auth/me`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
    },
  });

  if (meResponse.ok) {
    const user = await meResponse.json();
    logSuccess('Token verified!');
    logInfo(`User: ${JSON.stringify(user, null, 2)}`);
  } else {
    const error = await meResponse.json();
    logError(`Token verification failed: ${error.message}`);
  }

  log('\n' + '='.repeat(60), 'green');
  log('  Apple OAuth Test Complete!', 'green');
  log('='.repeat(60), 'green');
}

async function testShopifyOAuth(): Promise<void> {
  log('\n' + '='.repeat(60), 'blue');
  log('  Testing Shopify OAuth Flow', 'blue');
  log('='.repeat(60), 'blue');

  logStep(1, 'Get shop domain');

  const shop = await input({
    message: 'Enter your Shopify shop domain (e.g., mystore.myshopify.com):',
    validate: (value) => {
      if (!value) return 'Shop domain is required';
      return true;
    },
  });

  logStep(2, 'Initialize OAuth flow');

  const authorizeUrl = `${BASE_URL}/api/v1/oauth/shopify/authorize?shop=${encodeURIComponent(shop)}&redirectUri=${encodeURIComponent(CALLBACK_URL)}`;

  log(`\n  ${colors.yellow}Please open this URL in your browser:${colors.reset}`);
  log(`\n  ${authorizeUrl}\n`, 'cyan');

  const shouldOpen = await confirm({
    message: 'Press Enter when ready to start listening for callback...',
    default: true,
  });

  if (!shouldOpen) {
    log('Cancelled by user', 'yellow');
    return;
  }

  logStep(3, 'Waiting for OAuth callback...');
  logInfo('Complete the Shopify authorization in your browser');

  const callbackResult = await startCallbackServer();

  if (callbackResult.error) {
    logError(`OAuth error: ${callbackResult.error}`);
    return;
  }

  if (!callbackResult.code) {
    logError('No authorization code received');
    return;
  }

  logSuccess('Authorization code received');
  logInfo(`Code: ${callbackResult.code.substring(0, 20)}...`);

  logStep(4, 'Exchange code for tokens (via callback endpoint)');

  // Shopify callback is handled by the redirect, but we can manually call
  // the callback endpoint if needed
  log(`\n  ${colors.yellow}Note: Shopify tokens are typically exchanged automatically${colors.reset}`);
  log(`  ${colors.yellow}during the redirect. Check your server logs for the result.${colors.reset}\n`);

  log('\n' + '='.repeat(60), 'green');
  log('  Shopify OAuth Test Complete!', 'green');
  log('='.repeat(60), 'green');
}

async function testAmazonOAuth(): Promise<void> {
  log('\n' + '='.repeat(60), 'blue');
  log('  Testing Amazon SP-API OAuth Flow', 'blue');
  log('='.repeat(60), 'blue');

  log(`\n  ${colors.yellow}Amazon OAuth requires user authentication first.${colors.reset}`);
  log(`  ${colors.yellow}You need a valid JWT token from Google/Apple OAuth.${colors.reset}\n`);

  const hasToken = await confirm({
    message: 'Do you have a JWT token from a previous OAuth login?',
    default: false,
  });

  if (!hasToken) {
    log('\nPlease complete Google or Apple OAuth first to get a JWT token.', 'yellow');
    return;
  }

  const jwtToken = await input({
    message: 'Enter your JWT access token:',
    validate: (value) => {
      if (!value) return 'Token is required';
      if (!value.includes('.')) return 'Invalid JWT format';
      return true;
    },
  });

  logStep(1, 'Initialize Amazon OAuth flow');

  const authorizeUrl = `${BASE_URL}/api/v1/oauth/amazon/authorize?redirectUri=${encodeURIComponent(CALLBACK_URL)}`;

  const response = await fetch(authorizeUrl, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
    },
    redirect: 'manual',
  });

  if (response.status === 302) {
    const redirectUrl = response.headers.get('location');
    logSuccess('OAuth initialized');

    logStep(2, 'Open authorization URL in browser');
    log(`\n  ${colors.yellow}Please open this URL in your browser:${colors.reset}`);
    log(`\n  ${redirectUrl}\n`, 'cyan');

    const shouldOpen = await confirm({
      message: 'Press Enter when ready to start listening for callback...',
      default: true,
    });

    if (!shouldOpen) {
      log('Cancelled by user', 'yellow');
      return;
    }

    logStep(3, 'Waiting for OAuth callback...');
    logInfo('Complete the Amazon authorization in your browser');

    const callbackResult = await startCallbackServer();

    if (callbackResult.error) {
      logError(`OAuth error: ${callbackResult.error}`);
      return;
    }

    if (!callbackResult.code) {
      logError('No authorization code received');
      return;
    }

    logSuccess('Authorization code received');
    log('\n' + '='.repeat(60), 'green');
    log('  Amazon OAuth Test Complete!', 'green');
    log('='.repeat(60), 'green');
  } else {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    logError(`Failed to initialize: ${error.message}`);
  }
}

async function testEbayOAuth(): Promise<void> {
  log('\n' + '='.repeat(60), 'blue');
  log('  Testing eBay OAuth Flow', 'blue');
  log('='.repeat(60), 'blue');

  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    logError('eBay credentials not configured');
    logInfo('Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REDIRECT_URI in .env');
    return;
  }

  logStep(1, 'Initialize OAuth flow');

  const authorizeUrl = `${BASE_URL}/api/v1/oauth/ebay/authorize?redirectUri=${encodeURIComponent(CALLBACK_URL)}`;

  log(`\n  ${colors.yellow}Please open this URL in your browser:${colors.reset}`);
  log(`\n  ${authorizeUrl}\n`, 'cyan');

  const shouldOpen = await confirm({
    message: 'Press Enter when ready to start listening for callback...',
    default: true,
  });

  if (!shouldOpen) {
    log('Cancelled by user', 'yellow');
    return;
  }

  logStep(2, 'Waiting for OAuth callback...');
  logInfo('Complete the eBay authorization in your browser');

  const callbackResult = await startCallbackServer();

  if (callbackResult.error) {
    logError(`OAuth error: ${callbackResult.error}`);
    return;
  }

  if (!callbackResult.code) {
    logError('No authorization code received');
    return;
  }

  logSuccess('Authorization code received');
  logInfo(`Code: ${callbackResult.code.substring(0, 20)}...`);

  log('\n' + '='.repeat(60), 'green');
  log('  eBay OAuth Test Complete!', 'green');
  log('='.repeat(60), 'green');
}

async function testStripeCheckout(): Promise<void> {
  log('\n' + '='.repeat(60), 'blue');
  log('  Testing Stripe Checkout Flow', 'blue');
  log('='.repeat(60), 'blue');

  log(`\n  ${colors.yellow}Stripe Checkout requires user authentication.${colors.reset}`);
  log(`  ${colors.yellow}You need a valid JWT token from Google/Apple OAuth.${colors.reset}\n`);

  const hasToken = await confirm({
    message: 'Do you have a JWT token from a previous OAuth login?',
    default: false,
  });

  if (!hasToken) {
    log('\nPlease complete Google or Apple OAuth first to get a JWT token.', 'yellow');
    return;
  }

  const jwtToken = await input({
    message: 'Enter your JWT access token:',
  });

  logStep(1, 'Get available credit packs');

  const packsResponse = await fetch(`${BASE_URL}/api/v1/credits/packs`);
  const packsData = await packsResponse.json();

  logSuccess('Available packs:');
  packsData.packs.forEach((pack: { packType: string; credits: number; priceUsd: number; name: string }) => {
    logInfo(`  ${pack.packType}: ${pack.credits} credits - $${pack.priceUsd} (${pack.name})`);
  });

  logStep(2, 'Create checkout session');

  const packType = await select({
    message: 'Select a pack to purchase:',
    choices: packsData.packs.map((pack: { packType: string; name: string; priceUsd: number }) => ({
      name: `${pack.name} - $${pack.priceUsd}`,
      value: pack.packType,
    })),
  });

  const checkoutResponse = await fetch(`${BASE_URL}/api/v1/credits/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtToken}`,
    },
    body: JSON.stringify({
      packType,
      successUrl: 'http://localhost:3001/success',
      cancelUrl: 'http://localhost:3001/cancel',
    }),
  });

  if (!checkoutResponse.ok) {
    const error = await checkoutResponse.json();
    logError(`Failed to create checkout: ${error.message}`);
    return;
  }

  const checkout = await checkoutResponse.json();
  logSuccess('Checkout session created!');

  logStep(3, 'Complete payment');
  log(`\n  ${colors.yellow}Open this URL to complete the test payment:${colors.reset}`);
  log(`\n  ${checkout.url}\n`, 'cyan');

  log(`\n  ${colors.dim}Use Stripe test card: 4242 4242 4242 4242${colors.reset}`);
  log(`  ${colors.dim}Any future expiry, any CVC${colors.reset}\n`);

  await confirm({
    message: 'Press Enter after completing the payment...',
    default: true,
  });

  logStep(4, 'Check credit balance');

  const balanceResponse = await fetch(`${BASE_URL}/api/v1/credits/balance`, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
    },
  });

  if (balanceResponse.ok) {
    const balance = await balanceResponse.json();
    logSuccess(`Current balance: ${balance.balance} credits`);
    if (balance.transactions?.length > 0) {
      logInfo('Recent transactions:');
      balance.transactions.slice(0, 3).forEach((tx: { type: string; creditsDelta: number; createdAt: string }) => {
        logInfo(`  ${tx.type}: ${tx.creditsDelta > 0 ? '+' : ''}${tx.creditsDelta} credits (${new Date(tx.createdAt).toLocaleString()})`);
      });
    }
  } else {
    const error = await balanceResponse.json();
    logError(`Failed to get balance: ${error.message}`);
  }

  log('\n' + '='.repeat(60), 'green');
  log('  Stripe Checkout Test Complete!', 'green');
  log('='.repeat(60), 'green');
}

async function main() {
  log('\n' + '='.repeat(60), 'blue');
  log('  VOPI OAuth Testing Tool', 'blue');
  log('='.repeat(60), 'blue');

  log(`\nBase URL: ${BASE_URL}`);
  log(`Callback URL: ${CALLBACK_URL}`);

  // Check configuration
  const providers = await checkProviderConfig();

  log('\n' + '-'.repeat(60), 'blue');
  log('  Provider Configuration', 'blue');
  log('-'.repeat(60), 'blue');

  providers.forEach((p) => {
    const status = p.configured
      ? `${colors.green}✓ Configured${colors.reset}`
      : `${colors.yellow}○ Not configured${colors.reset}`;
    const authNote = p.requiresUserAuth ? ` ${colors.dim}(requires user JWT)${colors.reset}` : '';
    console.log(`  ${p.name.padEnd(15)} ${status}${authNote}`);
  });

  // Check Stripe
  const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
  const stripeStatus = stripeConfigured
    ? `${colors.green}✓ Configured${colors.reset}`
    : `${colors.yellow}○ Not configured${colors.reset}`;
  console.log(`  ${'Stripe'.padEnd(15)} ${stripeStatus}`);

  // Main menu loop
  while (true) {
    log('\n' + '-'.repeat(60), 'blue');

    const choice = await select({
      message: 'What would you like to test?',
      choices: [
        { name: '🔵 Google OAuth (User Authentication)', value: 'google', disabled: !providers.find(p => p.key === 'google')?.configured },
        { name: '🍎 Apple OAuth (User Authentication)', value: 'apple', disabled: !providers.find(p => p.key === 'apple')?.configured },
        { name: '🛒 Shopify OAuth (E-commerce)', value: 'shopify', disabled: !providers.find(p => p.key === 'shopify')?.configured },
        { name: '📦 Amazon SP-API OAuth (E-commerce)', value: 'amazon', disabled: !providers.find(p => p.key === 'amazon')?.configured },
        { name: '🏷️ eBay OAuth (E-commerce)', value: 'ebay', disabled: !providers.find(p => p.key === 'ebay')?.configured },
        { name: '💳 Stripe Checkout (Credits)', value: 'stripe', disabled: !stripeConfigured },
        { name: '❌ Exit', value: 'exit' },
      ],
    });

    switch (choice) {
      case 'google':
        await testGoogleOAuth();
        break;
      case 'apple':
        await testAppleOAuth();
        break;
      case 'shopify':
        await testShopifyOAuth();
        break;
      case 'amazon':
        await testAmazonOAuth();
        break;
      case 'ebay':
        await testEbayOAuth();
        break;
      case 'stripe':
        await testStripeCheckout();
        break;
      case 'exit':
        log('\nGoodbye! 👋\n', 'cyan');
        process.exit(0);
    }
  }
}

main().catch((error) => {
  console.error('Script error:', error);
  process.exit(1);
});

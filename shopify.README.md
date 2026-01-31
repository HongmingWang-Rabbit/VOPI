# Shopify App Configuration

This directory contains Shopify app configuration files for the VOPI backend.

## Setup

1. **Copy the example files**:
   ```bash
   cp shopify.app.toml.example shopify.app.toml
   cp shopify.app.vopi.toml.example shopify.app.vopi.toml
   ```

2. **Get your Shopify App credentials**:
   - Go to [Shopify Partners Dashboard](https://partners.shopify.com/)
   - Navigate to "Apps" → Your app → "Client credentials"
   - Copy the Client ID

3. **Update the configuration files**:
   - Replace `your-shopify-client-id-here` with your actual Client ID in both files
   - Update URLs if needed (especially for development)

## Files

- **shopify.app.toml** - Development/local configuration
  - Uses `http://localhost:3000` for local testing
  - Embedded app mode enabled

- **shopify.app.vopi.toml** - Production configuration
  - Uses `https://api.vopi.24rabbit.com`
  - Includes GDPR compliance webhook subscriptions
  - Non-embedded mode

## Security Note

⚠️ **Important**: The actual `shopify.app.toml` and `shopify.app.vopi.toml` files are git-ignored because they contain app-specific Client IDs. Never commit these files with real credentials.

## Learn More

- [Shopify CLI Configuration](https://shopify.dev/docs/apps/tools/cli/configuration)
- [Shopify OAuth Documentation](https://shopify.dev/docs/apps/auth/oauth)

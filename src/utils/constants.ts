/**
 * Application Constants
 *
 * Centralized constants for the application.
 * Version is synchronized with package.json.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Package.json content for version info
 */
const pkg = require('../../package.json') as { version: string; name: string };

/**
 * Application version from package.json
 */
export const APP_VERSION = pkg.version;

/**
 * Application name from package.json
 */
export const APP_NAME = pkg.name;

/**
 * Pipeline version for metadata files
 * This is tied to the app version and included in exported metadata
 */
export const PIPELINE_VERSION = APP_VERSION;

/**
 * Shopify Admin API version
 * Used by both the ecommerce provider and OAuth service
 */
export const SHOPIFY_API_VERSION = '2026-01';

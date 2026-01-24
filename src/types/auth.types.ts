import { z } from 'zod';

/**
 * OAuth provider types
 */
export const OAuthProvider = {
  GOOGLE: 'google',
  APPLE: 'apple',
} as const;

export type OAuthProviderType = (typeof OAuthProvider)[keyof typeof OAuthProvider];

/**
 * E-commerce platform types
 */
export const PlatformType = {
  SHOPIFY: 'shopify',
  AMAZON: 'amazon',
  EBAY: 'ebay',
} as const;

export type PlatformTypeValue = (typeof PlatformType)[keyof typeof PlatformType];

/**
 * Platform connection status
 */
export const ConnectionStatus = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  ERROR: 'error',
} as const;

export type ConnectionStatusValue = (typeof ConnectionStatus)[keyof typeof ConnectionStatus];

/**
 * Platform listing status
 */
export const ListingStatus = {
  PENDING: 'pending',
  PUSHING: 'pushing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type ListingStatusValue = (typeof ListingStatus)[keyof typeof ListingStatus];

/**
 * OAuth provider data stored in oauth_accounts.provider_data
 */
export interface GoogleProviderData {
  picture?: string;
  locale?: string;
  hd?: string; // Google Workspace domain
}

export interface AppleProviderData {
  isPrivateEmail?: boolean;
  realUserStatus?: number;
}

export type OAuthProviderData = GoogleProviderData | AppleProviderData;

/**
 * Platform-specific connection metadata
 */
export interface ShopifyConnectionMetadata {
  shop: string; // e.g., "mystore.myshopify.com"
  shopName?: string;
  shopId?: string;
  scope?: string;
}

export interface AmazonConnectionMetadata {
  sellerId: string;
  marketplaceIds: string[];
  region?: string;
}

export interface EbayConnectionMetadata {
  userId: string;
  username?: string;
  marketplaceId?: string;
  environment?: 'sandbox' | 'production';
}

export type PlatformConnectionMetadata =
  | ShopifyConnectionMetadata
  | AmazonConnectionMetadata
  | EbayConnectionMetadata;

/**
 * Platform listing metadata
 */
export interface PlatformListingMetadata {
  productUrl?: string;
  title?: string;
  sku?: string;
  imageCount?: number;
  pushedAt?: string;
  retryCount?: number;
}

/**
 * JWT payload for access tokens
 */
export interface JwtPayload {
  sub: string; // User ID
  email: string;
  type: 'access';
  iat: number;
  exp: number;
}

/**
 * JWT payload for refresh tokens
 */
export interface RefreshTokenPayload {
  sub: string; // User ID
  jti: string; // Token ID (for revocation)
  type: 'refresh';
  iat: number;
  exp: number;
}

/**
 * Auth context attached to requests
 *
 * For JWT auth: userId is the actual user ID
 * For API key auth: userId is empty string, use apiKeyId instead
 */
export interface AuthContext {
  userId: string;
  email: string;
  tokenType: 'access' | 'api_key';
  /** Only set for API key authentication */
  apiKeyId?: string;
  /** Only set for API key authentication */
  apiKeyName?: string;
}

/**
 * Device info for refresh token tracking
 */
export interface DeviceInfo {
  deviceId?: string;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * OAuth user profile from providers
 */
export interface OAuthUserProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
  providerData?: OAuthProviderData;
}

/**
 * OAuth tokens from providers
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  idToken?: string;
  scope?: string;
}

/**
 * Auth response returned to clients
 */
export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  user: {
    id: string;
    email: string;
    name?: string;
    avatarUrl?: string;
    creditsBalance: number;
  };
}

/**
 * Zod Schemas for request validation
 */
export const oauthInitRequestSchema = z.object({
  provider: z.enum(['google', 'apple']),
  redirectUri: z.string().url(),
  state: z.string().optional(),
  codeChallenge: z.string().optional(), // PKCE
  codeChallengeMethod: z.enum(['S256', 'plain']).optional(),
});

export type OAuthInitRequest = z.infer<typeof oauthInitRequestSchema>;

export const oauthCallbackRequestSchema = z.object({
  provider: z.enum(['google', 'apple']),
  code: z.string(),
  redirectUri: z.string().url(),
  codeVerifier: z.string().optional(), // PKCE
  deviceInfo: z.object({
    deviceId: z.string().optional(),
    deviceName: z.string().optional(),
  }).optional(),
});

export type OAuthCallbackRequest = z.infer<typeof oauthCallbackRequestSchema>;

export const refreshTokenRequestSchema = z.object({
  refreshToken: z.string(),
});

export type RefreshTokenRequest = z.infer<typeof refreshTokenRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().optional(),
  allDevices: z.boolean().optional().default(false),
});

export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

/**
 * Platform OAuth request schemas
 */
export const shopifyAuthorizeQuerySchema = z.object({
  shop: z.string().regex(/^[a-zA-Z0-9-]+\.myshopify\.com$/),
  redirectUri: z.string().url().optional(),
});

export type ShopifyAuthorizeQuery = z.infer<typeof shopifyAuthorizeQuerySchema>;

export const shopifyCallbackQuerySchema = z.object({
  code: z.string(),
  shop: z.string(),
  state: z.string(),
  hmac: z.string(),
  timestamp: z.string(),
});

export type ShopifyCallbackQuery = z.infer<typeof shopifyCallbackQuerySchema>;

export const amazonAuthorizeQuerySchema = z.object({
  redirectUri: z.string().url().optional(),
});

export type AmazonAuthorizeQuery = z.infer<typeof amazonAuthorizeQuerySchema>;

export const amazonCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  spapi_oauth_code: z.string().optional(), // Amazon uses this parameter name
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type AmazonCallbackQuery = z.infer<typeof amazonCallbackQuerySchema>;

export const ebayAuthorizeQuerySchema = z.object({
  redirectUri: z.string().url().optional(),
});

export type EbayAuthorizeQuery = z.infer<typeof ebayAuthorizeQuerySchema>;

export const ebayCallbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
});

export type EbayCallbackQuery = z.infer<typeof ebayCallbackQuerySchema>;

/**
 * Listing push request schema
 */
export const pushListingRequestSchema = z.object({
  jobId: z.string().uuid(),
  connectionId: z.string().uuid(),
  options: z.object({
    publishAsDraft: z.boolean().optional().default(true),
    skipImages: z.boolean().optional().default(false),
    overrideMetadata: z.record(z.unknown()).optional(),
  }).optional(),
});

export type PushListingRequest = z.infer<typeof pushListingRequestSchema>;

/**
 * E-commerce provider interfaces
 */
export interface ProductCreationResult {
  success: boolean;
  productId?: string;
  productUrl?: string;
  error?: string;
}

export interface ImageUploadResult {
  success: boolean;
  imageId?: string;
  imageUrl?: string;
  error?: string;
}

export interface EcommerceProvider {
  createProduct(
    accessToken: string,
    metadata: Record<string, unknown>,
    options?: { publishAsDraft?: boolean }
  ): Promise<ProductCreationResult>;

  updateProduct(
    accessToken: string,
    productId: string,
    metadata: Record<string, unknown>
  ): Promise<ProductCreationResult>;

  uploadImages(
    accessToken: string,
    productId: string,
    imageUrls: string[]
  ): Promise<ImageUploadResult[]>;

  deleteProduct(
    accessToken: string,
    productId: string
  ): Promise<{ success: boolean; error?: string }>;

  verifyToken(accessToken: string): Promise<boolean>;
}

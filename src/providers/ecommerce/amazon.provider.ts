import { randomBytes } from 'crypto';
import { SellingPartner } from 'amazon-sp-api';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import type {
  EcommerceProvider,
  ProductCreationResult,
  ImageUploadResult,
  AmazonConnectionMetadata,
} from '../../types/auth.types.js';

const logger = getLogger().child({ provider: 'amazon-ecommerce' });

/** Maximum number of images Amazon allows per listing (1 main + 8 others). */
const MAX_AMAZON_IMAGES = 9;

/** Valid SP-API regions. */
const VALID_REGIONS = new Set(['na', 'eu', 'fe']);

/**
 * Create a SellingPartner client with LWA credentials.
 * The SDK handles AWS Signature v4 and token refresh automatically.
 */
export function createSPClient(refreshToken: string, region: string = 'na'): SellingPartner {
  const config = getConfig();

  if (!config.amazon.clientId || !config.amazon.clientSecret) {
    throw new Error('Amazon SP-API credentials not configured');
  }

  const validRegion = VALID_REGIONS.has(region) ? (region as 'na' | 'eu' | 'fe') : 'na';

  return new SellingPartner({
    region: validRegion,
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: config.amazon.clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: config.amazon.clientSecret,
    },
    options: {
      auto_request_tokens: true,
      auto_request_throttled: true,
    },
  });
}

/**
 * Build marketplace-scoped attribute value for SP-API listings.
 */
function attr(value: string, marketplaceId: string): Array<{ value: string; marketplace_id: string }> {
  return [{ value, marketplace_id: marketplaceId }];
}

interface AmazonProviderOptions {
  publishAsDraft?: boolean;
  sellerId?: string;
  marketplaceId?: string;
  refreshToken?: string;
  region?: string;
}

/**
 * Extract common metadata fields from the generic metadata record.
 */
function extractMetadataFields(metadata: Record<string, unknown>) {
  return {
    title: metadata.title as string | undefined,
    description: metadata.description as string | undefined,
    brand: metadata.brand as string | undefined,
    category: metadata.category as string | undefined,
    condition: metadata.condition as string | undefined,
    bulletPoints: metadata.bulletPoints as string[] | undefined,
    price: metadata.price as number | undefined,
    currency: (metadata.currency as string) || 'USD',
    imageUrls: metadata.imageUrls as string[] | undefined,
    sku: (metadata.sku as string) || `VOPI-${Date.now()}-${randomBytes(4).toString('hex')}`,
  };
}

/**
 * Build image attribute patches for SP-API listings.
 */
function buildImagePatches(
  imageUrls: string[],
  marketplaceId: string,
  op: 'replace' | 'add' = 'replace'
): Array<{ op: string; path: string; value: unknown }> {
  const patches: Array<{ op: string; path: string; value: unknown }> = [];

  if (imageUrls.length > 0) {
    patches.push({
      op,
      path: '/attributes/main_offer_image_locator',
      value: [{ media_location: imageUrls[0], marketplace_id: marketplaceId }],
    });
  }

  for (let i = 1; i < Math.min(imageUrls.length, MAX_AMAZON_IMAGES); i++) {
    patches.push({
      op,
      path: `/attributes/other_offer_image_locator_${i}`,
      value: [{ media_location: imageUrls[i], marketplace_id: marketplaceId }],
    });
  }

  return patches;
}

/**
 * Amazon SP-API E-Commerce Provider
 * Uses the amazon-sp-api SDK for proper AWS Signature v4 signing and token management.
 */
class AmazonProvider implements EcommerceProvider {
  async createProduct(
    _accessToken: string,
    metadata: Record<string, unknown>,
    options?: AmazonProviderOptions
  ): Promise<ProductCreationResult> {
    const sellerId = options?.sellerId;
    const marketplaceId = options?.marketplaceId || 'ATVPDKIKX0DER';
    const refreshToken = options?.refreshToken;
    const region = options?.region || 'na';

    if (!sellerId) {
      return { success: false, error: 'Seller ID is required' };
    }
    if (!refreshToken) {
      return { success: false, error: 'Refresh token is required for Amazon SP-API' };
    }

    try {
      const fields = extractMetadataFields(metadata);

      // Build listing attributes
      const attributes: Record<string, unknown> = {
        condition_type: attr(fields.condition || 'new_new', marketplaceId),
      };

      if (fields.title) attributes.item_name = attr(fields.title, marketplaceId);
      if (fields.brand) attributes.brand = attr(fields.brand, marketplaceId);
      if (fields.description) attributes.product_description = attr(fields.description, marketplaceId);
      if (fields.bulletPoints?.length) {
        attributes.bullet_point = fields.bulletPoints.map((bp) => ({
          value: bp,
          marketplace_id: marketplaceId,
        }));
      }
      if (fields.price != null) {
        attributes.purchasable_offer = [
          {
            marketplace_id: marketplaceId,
            currency: fields.currency,
            our_price: [{ schedule: [{ value_with_tax: fields.price }] }],
          },
        ];
      }

      // Attach image URLs directly in listing attributes
      if (fields.imageUrls?.length) {
        attributes.main_offer_image_locator = [
          { media_location: fields.imageUrls[0], marketplace_id: marketplaceId },
        ];
        for (let i = 1; i < Math.min(fields.imageUrls.length, MAX_AMAZON_IMAGES); i++) {
          attributes[`other_offer_image_locator_${i}`] = [
            { media_location: fields.imageUrls[i], marketplace_id: marketplaceId },
          ];
        }
      }

      const productType = fields.category || 'PRODUCT';

      logger.debug({ sellerId, sku: fields.sku }, 'Creating Amazon listing via SP-API');

      const sp = createSPClient(refreshToken, region);

      await sp.callAPI({
        operation: 'listingsItems.putListingsItem',
        path: { sellerId, sku: fields.sku },
        query: { marketplaceIds: [marketplaceId] },
        body: {
          productType,
          attributes,
        },
      });

      logger.info({ sellerId, sku: fields.sku }, 'Amazon listing created');

      return {
        success: true,
        productId: fields.sku,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ sellerId, error: message }, 'Failed to create Amazon listing');
      return { success: false, error: message };
    }
  }

  async updateProduct(
    _accessToken: string,
    productId: string,
    metadata: Record<string, unknown>,
    options?: AmazonProviderOptions
  ): Promise<ProductCreationResult> {
    const sellerId = options?.sellerId;
    const marketplaceId = options?.marketplaceId || 'ATVPDKIKX0DER';
    const refreshToken = options?.refreshToken;
    const region = options?.region || 'na';

    if (!sellerId) {
      return { success: false, error: 'Seller ID is required' };
    }
    if (!refreshToken) {
      return { success: false, error: 'Refresh token is required for Amazon SP-API' };
    }

    try {
      const fields = extractMetadataFields(metadata);

      const patches: Array<{ op: string; path: string; value: unknown }> = [];

      if (fields.title) {
        patches.push({ op: 'replace', path: '/attributes/item_name', value: attr(fields.title, marketplaceId) });
      }
      if (fields.description) {
        patches.push({ op: 'replace', path: '/attributes/product_description', value: attr(fields.description, marketplaceId) });
      }
      if (fields.brand) {
        patches.push({ op: 'replace', path: '/attributes/brand', value: attr(fields.brand, marketplaceId) });
      }
      if (fields.bulletPoints?.length) {
        patches.push({
          op: 'replace',
          path: '/attributes/bullet_point',
          value: fields.bulletPoints.map((bp) => ({ value: bp, marketplace_id: marketplaceId })),
        });
      }
      if (fields.price != null) {
        patches.push({
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [
            {
              marketplace_id: marketplaceId,
              currency: fields.currency,
              our_price: [{ schedule: [{ value_with_tax: fields.price }] }],
            },
          ],
        });
      }

      if (patches.length === 0) {
        return { success: true, productId };
      }

      const productType = fields.category || 'PRODUCT';

      logger.debug({ sellerId, sku: productId, patchCount: patches.length }, 'Updating Amazon listing via SP-API');

      const sp = createSPClient(refreshToken, region);

      await sp.callAPI({
        operation: 'listingsItems.patchListingsItem',
        path: { sellerId, sku: productId },
        query: { marketplaceIds: [marketplaceId] },
        body: {
          productType,
          patches,
        },
      });

      logger.info({ sellerId, sku: productId }, 'Amazon listing updated');

      return { success: true, productId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ sellerId, productId, error: message }, 'Failed to update Amazon listing');
      return { success: false, error: message };
    }
  }

  async uploadImages(
    _accessToken: string,
    productId: string,
    imageUrls: string[],
    options?: AmazonProviderOptions & { productType?: string }
  ): Promise<ImageUploadResult[]> {
    const sellerId = options?.sellerId;
    const marketplaceId = options?.marketplaceId || 'ATVPDKIKX0DER';
    const refreshToken = options?.refreshToken;
    const region = options?.region || 'na';

    if (!sellerId) {
      return imageUrls.map(() => ({ success: false, error: 'Seller ID is required' }));
    }
    if (!refreshToken) {
      return imageUrls.map(() => ({ success: false, error: 'Refresh token is required' }));
    }

    try {
      logger.debug(
        { sellerId, productId, imageCount: imageUrls.length },
        'Uploading images to Amazon listing via SP-API'
      );

      const patches = buildImagePatches(imageUrls, marketplaceId);

      const sp = createSPClient(refreshToken, region);

      await sp.callAPI({
        operation: 'listingsItems.patchListingsItem',
        path: { sellerId, sku: productId },
        query: { marketplaceIds: [marketplaceId] },
        body: {
          productType: options?.productType || 'PRODUCT',
          patches,
        },
      });

      logger.info({ sellerId, productId, imageCount: imageUrls.length }, 'Images added to Amazon listing');

      return imageUrls.map((url, i) => ({
        success: true,
        imageId: `image-${i}`,
        imageUrl: url,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ sellerId, productId, error: message }, 'Failed to upload images to Amazon');
      return imageUrls.map(() => ({ success: false, error: message }));
    }
  }

  async deleteProduct(
    _accessToken: string,
    productId: string,
    options?: AmazonProviderOptions
  ): Promise<{ success: boolean; error?: string }> {
    const sellerId = options?.sellerId;
    const marketplaceId = options?.marketplaceId || 'ATVPDKIKX0DER';
    const refreshToken = options?.refreshToken;
    const region = options?.region || 'na';

    if (!sellerId) {
      return { success: false, error: 'Seller ID is required' };
    }
    if (!refreshToken) {
      return { success: false, error: 'Refresh token is required' };
    }

    try {
      logger.debug({ sellerId, productId }, 'Deleting Amazon listing via SP-API');

      const sp = createSPClient(refreshToken, region);

      await sp.callAPI({
        operation: 'listingsItems.deleteListingsItem',
        path: { sellerId, sku: productId },
        query: { marketplaceIds: [marketplaceId] },
      });

      logger.info({ sellerId, productId }, 'Amazon listing deleted');

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ sellerId, productId, error: message }, 'Failed to delete Amazon listing');
      return { success: false, error: message };
    }
  }

  async verifyToken(
    _accessToken: string,
    options?: { refreshToken?: string; region?: string }
  ): Promise<boolean> {
    const refreshToken = options?.refreshToken;
    const region = options?.region || 'na';

    if (!refreshToken) {
      return false;
    }

    try {
      const sp = createSPClient(refreshToken, region);
      await sp.callAPI({
        operation: 'sellers.getMarketplaceParticipations',
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get seller info (seller ID, marketplace IDs) using a refresh token.
 * Used during OAuth callback to populate connection metadata.
 *
 * Tries `getAccount` first for seller ID. If unavailable, falls back to
 * extracting the selling partner ID from `getMarketplaceParticipations`
 * payload (the `sellerId` field in newer API versions).
 */
export async function getSellerInfoFromSPAPI(
  refreshToken: string,
  region: string = 'na'
): Promise<AmazonConnectionMetadata> {
  const sp = createSPClient(refreshToken, region);

  const res = await sp.callAPI({
    operation: 'sellers.getMarketplaceParticipations',
  });

  // Response is an array of { marketplace, participation } objects
  const participations = res as Array<{
    marketplace: { id: string; countryCode: string; name: string };
    participation: { isParticipating: boolean; hasSuspendedListings: boolean; sellerId?: string };
  }>;

  if (!participations?.length) {
    throw new Error('No marketplace participations found for this seller');
  }

  const marketplaceIds = participations
    .filter((p) => p.participation.isParticipating)
    .map((p) => p.marketplace.id);

  // Try multiple methods to retrieve seller ID
  let sellerId: string | undefined;

  // Method 1: Try getAccount endpoint (sellers v1)
  try {
    const accountRes = await sp.callAPI({
      operation: 'sellers.getAccount',
    });
    sellerId = (accountRes as { sellerId?: string })?.sellerId;
  } catch {
    logger.debug('getAccount not available, trying fallback methods');
  }

  // Method 2: Some SP-API responses include sellerId in participation data
  if (!sellerId) {
    for (const p of participations) {
      if (p.participation.sellerId) {
        sellerId = p.participation.sellerId;
        break;
      }
    }
  }

  if (!sellerId) {
    throw new Error(
      'Could not determine seller ID. Ensure the SP-API app has seller authorization (not just LWA profile scope). ' +
      'Use the Seller Central authorization URL (sellercentral.amazon.com/apps/authorize/consent) instead of LWA.'
    );
  }

  return {
    sellerId,
    marketplaceIds: marketplaceIds.length > 0 ? marketplaceIds : ['ATVPDKIKX0DER'],
    region,
  };
}

export const amazonProvider = new AmazonProvider();

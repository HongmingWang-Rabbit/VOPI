import { getLogger } from '../../utils/logger.js';
import type {
  EcommerceProvider,
  ProductCreationResult,
  ImageUploadResult,
  AmazonConnectionMetadata,
} from '../../types/auth.types.js';

const logger = getLogger().child({ provider: 'amazon-ecommerce' });

// Note: In production, use the amazon-sp-api library for proper AWS Signature v4 signing
// This is a simplified implementation showing the structure

interface AmazonListingInput {
  productType: string;
  requirements?: string;
  attributes: {
    condition_type?: Array<{ value: string }>;
    item_name?: Array<{ value: string }>;
    brand?: Array<{ value: string }>;
    bullet_point?: Array<{ value: string }>;
    product_description?: Array<{ value: string }>;
    manufacturer?: Array<{ value: string }>;
    part_number?: Array<{ value: string }>;
    item_type_keyword?: Array<{ value: string }>;
  };
}

/**
 * Amazon SP-API E-Commerce Provider
 * Uses Listings API for product management
 *
 * Note: This requires the `amazon-sp-api` npm package for proper implementation
 * as it handles AWS Signature v4 signing automatically
 */
class AmazonProvider implements EcommerceProvider {
  /**
   * Make an API request to Amazon SP-API
   * In production, this should use the amazon-sp-api library
   */
  private async makeRequest(
    accessToken: string,
    endpoint: string,
    method: string = 'GET',
    body?: unknown,
    metadata?: AmazonConnectionMetadata
  ): Promise<unknown> {
    const region = metadata?.region || 'na';
    const baseUrl = this.getBaseUrl(region);

    // Note: This is simplified - actual implementation needs AWS Signature v4
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-amz-access-token': accessToken,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Amazon API request failed: ${error}`);
    }

    return response.json();
  }

  /**
   * Get base URL for region
   */
  private getBaseUrl(region: string): string {
    switch (region) {
      case 'eu':
        return 'https://sellingpartnerapi-eu.amazon.com';
      case 'fe':
        return 'https://sellingpartnerapi-fe.amazon.com';
      case 'na':
      default:
        return 'https://sellingpartnerapi-na.amazon.com';
    }
  }

  /**
   * Create a product listing in Amazon
   */
  async createProduct(
    accessToken: string,
    metadata: Record<string, unknown>,
    options?: { publishAsDraft?: boolean; sellerId?: string; marketplaceId?: string }
  ): Promise<ProductCreationResult> {
    const sellerId = options?.sellerId;
    const marketplaceId = options?.marketplaceId || 'ATVPDKIKX0DER'; // US marketplace

    if (!sellerId) {
      return { success: false, error: 'Seller ID is required' };
    }

    try {
      // Extract fields from metadata with type safety
      const title = metadata.title as string | undefined;
      const description = metadata.description as string | undefined;
      const brand = metadata.brand as string | undefined;
      const category = metadata.category as string | undefined;
      const condition = metadata.condition as string | undefined;
      const bulletPoints = metadata.bulletPoints as string[] | undefined;
      const sku = (metadata.sku as string) || `VOPI-${Date.now()}`;

      // Build listing attributes
      const attributes: AmazonListingInput['attributes'] = {
        condition_type: [{ value: condition || 'new_new' }],
        item_name: title ? [{ value: title }] : undefined,
        brand: brand ? [{ value: brand }] : undefined,
        bullet_point: bulletPoints?.map((bp) => ({ value: bp })),
        product_description: description ? [{ value: description }] : undefined,
      };

      // Remove undefined attributes
      Object.keys(attributes).forEach((key) => {
        if (attributes[key as keyof typeof attributes] === undefined) {
          delete attributes[key as keyof typeof attributes];
        }
      });

      logger.debug({ sellerId, sku }, 'Creating Amazon listing');

      const listingInput: AmazonListingInput = {
        productType: category || 'PRODUCT',
        attributes,
      };

      // Use Listings API to create/update listing
      const endpoint = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;

      await this.makeRequest(
        accessToken,
        `${endpoint}?marketplaceIds=${marketplaceId}`,
        'PUT',
        listingInput,
        { sellerId, marketplaceIds: [marketplaceId] }
      );

      logger.info({ sellerId, sku }, 'Amazon listing created');

      // Amazon doesn't return a direct product URL in the API response
      const productUrl = `https://www.amazon.com/dp/${sku}`;

      return {
        success: true,
        productId: sku,
        productUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ sellerId, error: message }, 'Failed to create Amazon listing');
      return { success: false, error: message };
    }
  }

  /**
   * Update an existing listing
   */
  async updateProduct(
    accessToken: string,
    productId: string,
    metadata: Record<string, unknown>,
    options?: { sellerId?: string; marketplaceId?: string }
  ): Promise<ProductCreationResult> {
    // Amazon uses the same endpoint for create and update (PUT)
    return this.createProduct(accessToken, { ...metadata, sku: productId }, options);
  }

  /**
   * Upload images to a listing
   * Note: Amazon uses a different process for images - they need to be uploaded to a staging area first
   */
  async uploadImages(
    _accessToken: string,
    productId: string,
    imageUrls: string[],
    options?: { sellerId?: string; marketplaceId?: string }
  ): Promise<ImageUploadResult[]> {
    const sellerId = options?.sellerId;

    if (!sellerId) {
      return imageUrls.map(() => ({ success: false, error: 'Seller ID is required' }));
    }

    try {
      logger.debug(
        { sellerId, productId, imageCount: imageUrls.length },
        'Uploading images to Amazon listing'
      );

      // Amazon requires images to be uploaded through a specific workflow:
      // 1. Request upload destination from Uploads API
      // 2. Upload image to S3 presigned URL
      // 3. Add image reference to listing
      // This is a simplified version

      const results: ImageUploadResult[] = [];

      for (let i = 0; i < imageUrls.length; i++) {
        try {
          // In a full implementation, you would:
          // 1. Call createUploadDestinationForResource
          // 2. Upload the image bytes to the returned URL
          // 3. Update the listing with the image reference

          logger.debug(
            { sellerId, productId, imageIndex: i },
            'Image upload placeholder - requires full SP-API implementation'
          );

          results.push({
            success: true,
            imageId: `image-${i}`,
            imageUrl: imageUrls[i],
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          results.push({ success: false, error: message });
        }
      }

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { sellerId, productId, error: message },
        'Failed to upload images to Amazon'
      );
      return imageUrls.map(() => ({ success: false, error: message }));
    }
  }

  /**
   * Delete a listing
   */
  async deleteProduct(
    accessToken: string,
    productId: string,
    options?: { sellerId?: string; marketplaceId?: string }
  ): Promise<{ success: boolean; error?: string }> {
    const sellerId = options?.sellerId;
    const marketplaceId = options?.marketplaceId || 'ATVPDKIKX0DER';

    if (!sellerId) {
      return { success: false, error: 'Seller ID is required' };
    }

    try {
      logger.debug({ sellerId, productId }, 'Deleting Amazon listing');

      const endpoint = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(productId)}`;

      await this.makeRequest(
        accessToken,
        `${endpoint}?marketplaceIds=${marketplaceId}`,
        'DELETE',
        undefined,
        { sellerId, marketplaceIds: [marketplaceId] }
      );

      logger.info({ sellerId, productId }, 'Amazon listing deleted');

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ sellerId, productId, error: message }, 'Failed to delete Amazon listing');
      return { success: false, error: message };
    }
  }

  /**
   * Verify token is still valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    try {
      // Make a simple API call to verify token
      await this.makeRequest(
        accessToken,
        '/sellers/v1/marketplaceParticipations',
        'GET'
      );
      return true;
    } catch {
      return false;
    }
  }
}

export const amazonProvider = new AmazonProvider();

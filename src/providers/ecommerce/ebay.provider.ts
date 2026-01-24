import { getConfig } from '../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import type {
  EcommerceProvider,
  ProductCreationResult,
  ImageUploadResult,
} from '../../types/auth.types.js';

const logger = getLogger().child({ provider: 'ebay-ecommerce' });

interface EbayInventoryItem {
  product: {
    title: string;
    description?: string;
    brand?: string;
    aspects?: Record<string, string[]>;
    imageUrls?: string[];
  };
  condition: string;
  availability: {
    shipToLocationAvailability: {
      quantity: number;
    };
  };
}

interface EbayOffer {
  sku: string;
  marketplaceId: string;
  format: 'FIXED_PRICE';
  listingDescription?: string;
  availableQuantity: number;
  pricingSummary: {
    price: {
      value: string;
      currency: string;
    };
  };
  categoryId?: string;
  listingPolicies: {
    fulfillmentPolicyId?: string;
    paymentPolicyId?: string;
    returnPolicyId?: string;
  };
}

/**
 * eBay E-Commerce Provider
 * Uses Inventory API and Account API for product management
 */
class EbayProvider implements EcommerceProvider {
  /**
   * Get base URL based on environment
   */
  private getBaseUrl(): string {
    const config = getConfig();
    return config.ebay.environment === 'sandbox'
      ? 'https://api.sandbox.ebay.com'
      : 'https://api.ebay.com';
  }

  /**
   * Make an API request to eBay
   */
  private async makeRequest(
    accessToken: string,
    endpoint: string,
    method: string = 'GET',
    body?: unknown
  ): Promise<unknown> {
    const baseUrl = this.getBaseUrl();

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Language': 'en-US',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Handle 204 No Content
    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`eBay API request failed (${response.status}): ${error}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json();
    }

    return null;
  }

  /**
   * Create inventory item and offer in eBay
   */
  async createProduct(
    accessToken: string,
    metadata: Record<string, unknown>,
    options?: { publishAsDraft?: boolean; marketplaceId?: string }
  ): Promise<ProductCreationResult> {
    const marketplaceId = options?.marketplaceId || 'EBAY_US';

    try {
      // Extract fields from metadata with type safety
      const title = (metadata.title as string) || 'Untitled Product';
      const description = metadata.description as string | undefined;
      const brand = metadata.brand as string | undefined;
      const condition = metadata.condition as string | undefined;
      const materials = metadata.materials as string[] | undefined;
      const color = metadata.color as string | undefined;
      const size = metadata.size as string | undefined;
      const price = metadata.price as number | undefined;
      const currency = metadata.currency as string | undefined;
      const sku = (metadata.sku as string) || `VOPI-${Date.now()}`;

      logger.debug({ sku, marketplaceId }, 'Creating eBay inventory item');

      // Step 1: Create inventory item
      const inventoryItem: EbayInventoryItem = {
        product: {
          title,
          description,
          brand,
          aspects: {},
          imageUrls: [],
        },
        condition: this.mapCondition(condition),
        availability: {
          shipToLocationAvailability: {
            quantity: 1, // Default to 1 item
          },
        },
      };

      // Add aspects (eBay's term for product attributes)
      if (materials?.length) {
        inventoryItem.product.aspects!['Material'] = materials;
      }
      if (color) {
        inventoryItem.product.aspects!['Color'] = [color];
      }
      if (size) {
        inventoryItem.product.aspects!['Size'] = [size];
      }

      // Create/update inventory item
      await this.makeRequest(
        accessToken,
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        'PUT',
        inventoryItem
      );

      logger.info({ sku }, 'eBay inventory item created');

      // Step 2: Create offer (if not draft-only)
      if (options?.publishAsDraft !== true) {
        const offer: EbayOffer = {
          sku,
          marketplaceId,
          format: 'FIXED_PRICE',
          listingDescription: description,
          availableQuantity: 1,
          pricingSummary: {
            price: {
              value: price?.toString() || '0.00',
              currency: currency || 'USD',
            },
          },
          listingPolicies: {
            // These would need to be set up in the seller's eBay account
            // or fetched via the Account API
          },
        };

        try {
          const offerResult = await this.makeRequest(
            accessToken,
            '/sell/inventory/v1/offer',
            'POST',
            offer
          ) as { offerId: string } | null;

          if (offerResult?.offerId) {
            logger.info({ sku, offerId: offerResult.offerId }, 'eBay offer created');
          }
        } catch (error) {
          // Offer creation might fail if policies aren't set up
          logger.warn({ sku, error }, 'Failed to create offer, inventory item was created');
        }
      }

      return {
        success: true,
        productId: sku,
        productUrl: `https://www.ebay.com/itm/${sku}`, // Approximate URL
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: message }, 'Failed to create eBay listing');
      return { success: false, error: message };
    }
  }

  /**
   * Update an existing inventory item
   */
  async updateProduct(
    accessToken: string,
    productId: string,
    metadata: Record<string, unknown>
  ): Promise<ProductCreationResult> {
    // eBay uses the same PUT endpoint for create and update
    return this.createProduct(accessToken, { ...metadata, sku: productId });
  }

  /**
   * Upload images to an inventory item
   */
  async uploadImages(
    accessToken: string,
    productId: string,
    imageUrls: string[]
  ): Promise<ImageUploadResult[]> {
    try {
      logger.debug(
        { productId, imageCount: imageUrls.length },
        'Adding images to eBay inventory item'
      );

      // Get current inventory item
      const currentItem = await this.makeRequest(
        accessToken,
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(productId)}`,
        'GET'
      ) as EbayInventoryItem | null;

      if (!currentItem) {
        return imageUrls.map(() => ({
          success: false,
          error: 'Inventory item not found',
        }));
      }

      // Update with new image URLs
      currentItem.product.imageUrls = [
        ...(currentItem.product.imageUrls || []),
        ...imageUrls,
      ];

      // Update inventory item
      await this.makeRequest(
        accessToken,
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(productId)}`,
        'PUT',
        currentItem
      );

      logger.info({ productId, imageCount: imageUrls.length }, 'Images added to eBay item');

      return imageUrls.map((url, index) => ({
        success: true,
        imageId: `image-${index}`,
        imageUrl: url,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ productId, error: message }, 'Failed to add images to eBay item');
      return imageUrls.map(() => ({ success: false, error: message }));
    }
  }

  /**
   * Delete an inventory item
   */
  async deleteProduct(
    accessToken: string,
    productId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      logger.debug({ productId }, 'Deleting eBay inventory item');

      await this.makeRequest(
        accessToken,
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(productId)}`,
        'DELETE'
      );

      logger.info({ productId }, 'eBay inventory item deleted');

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ productId, error: message }, 'Failed to delete eBay item');
      return { success: false, error: message };
    }
  }

  /**
   * Verify token is still valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    try {
      await this.makeRequest(
        accessToken,
        '/commerce/identity/v1/user/',
        'GET'
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Map VOPI condition to eBay condition
   */
  private mapCondition(condition?: string): string {
    switch (condition) {
      case 'new':
        return 'NEW';
      case 'refurbished':
        return 'CERTIFIED_REFURBISHED';
      case 'used':
        return 'USED_EXCELLENT';
      case 'open_box':
        return 'NEW_OTHER';
      default:
        return 'NEW';
    }
  }
}

export const ebayProvider = new EbayProvider();

import { getLogger } from '../../utils/logger.js';
import type {
  EcommerceProvider,
  ProductCreationResult,
  ImageUploadResult,
} from '../../types/auth.types.js';

const logger = getLogger().child({ provider: 'shopify-ecommerce' });

const SHOPIFY_API_VERSION = '2024-01';

interface ShopifyProductInput {
  title: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
}

interface ShopifyMediaInput {
  originalSource: string;
  mediaContentType: 'IMAGE';
}

/**
 * Shopify E-Commerce Provider
 * Uses GraphQL Admin API for product management
 */
class ShopifyProvider implements EcommerceProvider {
  /**
   * Make a GraphQL request to Shopify Admin API
   */
  private async graphqlRequest(
    shop: string,
    accessToken: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<unknown> {
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify GraphQL request failed: ${error}`);
    }

    const result = await response.json();

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
  }

  /**
   * Create a product in Shopify
   */
  async createProduct(
    accessToken: string,
    metadata: Record<string, unknown>,
    options?: { publishAsDraft?: boolean; shop?: string }
  ): Promise<ProductCreationResult> {
    const shop = options?.shop as string;
    if (!shop) {
      return { success: false, error: 'Shop domain is required' };
    }

    try {
      // Extract fields from metadata with type safety
      const title = (metadata.title as string) || 'Untitled Product';
      const description = metadata.description as string | undefined;
      const brand = metadata.brand as string | undefined;
      const category = metadata.category as string | undefined;
      const tags = metadata.tags as string[] | undefined;

      // Build product input
      const input: ShopifyProductInput = {
        title,
        descriptionHtml: description,
        vendor: brand,
        productType: category,
        tags,
        status: options?.publishAsDraft !== false ? 'DRAFT' : 'ACTIVE',
      };

      logger.debug({ shop, title: input.title }, 'Creating Shopify product');

      const mutation = `
        mutation productCreate($input: ProductInput!) {
          productCreate(input: $input) {
            product {
              id
              handle
              onlineStoreUrl
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const result = await this.graphqlRequest(shop, accessToken, mutation, {
        input,
      }) as {
        productCreate: {
          product?: { id: string; handle: string; onlineStoreUrl?: string };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      if (result.productCreate.userErrors.length > 0) {
        const errors = result.productCreate.userErrors
          .map((e) => e.message)
          .join(', ');
        return { success: false, error: errors };
      }

      if (!result.productCreate.product) {
        return { success: false, error: 'No product returned from Shopify' };
      }

      const productId = result.productCreate.product.id;
      const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
      const productUrl = result.productCreate.product.onlineStoreUrl ||
        `https://${shopDomain}/admin/products/${productId.split('/').pop()}`;

      logger.info({ shop, productId }, 'Shopify product created');

      return {
        success: true,
        productId,
        productUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ shop, error: message }, 'Failed to create Shopify product');
      return { success: false, error: message };
    }
  }

  /**
   * Update an existing product
   */
  async updateProduct(
    accessToken: string,
    productId: string,
    metadata: Record<string, unknown>,
    options?: { shop?: string }
  ): Promise<ProductCreationResult> {
    const shop = options?.shop as string;
    if (!shop) {
      return { success: false, error: 'Shop domain is required' };
    }

    try {
      // Extract fields from metadata with type safety
      const title = metadata.title as string | undefined;
      const description = metadata.description as string | undefined;
      const brand = metadata.brand as string | undefined;
      const category = metadata.category as string | undefined;
      const tags = metadata.tags as string[] | undefined;

      const input: ShopifyProductInput & { id: string } = {
        id: productId,
        title: title!,
        descriptionHtml: description,
        vendor: brand,
        productType: category,
        tags,
      };

      // Remove undefined fields
      Object.keys(input).forEach((key) => {
        if (input[key as keyof typeof input] === undefined) {
          delete input[key as keyof typeof input];
        }
      });

      logger.debug({ shop, productId }, 'Updating Shopify product');

      const mutation = `
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
              handle
              onlineStoreUrl
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const result = await this.graphqlRequest(shop, accessToken, mutation, {
        input,
      }) as {
        productUpdate: {
          product?: { id: string; handle: string; onlineStoreUrl?: string };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      if (result.productUpdate.userErrors.length > 0) {
        const errors = result.productUpdate.userErrors
          .map((e) => e.message)
          .join(', ');
        return { success: false, error: errors };
      }

      logger.info({ shop, productId }, 'Shopify product updated');

      return {
        success: true,
        productId,
        productUrl: result.productUpdate.product?.onlineStoreUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ shop, productId, error: message }, 'Failed to update Shopify product');
      return { success: false, error: message };
    }
  }

  /**
   * Upload images to a product
   */
  async uploadImages(
    accessToken: string,
    productId: string,
    imageUrls: string[],
    options?: { shop?: string }
  ): Promise<ImageUploadResult[]> {
    const shop = options?.shop as string;
    if (!shop) {
      return imageUrls.map(() => ({ success: false, error: 'Shop domain is required' }));
    }

    try {
      logger.debug(
        { shop, productId, imageCount: imageUrls.length },
        'Uploading images to Shopify product'
      );

      // Prepare media input
      const media: ShopifyMediaInput[] = imageUrls.map((url) => ({
        originalSource: url,
        mediaContentType: 'IMAGE',
      }));

      const mutation = `
        mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media {
              ... on MediaImage {
                id
                image {
                  url
                }
              }
            }
            mediaUserErrors {
              field
              message
            }
          }
        }
      `;

      const result = await this.graphqlRequest(shop, accessToken, mutation, {
        productId,
        media,
      }) as {
        productCreateMedia: {
          media: Array<{ id: string; image?: { url: string } }>;
          mediaUserErrors: Array<{ field: string[]; message: string }>;
        };
      };

      if (result.productCreateMedia.mediaUserErrors.length > 0) {
        const errors = result.productCreateMedia.mediaUserErrors
          .map((e) => e.message)
          .join(', ');
        return imageUrls.map(() => ({ success: false, error: errors }));
      }

      logger.info(
        { shop, productId, uploaded: result.productCreateMedia.media.length },
        'Images uploaded to Shopify'
      );

      return result.productCreateMedia.media.map((m) => ({
        success: true,
        imageId: m.id,
        imageUrl: m.image?.url,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { shop, productId, error: message },
        'Failed to upload images to Shopify'
      );
      return imageUrls.map(() => ({ success: false, error: message }));
    }
  }

  /**
   * Delete a product
   */
  async deleteProduct(
    accessToken: string,
    productId: string,
    options?: { shop?: string }
  ): Promise<{ success: boolean; error?: string }> {
    const shop = options?.shop as string;
    if (!shop) {
      return { success: false, error: 'Shop domain is required' };
    }

    try {
      logger.debug({ shop, productId }, 'Deleting Shopify product');

      const mutation = `
        mutation productDelete($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors {
              field
              message
            }
          }
        }
      `;

      const result = await this.graphqlRequest(shop, accessToken, mutation, {
        input: { id: productId },
      }) as {
        productDelete: {
          deletedProductId?: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      if (result.productDelete.userErrors.length > 0) {
        const errors = result.productDelete.userErrors
          .map((e) => e.message)
          .join(', ');
        return { success: false, error: errors };
      }

      logger.info({ shop, productId }, 'Shopify product deleted');

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ shop, productId, error: message }, 'Failed to delete Shopify product');
      return { success: false, error: message };
    }
  }

  /**
   * Verify token is still valid
   */
  async verifyToken(accessToken: string, options?: { shop?: string }): Promise<boolean> {
    const shop = options?.shop as string;
    if (!shop) {
      return false;
    }

    try {
      const query = `{ shop { name } }`;
      await this.graphqlRequest(shop, accessToken, query);
      return true;
    } catch {
      return false;
    }
  }
}

export const shopifyProvider = new ShopifyProvider();

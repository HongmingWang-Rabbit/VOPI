import { getLogger } from '../../utils/logger.js';
import type {
  EcommerceProvider,
  ProductCreationResult,
  ImageUploadResult,
} from '../../types/auth.types.js';
import { mapWeightUnitToShopify } from '../../types/product-metadata.types.js';
import { SHOPIFY_API_VERSION } from '../../utils/constants.js';

const logger = getLogger().child({ provider: 'shopify-ecommerce' });

interface ShopifyMediaInput {
  originalSource: string;
  mediaContentType: 'IMAGE';
}

interface ProductSetResponse {
  productSet: {
    product?: { id: string; handle: string; onlineStoreUrl?: string };
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

const PRODUCT_SET_MUTATION = `
  mutation productSet($input: ProductSetInput!) {
    productSet(input: $input) {
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
   * Build metafields array from metadata attributes
   */
  private buildMetafields(metadata: {
    materials?: string[];
    color?: string;
    gender?: string;
    style?: string;
  }): Array<{ namespace: string; key: string; value: string; type: string }> {
    const metafields: Array<{ namespace: string; key: string; value: string; type: string }> = [];

    if (metadata.materials && metadata.materials.length > 0) {
      metafields.push({
        namespace: 'custom',
        key: 'materials',
        value: JSON.stringify(metadata.materials),
        type: 'list.single_line_text_field',
      });
    }

    const singleLineFields = [
      { key: 'color', value: metadata.color },
      { key: 'gender', value: metadata.gender },
      { key: 'style', value: metadata.style },
    ] as const;

    for (const field of singleLineFields) {
      if (field.value) {
        metafields.push({
          namespace: 'custom',
          key: field.key,
          value: field.value,
          type: 'single_line_text_field',
        });
      }
    }

    return metafields;
  }

  /**
   * Build a ProductSetInput from metadata for productSet mutation
   */
  private buildProductSetInput(
    metadata: Record<string, unknown>,
    options?: { publishAsDraft?: boolean; productId?: string }
  ): Record<string, unknown> {
    const title = (metadata.title as string) || 'Untitled Product';
    const description = metadata.description as string | undefined;
    const brand = metadata.brand as string | undefined;
    const category = metadata.category as string | undefined;
    const tags = metadata.tags as string[] | undefined;
    const price = metadata.price as number | undefined;
    const compareAtPrice = metadata.compareAtPrice as number | undefined;
    const sku = metadata.sku as string | undefined;
    const barcode = metadata.barcode as string | undefined;
    const weight = metadata.weight as { value?: number; unit?: string } | undefined;
    const shortDescription = metadata.shortDescription as string | undefined;
    const materials = metadata.materials as string[] | undefined;
    const color = metadata.color as string | undefined;
    const gender = metadata.gender as string | undefined;
    const style = metadata.style as string | undefined;

    const input: Record<string, unknown> = {
      title,
      descriptionHtml: description,
      vendor: brand,
      productType: category,
      tags,
    };

    if (options?.productId) {
      input.id = options.productId;
    }

    // Only set status on create (no productId)
    if (!options?.productId) {
      input.status = options?.publishAsDraft !== false ? 'DRAFT' : 'ACTIVE';
    }

    // SEO - only set when shortDescription is available
    if (shortDescription) {
      input.seo = {
        title,
        description: shortDescription,
      };
    }

    // Variant with pricing, SKU, barcode, weight
    if (price !== undefined || compareAtPrice !== undefined || sku || barcode || weight?.value) {
      const variant: Record<string, unknown> = {};
      if (price !== undefined) variant.price = price.toFixed(2);
      if (compareAtPrice !== undefined) variant.compareAtPrice = compareAtPrice.toFixed(2);
      if (sku) variant.sku = sku;
      if (barcode) variant.barcode = barcode;
      if (weight?.value) {
        const weightUnit = weight.unit ? mapWeightUnitToShopify(weight.unit as 'g' | 'kg' | 'oz' | 'lb' | 'pounds') : undefined;
        if (!weightUnit) {
          logger.debug({ unit: weight.unit }, 'Unknown weight unit, falling back to POUNDS');
        }
        variant.inventoryItem = {
          measurement: {
            weight: {
              value: weight.value,
              unit: weightUnit || 'POUNDS',
            },
          },
        };
      }
      input.variants = [variant];
    }

    // Metafields
    const metafields = this.buildMetafields({ materials, color, gender, style });
    if (metafields.length > 0) {
      input.metafields = metafields;
    }

    // Remove undefined fields
    for (const key of Object.keys(input)) {
      if (input[key] === undefined) {
        delete input[key];
      }
    }

    return input;
  }

  /**
   * Create a product in Shopify using productSet mutation
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
      const input = this.buildProductSetInput(metadata, {
        publishAsDraft: options?.publishAsDraft,
      });

      logger.debug({ shop, title: input.title }, 'Creating Shopify product via productSet');

      const result = await this.graphqlRequest(shop, accessToken, PRODUCT_SET_MUTATION, {
        input,
      }) as ProductSetResponse;

      if (result.productSet.userErrors.length > 0) {
        const errors = result.productSet.userErrors
          .map((e) => e.message)
          .join(', ');
        return { success: false, error: errors };
      }

      if (!result.productSet.product) {
        return { success: false, error: 'No product returned from Shopify' };
      }

      const productId = result.productSet.product.id;
      const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
      const productUrl = result.productSet.product.onlineStoreUrl ||
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
   * Update an existing product using productSet mutation
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
      const input = this.buildProductSetInput(metadata, { productId });

      logger.debug({ shop, productId }, 'Updating Shopify product via productSet');

      const result = await this.graphqlRequest(shop, accessToken, PRODUCT_SET_MUTATION, {
        input,
      }) as ProductSetResponse;

      if (result.productSet.userErrors.length > 0) {
        const errors = result.productSet.userErrors
          .map((e) => e.message)
          .join(', ');
        return { success: false, error: errors };
      }

      logger.info({ shop, productId }, 'Shopify product updated');

      return {
        success: true,
        productId,
        productUrl: result.productSet.product?.onlineStoreUrl,
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

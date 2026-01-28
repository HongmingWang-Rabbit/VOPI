/**
 * Product Metadata Types
 *
 * Comprehensive type definitions for structured product metadata
 * extracted from audio/video analysis for e-commerce platforms.
 *
 * Supports multiple platforms:
 * - Shopify: GraphQL productCreate mutation format
 * - Amazon: SP-API Listings Items format (JSON schema)
 * - eBay: Inventory API or Trading API format
 */

import { z } from 'zod';
import { PIPELINE_VERSION } from '../utils/constants.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ service: 'product-metadata' });

/**
 * Product dimensions
 */
export interface ProductDimensions {
  length?: number;
  width?: number;
  height?: number;
  unit: 'cm' | 'in' | 'mm';
}

/**
 * Product weight
 */
export interface ProductWeight {
  value: number;
  unit: 'g' | 'kg' | 'oz' | 'lb' | 'pounds';  // Amazon requires full name
}

/**
 * Product variant
 */
export interface ProductVariant {
  variantId: string;
  name: string;
  sku?: string;
  barcode?: string;
  price?: number;
  compareAtPrice?: number;
  /** Variant options, e.g., { color: 'Blue', size: 'Large' } */
  options: Record<string, string>;
  weight?: ProductWeight;
  inventoryQuantity?: number;
}

/**
 * Confidence scores for different metadata fields
 */
export interface MetadataConfidence {
  /** Overall confidence 0-100 */
  overall: number;
  /** Title confidence 0-100 */
  title: number;
  /** Description confidence 0-100 */
  description: number;
  /** Price confidence 0-100 (if extracted) */
  price?: number;
  /** Attributes confidence 0-100 */
  attributes?: number;
}

/**
 * Comprehensive product metadata for e-commerce platforms
 *
 * Based on latest platform requirements (2025-2026):
 * - Shopify: title, description, product_type, tags
 * - Amazon: item_name, bullet_points, generic_keywords, browse_nodes
 * - eBay: Title, itemSpecifics, category
 */
export interface ProductMetadata {
  // === CORE (All Platforms) ===
  /** Product title - Shopify: title, Amazon: item_name, eBay: Title */
  title: string;
  /** Full HTML/text description */
  description: string;
  /** Brief summary for previews */
  shortDescription?: string;

  // === BULLET POINTS (Amazon requires up to 5) ===
  /** Key features as bullet points */
  bulletPoints: string[];

  // === PRICING ===
  /** List price */
  price?: number;
  /** ISO 4217 currency code (USD, EUR, etc.) */
  currency?: string;
  /** Original price for sales/discounts */
  compareAtPrice?: number;
  /** Cost for profit calculation */
  costPerItem?: number;

  // === BRAND & MANUFACTURER (Amazon required) ===
  brand?: string;
  manufacturer?: string;
  /** Amazon: country_of_origin (required for some categories) */
  countryOfOrigin?: string;

  // === PHYSICAL ATTRIBUTES ===
  dimensions?: ProductDimensions;
  weight?: ProductWeight;
  /** Amazon: item_package_dimensions */
  packageDimensions?: ProductDimensions;
  /** Amazon: item_package_weight */
  packageWeight?: ProductWeight;

  // === MATERIALS & APPEARANCE ===
  /** Primary materials (leather, cotton, etc.) */
  materials?: string[];
  /** Primary color */
  color?: string;
  /** All available colors */
  colors?: string[];
  /** Pattern (solid, striped, etc.) */
  pattern?: string;
  /** Size if single */
  size?: string;
  /** Available sizes */
  sizes?: string[];

  // === CATEGORIZATION ===
  /** Main category */
  category?: string;
  /** Subcategory */
  subcategory?: string;
  /** Shopify: product_type */
  productType?: string;
  /** Shopify: tags */
  tags?: string[];
  /** Amazon: generic_keywords (search terms) */
  keywords?: string[];
  /** Amazon: recommended_browse_nodes */
  browseNodes?: string[];

  // === ITEM SPECIFICS (eBay) ===
  /** Category-specific attributes for eBay */
  itemSpecifics?: Record<string, string | string[]>;

  // === VARIANTS ===
  variants?: ProductVariant[];

  // === CONDITION ===
  condition?: 'new' | 'refurbished' | 'used' | 'open_box';
  conditionDescription?: string;

  // === DEMOGRAPHICS ===
  /** Gender/department (e.g., "Men", "Women", "Unisex") */
  gender?: string;
  /** Target audience (e.g., "adults", "teens") */
  targetAudience?: string;
  /** Age group (e.g., "adult", "child", "infant") */
  ageGroup?: string;
  /** Style (e.g., "casual", "formal", "athletic") */
  style?: string;
  /** Model number (separate from MPN) */
  modelNumber?: string;

  // === IDENTIFIERS ===
  sku?: string;
  /** UPC, EAN, ISBN barcode */
  barcode?: string;
  barcodeType?: 'UPC' | 'EAN' | 'ISBN' | 'GTIN';
  /** Manufacturer Part Number */
  mpn?: string;

  // === ADDITIONAL AMAZON FIELDS ===
  warrantyDescription?: string;
  numberOfItems?: number;
  batteriesRequired?: boolean;
  batteriesIncluded?: boolean;

  // === CARE & USAGE ===
  careInstructions?: string[];
  usageInstructions?: string;
  warnings?: string[];

  // === CONFIDENCE TRACKING ===
  confidence: MetadataConfidence;

  // === SOURCE TRACKING ===
  /** Whether metadata was extracted from audio */
  extractedFromAudio: boolean;
  /** Relevant quotes from transcript that informed the metadata */
  transcriptExcerpts?: string[];
}

/**
 * Shopify-formatted product data
 * For GraphQL productCreate mutation
 */
export interface ShopifyProductInput {
  title: string;
  descriptionHtml: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  seo?: {
    title?: string;
    description?: string;
  };
  variants?: Array<{
    price: string;
    compareAtPrice?: string;
    sku?: string;
    barcode?: string;
    inventoryQuantity?: number;
    weight?: number;
    weightUnit?: 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES';
    options?: string[];
  }>;
  options?: string[];
  metafields?: Array<{
    namespace: string;
    key: string;
    value: string;
    type: string;
  }>;
}

/**
 * Amazon SP-API Listings Items format
 */
export interface AmazonListingInput {
  /** Required: item_name */
  item_name: string;
  /** Required: brand_name */
  brand_name?: string;
  /** Required for most categories */
  manufacturer?: string;
  /** Up to 5 bullet points */
  bullet_point?: string[];
  /** Product description */
  product_description?: string;
  /** Search keywords */
  generic_keyword?: string[];
  /** Browse node IDs */
  recommended_browse_nodes?: string[];
  /** Country of origin */
  country_of_origin?: string;
  /** Item dimensions */
  item_dimensions?: {
    length?: { value: number; unit: string };
    width?: { value: number; unit: string };
    height?: { value: number; unit: string };
  };
  /** Item weight */
  item_weight?: { value: number; unit: string };
  /** Package dimensions */
  item_package_dimensions?: {
    length?: { value: number; unit: string };
    width?: { value: number; unit: string };
    height?: { value: number; unit: string };
  };
  /** Package weight */
  item_package_weight?: { value: number; unit: string };
  /** Primary color */
  color?: string;
  /** Material */
  material?: string[];
  /** Condition */
  condition_type?: 'new_new' | 'refurbished' | 'used_like_new' | 'used_very_good' | 'used_good' | 'used_acceptable';
  /** External product ID (UPC, EAN, etc.) */
  externally_assigned_product_identifier?: Array<{
    type: 'upc' | 'ean' | 'gtin' | 'isbn';
    value: string;
  }>;
  /** Number of items in package */
  number_of_items?: number;
  /** Warranty description */
  warranty_description?: string;
  /** Batteries required */
  batteries_required?: boolean;
  /** Batteries included */
  are_batteries_included?: boolean;
  /** Pricing */
  standard_price?: { value: number; currency: string };
  /** Gender/department */
  department?: string;
  /** Target audience keywords */
  target_audience_keyword?: string[];
  /** Age range description */
  age_range_description?: string;
  /** Model number */
  model_number?: string;
  /** Style */
  style?: string;
  /** Size */
  size?: string;
  /** Pattern */
  pattern?: string;
}

/**
 * eBay Inventory API format
 */
export interface EbayListingInput {
  /** eBay: Title (max 80 chars) */
  title: string;
  /** Full description (HTML allowed) */
  description: string;
  /** Item condition */
  condition: 'NEW' | 'LIKE_NEW' | 'NEW_OTHER' | 'NEW_WITH_DEFECTS' | 'CERTIFIED_REFURBISHED' | 'EXCELLENT_REFURBISHED' | 'VERY_GOOD_REFURBISHED' | 'GOOD_REFURBISHED' | 'SELLER_REFURBISHED' | 'USED_EXCELLENT' | 'USED_VERY_GOOD' | 'USED_GOOD' | 'USED_ACCEPTABLE' | 'FOR_PARTS_OR_NOT_WORKING';
  conditionDescription?: string;
  /** Category-specific attributes */
  aspects?: Record<string, string[]>;
  /** eBay category ID */
  categoryId?: string;
  /** Brand */
  brand?: string;
  /** MPN */
  mpn?: string;
  /** Product identifiers */
  product?: {
    upc?: string[];
    ean?: string[];
    isbn?: string[];
  };
  /** Pricing summary for fixed-price listings */
  pricingSummary?: {
    price: { value: string; currency: string };
  };
  /** Package weight and dimensions */
  packageWeightAndSize?: {
    dimensions?: {
      length: number;
      width: number;
      height: number;
      unit: 'INCH' | 'CENTIMETER';
    };
    weight?: {
      value: number;
      unit: 'POUND' | 'KILOGRAM' | 'OUNCE' | 'GRAM';
    };
  };
}

/**
 * Complete metadata output file structure
 * This is what gets saved to metadata.json in S3
 */
export interface MetadataFileOutput {
  /** Raw transcript from audio */
  transcript: string;
  /** Universal product metadata */
  product: ProductMetadata;
  /** Platform-specific formatted versions */
  platforms: {
    shopify: ShopifyProductInput;
    amazon: AmazonListingInput;
    ebay: EbayListingInput;
  };
  /** ISO timestamp when metadata was extracted */
  extractedAt: string;
  /** Audio duration in seconds (if available) */
  audioDuration?: number;
  /** Pipeline version */
  pipelineVersion: string;
}

// ============================================================================
// Unit Mapping Helpers
// ============================================================================

type ProductWeightUnit = ProductWeight['unit'];

/**
 * Map internal weight unit to Shopify weight unit
 */
export function mapWeightUnitToShopify(unit: ProductWeightUnit): 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES' | undefined {
  switch (unit) {
    case 'g': return 'GRAMS';
    case 'kg': return 'KILOGRAMS';
    case 'oz': return 'OUNCES';
    case 'lb':
    case 'pounds': return 'POUNDS';
    default: return undefined;
  }
}

/**
 * Map internal weight unit to Amazon weight unit (full name)
 */
export function mapWeightUnitToAmazon(unit: ProductWeightUnit): string {
  switch (unit) {
    case 'g': return 'grams';
    case 'kg': return 'kilograms';
    case 'oz': return 'ounces';
    case 'lb':
    case 'pounds': return 'pounds';
    default: return 'pounds';
  }
}

/**
 * Map internal weight unit to eBay weight unit
 */
export function mapWeightUnitToEbay(unit: ProductWeightUnit): 'POUND' | 'KILOGRAM' | 'OUNCE' | 'GRAM' {
  switch (unit) {
    case 'g': return 'GRAM';
    case 'kg': return 'KILOGRAM';
    case 'oz': return 'OUNCE';
    case 'lb':
    case 'pounds': return 'POUND';
    default: return 'POUND';
  }
}

type ProductDimensionUnit = ProductDimensions['unit'];

/**
 * Map internal dimension unit to Amazon dimension unit
 */
export function mapDimensionUnitToAmazon(unit: ProductDimensionUnit): string {
  switch (unit) {
    case 'cm': return 'centimeters';
    case 'in': return 'inches';
    case 'mm': return 'millimeters';
    default: return 'inches';
  }
}

/**
 * Map internal dimension unit to eBay dimension unit
 */
export function mapDimensionUnitToEbay(unit: ProductDimensionUnit): 'INCH' | 'CENTIMETER' {
  return unit === 'in' ? 'INCH' : 'CENTIMETER';
}

/**
 * Zod schema for Gemini audio analysis response validation
 */
export const geminiAudioAnalysisResponseSchema = z.object({
  transcript: z.string(),
  language: z.string().default('en'),
  audioQuality: z.number().min(0).max(100),
  product: z.object({
    title: z.string(),
    description: z.string(),
    shortDescription: z.string().nullish(),
    bulletPoints: z.array(z.string()).default([]),
    // Use nullish() for optional fields - Gemini may return null when info is unavailable
    brand: z.string().nullish(),
    category: z.string().nullish(),
    subcategory: z.string().nullish(),
    materials: z.array(z.string()).nullish(),
    color: z.string().nullish(),
    colors: z.array(z.string()).nullish(),
    size: z.string().nullish(),
    sizes: z.array(z.string()).nullish(),
    price: z.object({
      value: z.number(),
      currency: z.string(),
    }).nullish(),
    keywords: z.array(z.string()).nullish(),
    tags: z.array(z.string()).nullish(),
    condition: z.enum(['new', 'refurbished', 'used', 'open_box']).nullish(),
    features: z.array(z.string()).nullish(),
    // Dimensions object with nullish inner fields - Gemini returns null for unknown dimensions
    // Unit uses transform to handle null -> default 'in' (most common for US e-commerce)
    dimensions: z.object({
      length: z.number().nullish(),
      width: z.number().nullish(),
      height: z.number().nullish(),
      unit: z.string().nullish().transform(v => v ?? 'in'),
    }).nullish(),
    // Weight object with nullish inner fields - Gemini returns null for unknown weight
    // Unit uses transform to handle null -> default 'lb' (most common for US e-commerce)
    weight: z.object({
      value: z.number().nullish(),
      unit: z.string().nullish().transform(v => v ?? 'lb'),
    }).nullish(),
    careInstructions: z.array(z.string()).nullish(),
    warnings: z.array(z.string()).nullish(),
    gender: z.string().nullish(),
    targetAudience: z.string().nullish(),
    ageGroup: z.string().nullish(),
    style: z.string().nullish(),
    modelNumber: z.string().nullish(),
  }),
  confidence: z.object({
    overall: z.number().min(0).max(100),
    title: z.number().min(0).max(100),
    description: z.number().min(0).max(100),
    price: z.number().min(0).max(100).nullish(),
    attributes: z.number().min(0).max(100).nullish(),
  }),
  relevantExcerpts: z.array(z.string()).default([]),
});

/**
 * Gemini audio analysis response type (inferred from Zod schema)
 * What we expect from the AI when analyzing audio
 */
export type GeminiAudioAnalysisResponse = z.infer<typeof geminiAudioAnalysisResponseSchema>;

/**
 * Parse and validate a Gemini audio analysis response
 * @throws ZodError if validation fails
 */
export function parseGeminiAudioAnalysisResponse(data: unknown): GeminiAudioAnalysisResponse {
  return geminiAudioAnalysisResponseSchema.parse(data);
}

/**
 * Safely parse a Gemini audio analysis response
 * Returns success: true with data, or success: false with error
 */
export function safeParseGeminiAudioAnalysisResponse(data: unknown): z.SafeParseReturnType<unknown, GeminiAudioAnalysisResponse> {
  return geminiAudioAnalysisResponseSchema.safeParse(data);
}

/**
 * Format universal ProductMetadata to Shopify input
 */
export function formatForShopify(metadata: ProductMetadata): ShopifyProductInput {
  const shopify: ShopifyProductInput = {
    title: metadata.title,
    descriptionHtml: metadata.description,
    productType: metadata.productType || metadata.category,
    vendor: metadata.brand,
    tags: metadata.tags,
    status: 'DRAFT',
  };

  // Add SEO data
  if (metadata.shortDescription) {
    shopify.seo = {
      title: metadata.title,
      description: metadata.shortDescription,
    };
  }

  // Add variant if we have pricing
  if (metadata.price !== undefined) {
    shopify.variants = [{
      price: metadata.price.toFixed(2),
      compareAtPrice: metadata.compareAtPrice?.toFixed(2),
      sku: metadata.sku,
      barcode: metadata.barcode,
      weight: metadata.weight?.value,
      weightUnit: metadata.weight?.unit ? mapWeightUnitToShopify(metadata.weight.unit) : undefined,
    }];
  }

  // Add options for variants
  if (metadata.colors && metadata.colors.length > 0) {
    shopify.options = ['Color'];
  }
  if (metadata.sizes && metadata.sizes.length > 0) {
    shopify.options = [...(shopify.options || []), 'Size'];
  }

  // Add metafields for filterable attributes
  const metafields: ShopifyProductInput['metafields'] = [];
  if (metadata.materials && metadata.materials.length > 0) {
    metafields.push({
      namespace: 'custom',
      key: 'materials',
      value: JSON.stringify(metadata.materials),
      type: 'list.single_line_text_field',
    });
  }
  if (metadata.careInstructions && metadata.careInstructions.length > 0) {
    metafields.push({
      namespace: 'custom',
      key: 'care_instructions',
      value: JSON.stringify(metadata.careInstructions),
      type: 'list.single_line_text_field',
    });
  }
  if (metadata.gender) {
    metafields.push({
      namespace: 'custom',
      key: 'gender',
      value: metadata.gender,
      type: 'single_line_text_field',
    });
  }
  if (metafields.length > 0) {
    shopify.metafields = metafields;
  }

  return shopify;
}

/**
 * Format universal ProductMetadata to Amazon input
 */
export function formatForAmazon(metadata: ProductMetadata): AmazonListingInput {
  const amazon: AmazonListingInput = {
    item_name: metadata.title,
    brand_name: metadata.brand,
    manufacturer: metadata.manufacturer || metadata.brand,
    product_description: metadata.description,
    bullet_point: metadata.bulletPoints.slice(0, 5), // Amazon max 5
    generic_keyword: metadata.keywords,
    country_of_origin: metadata.countryOfOrigin,
    color: metadata.color,
    material: metadata.materials,
  };

  // Add dimensions
  if (metadata.dimensions) {
    const unit = mapDimensionUnitToAmazon(metadata.dimensions.unit);
    amazon.item_dimensions = {};
    if (metadata.dimensions.length) amazon.item_dimensions.length = { value: metadata.dimensions.length, unit };
    if (metadata.dimensions.width) amazon.item_dimensions.width = { value: metadata.dimensions.width, unit };
    if (metadata.dimensions.height) amazon.item_dimensions.height = { value: metadata.dimensions.height, unit };
  }

  // Add weight
  if (metadata.weight) {
    const unit = mapWeightUnitToAmazon(metadata.weight.unit);
    amazon.item_weight = { value: metadata.weight.value, unit };
  }

  // Add package dimensions
  if (metadata.packageDimensions) {
    const unit = mapDimensionUnitToAmazon(metadata.packageDimensions.unit);
    amazon.item_package_dimensions = {};
    if (metadata.packageDimensions.length) amazon.item_package_dimensions.length = { value: metadata.packageDimensions.length, unit };
    if (metadata.packageDimensions.width) amazon.item_package_dimensions.width = { value: metadata.packageDimensions.width, unit };
    if (metadata.packageDimensions.height) amazon.item_package_dimensions.height = { value: metadata.packageDimensions.height, unit };
  }

  // Add package weight
  if (metadata.packageWeight) {
    const unit = mapWeightUnitToAmazon(metadata.packageWeight.unit);
    amazon.item_package_weight = { value: metadata.packageWeight.value, unit };
  }

  // Add condition
  if (metadata.condition) {
    amazon.condition_type = metadata.condition === 'new' ? 'new_new' :
                            metadata.condition === 'refurbished' ? 'refurbished' :
                            metadata.condition === 'used' ? 'used_good' : 'new_new';
  }

  // Add barcode
  if (metadata.barcode && metadata.barcodeType) {
    amazon.externally_assigned_product_identifier = [{
      type: metadata.barcodeType.toLowerCase() as 'upc' | 'ean' | 'gtin' | 'isbn',
      value: metadata.barcode,
    }];
  }

  // Add additional fields
  amazon.number_of_items = metadata.numberOfItems;
  amazon.warranty_description = metadata.warrantyDescription;
  amazon.batteries_required = metadata.batteriesRequired;
  amazon.are_batteries_included = metadata.batteriesIncluded;

  // Add pricing (default currency to USD if not specified)
  if (metadata.price !== undefined) {
    amazon.standard_price = { value: metadata.price, currency: metadata.currency || 'USD' };
  }

  // Add demographics and style fields
  if (metadata.gender) amazon.department = metadata.gender;
  if (metadata.targetAudience) amazon.target_audience_keyword = [metadata.targetAudience];
  if (metadata.ageGroup) amazon.age_range_description = metadata.ageGroup;
  if (metadata.modelNumber) amazon.model_number = metadata.modelNumber;
  if (metadata.style) amazon.style = metadata.style;
  if (metadata.size) amazon.size = metadata.size;
  if (metadata.pattern) amazon.pattern = metadata.pattern;

  return amazon;
}

/** eBay title maximum character limit */
const EBAY_TITLE_MAX_LENGTH = 80;

/**
 * Format universal ProductMetadata to eBay input
 */
export function formatForEbay(metadata: ProductMetadata): EbayListingInput {
  // Map condition
  let ebayCondition: EbayListingInput['condition'] = 'NEW';
  if (metadata.condition === 'refurbished') ebayCondition = 'SELLER_REFURBISHED';
  else if (metadata.condition === 'used') ebayCondition = 'USED_GOOD';
  else if (metadata.condition === 'open_box') ebayCondition = 'NEW_OTHER';

  // Truncate title if needed, with logging
  let title = metadata.title;
  if (title.length > EBAY_TITLE_MAX_LENGTH) {
    logger.warn(
      {
        originalLength: title.length,
        maxLength: EBAY_TITLE_MAX_LENGTH,
        original: title,
        truncated: title.slice(0, EBAY_TITLE_MAX_LENGTH),
      },
      'eBay title truncated due to character limit'
    );
    title = title.slice(0, EBAY_TITLE_MAX_LENGTH);
  }

  const ebay: EbayListingInput = {
    title,
    description: metadata.description,
    condition: ebayCondition,
    conditionDescription: metadata.conditionDescription,
    brand: metadata.brand,
    mpn: metadata.mpn,
    categoryId: metadata.category, // Would need mapping to eBay category IDs
  };

  // Build aspects from itemSpecifics or construct from metadata
  // Convert all values to arrays (itemSpecifics can have string | string[])
  const aspects: Record<string, string[]> = {};
  if (metadata.itemSpecifics) {
    for (const [key, value] of Object.entries(metadata.itemSpecifics)) {
      aspects[key] = Array.isArray(value) ? value : [value];
    }
  }

  if (metadata.brand && !aspects['Brand']) {
    aspects['Brand'] = [metadata.brand];
  }
  if (metadata.color && !aspects['Color']) {
    aspects['Color'] = [metadata.color];
  }
  if (metadata.materials && metadata.materials.length > 0 && !aspects['Material']) {
    aspects['Material'] = metadata.materials;
  }
  if (metadata.size && !aspects['Size']) {
    aspects['Size'] = [metadata.size];
  }
  if (metadata.gender && !aspects['Gender']) {
    aspects['Gender'] = [metadata.gender];
  }
  if (metadata.style && !aspects['Style']) {
    aspects['Style'] = [metadata.style];
  }
  if (metadata.ageGroup && !aspects['Age Group']) {
    aspects['Age Group'] = [metadata.ageGroup];
  }
  if (metadata.pattern && !aspects['Pattern']) {
    aspects['Pattern'] = [metadata.pattern];
  }

  if (Object.keys(aspects).length > 0) {
    ebay.aspects = aspects;
  }

  // Add pricing (default currency to USD if not specified)
  if (metadata.price !== undefined) {
    ebay.pricingSummary = {
      price: { value: metadata.price.toFixed(2), currency: metadata.currency || 'USD' },
    };
  }

  // Add product identifiers
  if (metadata.barcode) {
    ebay.product = {};
    if (metadata.barcodeType === 'UPC') ebay.product.upc = [metadata.barcode];
    else if (metadata.barcodeType === 'EAN') ebay.product.ean = [metadata.barcode];
    else if (metadata.barcodeType === 'ISBN') ebay.product.isbn = [metadata.barcode];
  }

  // Add package dimensions
  if (metadata.packageDimensions || metadata.packageWeight) {
    ebay.packageWeightAndSize = {};

    if (metadata.packageDimensions) {
      ebay.packageWeightAndSize.dimensions = {
        length: metadata.packageDimensions.length || 0,
        width: metadata.packageDimensions.width || 0,
        height: metadata.packageDimensions.height || 0,
        unit: mapDimensionUnitToEbay(metadata.packageDimensions.unit),
      };
    }

    if (metadata.packageWeight) {
      ebay.packageWeightAndSize.weight = {
        value: metadata.packageWeight.value,
        unit: mapWeightUnitToEbay(metadata.packageWeight.unit),
      };
    }
  }

  return ebay;
}

/**
 * Create complete metadata file output from ProductMetadata
 */
export function createMetadataFileOutput(
  transcript: string,
  metadata: ProductMetadata,
  audioDuration?: number
): MetadataFileOutput {
  return {
    transcript,
    product: metadata,
    platforms: {
      shopify: formatForShopify(metadata),
      amazon: formatForAmazon(metadata),
      ebay: formatForEbay(metadata),
    },
    extractedAt: new Date().toISOString(),
    audioDuration,
    pipelineVersion: PIPELINE_VERSION,
  };
}

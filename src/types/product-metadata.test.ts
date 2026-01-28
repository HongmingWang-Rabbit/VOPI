/**
 * Product Metadata Types Tests
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger before importing modules that use it
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  mapWeightUnitToShopify,
  mapWeightUnitToAmazon,
  mapWeightUnitToEbay,
  mapDimensionUnitToAmazon,
  mapDimensionUnitToEbay,
  formatForShopify,
  formatForAmazon,
  formatForEbay,
  createMetadataFileOutput,
  geminiAudioAnalysisResponseSchema,
  parseGeminiAudioAnalysisResponse,
  safeParseGeminiAudioAnalysisResponse,
  type ProductMetadata,
} from './product-metadata.types.js';
import { PIPELINE_VERSION } from '../utils/constants.js';

describe('product-metadata types', () => {
  describe('weight unit mapping helpers', () => {
    describe('mapWeightUnitToShopify', () => {
      it('should map grams to GRAMS', () => {
        expect(mapWeightUnitToShopify('g')).toBe('GRAMS');
      });

      it('should map kilograms to KILOGRAMS', () => {
        expect(mapWeightUnitToShopify('kg')).toBe('KILOGRAMS');
      });

      it('should map ounces to OUNCES', () => {
        expect(mapWeightUnitToShopify('oz')).toBe('OUNCES');
      });

      it('should map lb to POUNDS', () => {
        expect(mapWeightUnitToShopify('lb')).toBe('POUNDS');
      });

      it('should map pounds to POUNDS', () => {
        expect(mapWeightUnitToShopify('pounds')).toBe('POUNDS');
      });
    });

    describe('mapWeightUnitToAmazon', () => {
      it('should map grams to full name', () => {
        expect(mapWeightUnitToAmazon('g')).toBe('grams');
      });

      it('should map kilograms to full name', () => {
        expect(mapWeightUnitToAmazon('kg')).toBe('kilograms');
      });

      it('should map ounces to full name', () => {
        expect(mapWeightUnitToAmazon('oz')).toBe('ounces');
      });

      it('should map lb to pounds', () => {
        expect(mapWeightUnitToAmazon('lb')).toBe('pounds');
      });

      it('should map pounds to pounds', () => {
        expect(mapWeightUnitToAmazon('pounds')).toBe('pounds');
      });
    });

    describe('mapWeightUnitToEbay', () => {
      it('should map grams to GRAM', () => {
        expect(mapWeightUnitToEbay('g')).toBe('GRAM');
      });

      it('should map kilograms to KILOGRAM', () => {
        expect(mapWeightUnitToEbay('kg')).toBe('KILOGRAM');
      });

      it('should map ounces to OUNCE', () => {
        expect(mapWeightUnitToEbay('oz')).toBe('OUNCE');
      });

      it('should map lb to POUND', () => {
        expect(mapWeightUnitToEbay('lb')).toBe('POUND');
      });

      it('should map pounds to POUND', () => {
        expect(mapWeightUnitToEbay('pounds')).toBe('POUND');
      });
    });
  });

  describe('dimension unit mapping helpers', () => {
    describe('mapDimensionUnitToAmazon', () => {
      it('should map cm to centimeters', () => {
        expect(mapDimensionUnitToAmazon('cm')).toBe('centimeters');
      });

      it('should map in to inches', () => {
        expect(mapDimensionUnitToAmazon('in')).toBe('inches');
      });

      it('should map mm to millimeters', () => {
        expect(mapDimensionUnitToAmazon('mm')).toBe('millimeters');
      });
    });

    describe('mapDimensionUnitToEbay', () => {
      it('should map in to INCH', () => {
        expect(mapDimensionUnitToEbay('in')).toBe('INCH');
      });

      it('should map cm to CENTIMETER', () => {
        expect(mapDimensionUnitToEbay('cm')).toBe('CENTIMETER');
      });

      it('should map mm to CENTIMETER', () => {
        expect(mapDimensionUnitToEbay('mm')).toBe('CENTIMETER');
      });
    });
  });

  describe('formatForShopify', () => {
    const baseMetadata: ProductMetadata = {
      title: 'Test Product',
      description: '<p>Test description</p>',
      bulletPoints: ['Feature 1', 'Feature 2'],
      confidence: { overall: 85, title: 90, description: 80 },
      extractedFromAudio: true,
    };

    it('should format basic product metadata', () => {
      const result = formatForShopify(baseMetadata);

      expect(result.title).toBe('Test Product');
      expect(result.descriptionHtml).toBe('<p>Test description</p>');
      expect(result.status).toBe('DRAFT');
    });

    it('should include brand as vendor', () => {
      const result = formatForShopify({ ...baseMetadata, brand: 'TestBrand' });

      expect(result.vendor).toBe('TestBrand');
    });

    it('should include tags', () => {
      const result = formatForShopify({ ...baseMetadata, tags: ['tag1', 'tag2'] });

      expect(result.tags).toEqual(['tag1', 'tag2']);
    });

    it('should format price as variant', () => {
      const result = formatForShopify({
        ...baseMetadata,
        price: 29.99,
        compareAtPrice: 39.99,
        weight: { value: 500, unit: 'g' },
      });

      expect(result.variants).toHaveLength(1);
      expect(result.variants![0].price).toBe('29.99');
      expect(result.variants![0].compareAtPrice).toBe('39.99');
      expect(result.variants![0].weight).toBe(500);
      expect(result.variants![0].weightUnit).toBe('GRAMS');
    });

    it('should add Color and Size options', () => {
      const result = formatForShopify({
        ...baseMetadata,
        colors: ['Red', 'Blue'],
        sizes: ['S', 'M', 'L'],
      });

      expect(result.options).toContain('Color');
      expect(result.options).toContain('Size');
    });

    it('should add metafields for materials', () => {
      const result = formatForShopify({
        ...baseMetadata,
        materials: ['Cotton', 'Polyester'],
      });

      expect(result.metafields).toBeDefined();
      const materialsMeta = result.metafields!.find(m => m.key === 'materials');
      expect(materialsMeta).toEqual({
        namespace: 'custom',
        key: 'materials',
        value: JSON.stringify(['Cotton', 'Polyester']),
        type: 'list.single_line_text_field',
      });
    });

    it('should add metafields for care instructions', () => {
      const result = formatForShopify({
        ...baseMetadata,
        careInstructions: ['Machine wash cold', 'Tumble dry low'],
      });

      const careMeta = result.metafields!.find(m => m.key === 'care_instructions');
      expect(careMeta).toEqual({
        namespace: 'custom',
        key: 'care_instructions',
        value: JSON.stringify(['Machine wash cold', 'Tumble dry low']),
        type: 'list.single_line_text_field',
      });
    });

    it('should add metafield for gender', () => {
      const result = formatForShopify({
        ...baseMetadata,
        gender: 'Women',
      });

      const genderMeta = result.metafields!.find(m => m.key === 'gender');
      expect(genderMeta).toEqual({
        namespace: 'custom',
        key: 'gender',
        value: 'Women',
        type: 'single_line_text_field',
      });
    });

    it('should not add metafields when no filterable attributes exist', () => {
      const result = formatForShopify(baseMetadata);

      expect(result.metafields).toBeUndefined();
    });
  });

  describe('formatForAmazon', () => {
    const baseMetadata: ProductMetadata = {
      title: 'Test Product',
      description: 'Test description',
      bulletPoints: ['Feature 1', 'Feature 2', 'Feature 3', 'Feature 4', 'Feature 5', 'Feature 6'],
      confidence: { overall: 85, title: 90, description: 80 },
      extractedFromAudio: true,
    };

    it('should format basic product metadata', () => {
      const result = formatForAmazon(baseMetadata);

      expect(result.item_name).toBe('Test Product');
      expect(result.product_description).toBe('Test description');
    });

    it('should limit bullet points to 5', () => {
      const result = formatForAmazon(baseMetadata);

      expect(result.bullet_point).toHaveLength(5);
    });

    it('should include dimensions with correct units', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        dimensions: { length: 10, width: 5, height: 3, unit: 'cm' },
      });

      expect(result.item_dimensions?.length).toEqual({ value: 10, unit: 'centimeters' });
      expect(result.item_dimensions?.width).toEqual({ value: 5, unit: 'centimeters' });
      expect(result.item_dimensions?.height).toEqual({ value: 3, unit: 'centimeters' });
    });

    it('should include weight with correct units', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        weight: { value: 2.5, unit: 'kg' },
      });

      expect(result.item_weight).toEqual({ value: 2.5, unit: 'kilograms' });
    });

    it('should include barcode as product identifier', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        barcode: '012345678901',
        barcodeType: 'UPC',
      });

      expect(result.externally_assigned_product_identifier).toEqual([
        { type: 'upc', value: '012345678901' },
      ]);
    });

    it('should include package dimensions and weight', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        packageDimensions: { length: 12, width: 8, height: 4, unit: 'in' },
        packageWeight: { value: 1.5, unit: 'lb' },
      });

      expect(result.item_package_dimensions?.length).toEqual({ value: 12, unit: 'inches' });
      expect(result.item_package_weight).toEqual({ value: 1.5, unit: 'pounds' });
    });

    it('should map condition types correctly', () => {
      expect(formatForAmazon({ ...baseMetadata, condition: 'new' }).condition_type).toBe('new_new');
      expect(formatForAmazon({ ...baseMetadata, condition: 'refurbished' }).condition_type).toBe('refurbished');
      expect(formatForAmazon({ ...baseMetadata, condition: 'used' }).condition_type).toBe('used_good');
    });

    it('should include additional Amazon-specific fields', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        numberOfItems: 2,
        warrantyDescription: '1 year warranty',
        batteriesRequired: true,
        batteriesIncluded: false,
      });

      expect(result.number_of_items).toBe(2);
      expect(result.warranty_description).toBe('1 year warranty');
      expect(result.batteries_required).toBe(true);
      expect(result.are_batteries_included).toBe(false);
    });

    it('should include standard_price with currency', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        price: 49.99,
        currency: 'EUR',
      });

      expect(result.standard_price).toEqual({ value: 49.99, currency: 'EUR' });
    });

    it('should default currency to USD for standard_price', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        price: 29.99,
      });

      expect(result.standard_price).toEqual({ value: 29.99, currency: 'USD' });
    });

    it('should map demographics and style fields', () => {
      const result = formatForAmazon({
        ...baseMetadata,
        gender: 'Women',
        targetAudience: 'adults',
        ageGroup: 'adult',
        modelNumber: 'XY-100',
        style: 'casual',
        size: 'Medium',
        pattern: 'striped',
      });

      expect(result.department).toBe('Women');
      expect(result.target_audience_keyword).toEqual(['adults']);
      expect(result.age_range_description).toBe('adult');
      expect(result.model_number).toBe('XY-100');
      expect(result.style).toBe('casual');
      expect(result.size).toBe('Medium');
      expect(result.pattern).toBe('striped');
    });

    it('should omit demographics fields when not provided', () => {
      const result = formatForAmazon(baseMetadata);

      expect(result.department).toBeUndefined();
      expect(result.target_audience_keyword).toBeUndefined();
      expect(result.age_range_description).toBeUndefined();
      expect(result.model_number).toBeUndefined();
      expect(result.style).toBeUndefined();
      expect(result.standard_price).toBeUndefined();
    });

    it('should handle missing optional fields gracefully', () => {
      const minimalMetadata: ProductMetadata = {
        title: 'Simple Product',
        description: 'Simple description',
        bulletPoints: [],
        confidence: { overall: 50, title: 50, description: 50 },
        extractedFromAudio: true,
      };

      const result = formatForAmazon(minimalMetadata);

      expect(result.item_name).toBe('Simple Product');
      expect(result.brand_name).toBeUndefined();
      expect(result.item_dimensions).toBeUndefined();
      expect(result.item_weight).toBeUndefined();
    });
  });

  describe('formatForEbay', () => {
    const baseMetadata: ProductMetadata = {
      title: 'Test Product',
      description: 'Test description',
      bulletPoints: ['Feature 1'],
      confidence: { overall: 85, title: 90, description: 80 },
      extractedFromAudio: true,
    };

    it('should format basic product metadata', () => {
      const result = formatForEbay(baseMetadata);

      expect(result.title).toBe('Test Product');
      expect(result.description).toBe('Test description');
      expect(result.condition).toBe('NEW');
    });

    it('should truncate title to 80 characters', () => {
      const longTitle = 'A'.repeat(100);
      const result = formatForEbay({ ...baseMetadata, title: longTitle });

      expect(result.title).toHaveLength(80);
    });

    it('should map condition correctly', () => {
      expect(formatForEbay({ ...baseMetadata, condition: 'refurbished' }).condition).toBe('SELLER_REFURBISHED');
      expect(formatForEbay({ ...baseMetadata, condition: 'used' }).condition).toBe('USED_GOOD');
      expect(formatForEbay({ ...baseMetadata, condition: 'open_box' }).condition).toBe('NEW_OTHER');
    });

    it('should build aspects from metadata', () => {
      const result = formatForEbay({
        ...baseMetadata,
        brand: 'TestBrand',
        color: 'Red',
        materials: ['Cotton', 'Polyester'],
        size: 'Large',
      });

      expect(result.aspects?.['Brand']).toEqual(['TestBrand']);
      expect(result.aspects?.['Color']).toEqual(['Red']);
      expect(result.aspects?.['Material']).toEqual(['Cotton', 'Polyester']);
      expect(result.aspects?.['Size']).toEqual(['Large']);
    });

    it('should include package dimensions with correct units', () => {
      const result = formatForEbay({
        ...baseMetadata,
        packageDimensions: { length: 10, width: 5, height: 3, unit: 'in' },
        packageWeight: { value: 2, unit: 'lb' },
      });

      expect(result.packageWeightAndSize?.dimensions).toEqual({
        length: 10,
        width: 5,
        height: 3,
        unit: 'INCH',
      });
      expect(result.packageWeightAndSize?.weight).toEqual({
        value: 2,
        unit: 'POUND',
      });
    });

    it('should use itemSpecifics when provided', () => {
      const result = formatForEbay({
        ...baseMetadata,
        itemSpecifics: {
          'Model': 'ABC123',
          'Features': ['Waterproof', 'Scratch-resistant'],
        },
      });

      expect(result.aspects?.['Model']).toEqual(['ABC123']);
      expect(result.aspects?.['Features']).toEqual(['Waterproof', 'Scratch-resistant']);
    });

    it('should not overwrite itemSpecifics with default aspects', () => {
      const result = formatForEbay({
        ...baseMetadata,
        brand: 'GenericBrand',
        itemSpecifics: {
          'Brand': 'SpecificBrand',
        },
      });

      // itemSpecifics Brand should take precedence
      expect(result.aspects?.['Brand']).toEqual(['SpecificBrand']);
    });

    it('should include product identifiers for different barcode types', () => {
      const resultUPC = formatForEbay({ ...baseMetadata, barcode: '012345678901', barcodeType: 'UPC' });
      expect(resultUPC.product?.upc).toEqual(['012345678901']);

      const resultEAN = formatForEbay({ ...baseMetadata, barcode: '5901234123457', barcodeType: 'EAN' });
      expect(resultEAN.product?.ean).toEqual(['5901234123457']);

      const resultISBN = formatForEbay({ ...baseMetadata, barcode: '978-3-16-148410-0', barcodeType: 'ISBN' });
      expect(resultISBN.product?.isbn).toEqual(['978-3-16-148410-0']);
    });

    it('should handle centimeter dimensions', () => {
      const result = formatForEbay({
        ...baseMetadata,
        packageDimensions: { length: 25, width: 15, height: 10, unit: 'cm' },
      });

      expect(result.packageWeightAndSize?.dimensions?.unit).toBe('CENTIMETER');
    });

    it('should handle missing dimensions when only weight is present', () => {
      const result = formatForEbay({
        ...baseMetadata,
        packageWeight: { value: 0.5, unit: 'kg' },
      });

      expect(result.packageWeightAndSize?.dimensions).toBeUndefined();
      expect(result.packageWeightAndSize?.weight).toEqual({
        value: 0.5,
        unit: 'KILOGRAM',
      });
    });

    it('should add demographics aspects', () => {
      const result = formatForEbay({
        ...baseMetadata,
        gender: 'Men',
        style: 'athletic',
        ageGroup: 'adult',
        pattern: 'solid',
      });

      expect(result.aspects?.['Gender']).toEqual(['Men']);
      expect(result.aspects?.['Style']).toEqual(['athletic']);
      expect(result.aspects?.['Age Group']).toEqual(['adult']);
      expect(result.aspects?.['Pattern']).toEqual(['solid']);
    });

    it('should not overwrite demographics aspects from itemSpecifics', () => {
      const result = formatForEbay({
        ...baseMetadata,
        gender: 'Unisex',
        itemSpecifics: { 'Gender': 'Men' },
      });

      expect(result.aspects?.['Gender']).toEqual(['Men']);
    });

    it('should add pricingSummary when price is present', () => {
      const result = formatForEbay({
        ...baseMetadata,
        price: 39.99,
        currency: 'GBP',
      });

      expect(result.pricingSummary).toEqual({
        price: { value: '39.99', currency: 'GBP' },
      });
    });

    it('should default pricingSummary currency to USD', () => {
      const result = formatForEbay({
        ...baseMetadata,
        price: 19.99,
      });

      expect(result.pricingSummary).toEqual({
        price: { value: '19.99', currency: 'USD' },
      });
    });

    it('should not add pricingSummary when price is absent', () => {
      const result = formatForEbay(baseMetadata);

      expect(result.pricingSummary).toBeUndefined();
    });
  });

  describe('createMetadataFileOutput', () => {
    const baseMetadata: ProductMetadata = {
      title: 'Test Product',
      description: 'Test description',
      bulletPoints: ['Feature 1'],
      confidence: { overall: 85, title: 90, description: 80 },
      extractedFromAudio: true,
    };

    it('should create complete metadata file output', () => {
      const result = createMetadataFileOutput('This is the transcript', baseMetadata, 45.5);

      expect(result.transcript).toBe('This is the transcript');
      expect(result.product).toBe(baseMetadata);
      expect(result.audioDuration).toBe(45.5);
      expect(result.pipelineVersion).toBe(PIPELINE_VERSION);
      expect(result.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include all platform formats', () => {
      const result = createMetadataFileOutput('Transcript', baseMetadata);

      expect(result.platforms.shopify).toBeDefined();
      expect(result.platforms.amazon).toBeDefined();
      expect(result.platforms.ebay).toBeDefined();
    });

    it('should work without audioDuration', () => {
      const result = createMetadataFileOutput('Transcript', baseMetadata);

      expect(result.audioDuration).toBeUndefined();
    });
  });

  describe('Gemini Audio Analysis Response Validation', () => {
    const validResponse = {
      transcript: 'This is a product description.',
      language: 'en',
      audioQuality: 85,
      product: {
        title: 'Test Product',
        description: 'A great product',
        bulletPoints: ['Feature 1', 'Feature 2'],
      },
      confidence: {
        overall: 80,
        title: 85,
        description: 75,
      },
      relevantExcerpts: ['great product', 'high quality'],
    };

    describe('geminiAudioAnalysisResponseSchema', () => {
      it('should validate a correct response', () => {
        const result = geminiAudioAnalysisResponseSchema.safeParse(validResponse);
        expect(result.success).toBe(true);
      });

      it('should reject missing transcript', () => {
        const { transcript: _transcript, ...invalid } = validResponse;
        const result = geminiAudioAnalysisResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it('should reject missing product', () => {
        const { product: _product, ...invalid } = validResponse;
        const result = geminiAudioAnalysisResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it('should reject missing confidence', () => {
        const { confidence: _confidence, ...invalid } = validResponse;
        const result = geminiAudioAnalysisResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it('should accept audioQuality at boundaries', () => {
        expect(geminiAudioAnalysisResponseSchema.safeParse({ ...validResponse, audioQuality: 0 }).success).toBe(true);
        expect(geminiAudioAnalysisResponseSchema.safeParse({ ...validResponse, audioQuality: 100 }).success).toBe(true);
      });

      it('should reject audioQuality out of range', () => {
        expect(geminiAudioAnalysisResponseSchema.safeParse({ ...validResponse, audioQuality: -1 }).success).toBe(false);
        expect(geminiAudioAnalysisResponseSchema.safeParse({ ...validResponse, audioQuality: 101 }).success).toBe(false);
      });

      it('should default empty relevantExcerpts', () => {
        const { relevantExcerpts: _relevantExcerpts, ...partial } = validResponse;
        const result = geminiAudioAnalysisResponseSchema.parse(partial);
        expect(result.relevantExcerpts).toEqual([]);
      });

      it('should default language to en', () => {
        const { language: _language, ...partial } = validResponse;
        const result = geminiAudioAnalysisResponseSchema.parse(partial);
        expect(result.language).toBe('en');
      });

      it('should validate optional product fields', () => {
        const withOptionals = {
          ...validResponse,
          product: {
            ...validResponse.product,
            brand: 'TestBrand',
            category: 'Electronics',
            price: { value: 29.99, currency: 'USD' },
            condition: 'new',
            dimensions: { length: 10, width: 5, height: 3, unit: 'in' },
            weight: { value: 1.5, unit: 'lb' },
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withOptionals);
        expect(result.success).toBe(true);
      });

      it('should accept null values for optional fields (Gemini nullish handling)', () => {
        const withNulls = {
          ...validResponse,
          product: {
            ...validResponse.product,
            brand: null,
            category: null,
            color: null,
            materials: null,
            dimensions: null,
            weight: null,
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withNulls);
        expect(result.success).toBe(true);
      });

      it('should provide default unit for dimensions when not specified', () => {
        const withDimensionsNoUnit = {
          ...validResponse,
          product: {
            ...validResponse.product,
            dimensions: { length: 10, width: 5, height: 3 }, // No unit
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withDimensionsNoUnit);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.product.dimensions?.unit).toBe('in'); // Default
        }
      });

      it('should provide default unit for weight when not specified', () => {
        const withWeightNoUnit = {
          ...validResponse,
          product: {
            ...validResponse.product,
            weight: { value: 1.5 }, // No unit
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withWeightNoUnit);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.product.weight?.unit).toBe('lb'); // Default
        }
      });

      it('should handle partial dimensions with null values', () => {
        const withPartialDimensions = {
          ...validResponse,
          product: {
            ...validResponse.product,
            dimensions: { length: 10, width: null, height: null, unit: 'cm' },
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withPartialDimensions);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.product.dimensions?.length).toBe(10);
          expect(result.data.product.dimensions?.width).toBeNull();
          expect(result.data.product.dimensions?.unit).toBe('cm'); // Explicit unit preserved
        }
      });

      it('should transform null unit to default in dimensions', () => {
        const withNullUnit = {
          ...validResponse,
          product: {
            ...validResponse.product,
            dimensions: { length: null, width: null, height: null, unit: null },
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withNullUnit);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.product.dimensions?.unit).toBe('in'); // null transformed to default
        }
      });

      it('should transform null unit to default in weight', () => {
        const withNullUnit = {
          ...validResponse,
          product: {
            ...validResponse.product,
            weight: { value: null, unit: null },
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withNullUnit);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.product.weight?.unit).toBe('lb'); // null transformed to default
        }
      });

      it('should reject invalid condition', () => {
        const invalid = {
          ...validResponse,
          product: {
            ...validResponse.product,
            condition: 'broken',
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it('should accept new demographics fields', () => {
        const withDemographics = {
          ...validResponse,
          product: {
            ...validResponse.product,
            gender: 'Women',
            targetAudience: 'adults',
            ageGroup: 'adult',
            style: 'casual',
            modelNumber: 'ABC-123',
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withDemographics);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.product.gender).toBe('Women');
          expect(result.data.product.targetAudience).toBe('adults');
          expect(result.data.product.ageGroup).toBe('adult');
          expect(result.data.product.style).toBe('casual');
          expect(result.data.product.modelNumber).toBe('ABC-123');
        }
      });

      it('should accept null values for demographics fields', () => {
        const withNulls = {
          ...validResponse,
          product: {
            ...validResponse.product,
            gender: null,
            targetAudience: null,
            ageGroup: null,
            style: null,
            modelNumber: null,
          },
        };
        const result = geminiAudioAnalysisResponseSchema.safeParse(withNulls);
        expect(result.success).toBe(true);
      });
    });

    describe('parseGeminiAudioAnalysisResponse', () => {
      it('should parse valid response', () => {
        const result = parseGeminiAudioAnalysisResponse(validResponse);
        expect(result.transcript).toBe('This is a product description.');
      });

      it('should throw on invalid response', () => {
        expect(() => parseGeminiAudioAnalysisResponse({})).toThrow();
      });
    });

    describe('safeParseGeminiAudioAnalysisResponse', () => {
      it('should return success for valid response', () => {
        const result = safeParseGeminiAudioAnalysisResponse(validResponse);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.transcript).toBe('This is a product description.');
        }
      });

      it('should return error for invalid response', () => {
        const result = safeParseGeminiAudioAnalysisResponse({});
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.errors.length).toBeGreaterThan(0);
        }
      });
    });
  });
});

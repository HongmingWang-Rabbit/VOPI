# API Update: Extended Product Metadata Fields

**Date:** 2026-01-28
**Version:** 2.1.0
**Breaking Change:** No (additive changes only)

## Summary

Product metadata now includes additional fields for demographics, style, and platform-specific data. These fields improve listing quality on Amazon, eBay, and Shopify by providing gender, target audience, age group, style, and model number information. The PATCH metadata endpoint also accepts new editable fields.

---

## New Product Metadata Fields

The `product` object in metadata responses (`GET /api/v1/jobs/:id/metadata` and `GET /api/v1/jobs/:id/download-urls`) now includes:

| Field | Type | Description |
|-------|------|-------------|
| `gender` | `string?` | Gender/department (e.g., `"Men"`, `"Women"`, `"Unisex"`) |
| `targetAudience` | `string?` | Target audience (e.g., `"adults"`, `"teens"`) |
| `ageGroup` | `string?` | Age group (e.g., `"adult"`, `"child"`, `"infant"`) |
| `style` | `string?` | Product style (e.g., `"casual"`, `"formal"`, `"athletic"`) |
| `modelNumber` | `string?` | Model number (separate from MPN) |

All fields are optional and will only be present when the AI extracts them from the video audio.

### Example Response

```json
{
  "product": {
    "title": "Nike Air Max 90 Running Shoes",
    "description": "...",
    "bulletPoints": ["..."],
    "brand": "Nike",
    "gender": "Men",
    "targetAudience": "adults",
    "ageGroup": "adult",
    "style": "athletic",
    "modelNumber": "CW7483-100",
    "..."
  }
}
```

---

## Updated PATCH Endpoint

### PATCH /api/v1/jobs/:id/metadata

The following fields are now editable via the PATCH endpoint:

| Field | Type | Validation |
|-------|------|------------|
| `gender` | `string` | max 50 chars |
| `targetAudience` | `string` | max 100 chars |
| `ageGroup` | `string` | max 50 chars |
| `style` | `string` | max 100 chars |
| `modelNumber` | `string` | max 100 chars |
| `compareAtPrice` | `number` | >= 0 |
| `costPerItem` | `number` | >= 0 |
| `countryOfOrigin` | `string` | max 100 chars |
| `manufacturer` | `string` | max 200 chars |
| `pattern` | `string` | max 100 chars |
| `productType` | `string` | max 100 chars |

These are in addition to all previously supported PATCH fields.

**Request Example:**
```json
PATCH /api/v1/jobs/:id/metadata

{
  "gender": "Women",
  "style": "casual",
  "targetAudience": "adults",
  "compareAtPrice": 79.99,
  "manufacturer": "Acme Corp"
}
```

---

## Platform Output Changes

Updating these fields (via AI extraction or PATCH) affects the platform-formatted outputs in `platforms.shopify`, `platforms.amazon`, and `platforms.ebay`.

### Shopify

New `metafields` array added to the Shopify output:

```json
{
  "metafields": [
    { "namespace": "custom", "key": "materials", "value": "[\"cotton\",\"polyester\"]", "type": "list.single_line_text_field" },
    { "namespace": "custom", "key": "care_instructions", "value": "[\"Machine wash cold\"]", "type": "list.single_line_text_field" },
    { "namespace": "custom", "key": "gender", "value": "Women", "type": "single_line_text_field" }
  ]
}
```

Metafields are only included when the source data is present.

### Amazon

New fields mapped to Amazon SP-API format:

| Product Field | Amazon Field | Notes |
|---------------|-------------|-------|
| `price` + `currency` | `standard_price` | `{ value, currency }` |
| `gender` | `department` | Direct mapping |
| `targetAudience` | `target_audience_keyword` | Wrapped in array |
| `ageGroup` | `age_range_description` | Direct mapping |
| `modelNumber` | `model_number` | Direct mapping |
| `style` | `style` | Direct mapping |
| `size` | `size` | Direct mapping |
| `pattern` | `pattern` | Direct mapping |

### eBay

New fields added:

- **Pricing**: `pricingSummary.price` object with `{ value, currency }` when price is available
- **Aspects**: `Gender`, `Style`, `Age Group`, `Pattern` added to `aspects` map when present

---

## Migration Guide

### No action required

All new fields are optional and additive. Existing clients will continue to work without changes.

### Recommended updates

1. **Metadata edit form** - Add input fields for `gender`, `targetAudience`, `ageGroup`, `style`, `modelNumber`, `compareAtPrice`, `costPerItem`, `countryOfOrigin`, `manufacturer`, `pattern`, and `productType` in your metadata editing UI.

2. **Product display** - Show `gender`, `style`, and `ageGroup` as badges or tags if present.

3. **Platform preview** - If you render platform-specific previews, update them to show:
   - Shopify: metafields section
   - Amazon: new fields (`department`, `standard_price`, etc.)
   - eBay: pricing summary and new aspects

### TypeScript types

```typescript
interface ProductMetadata {
  // ... existing fields ...

  // New fields
  gender?: string;
  targetAudience?: string;
  ageGroup?: string;
  style?: string;
  modelNumber?: string;
}

// New PATCH fields (all optional)
interface MetadataPatchBody {
  // ... existing fields ...

  // New editable fields
  gender?: string;
  targetAudience?: string;
  ageGroup?: string;
  style?: string;
  modelNumber?: string;
  compareAtPrice?: number;
  costPerItem?: number;
  countryOfOrigin?: string;
  manufacturer?: string;
  pattern?: string;
  productType?: string;
}
```

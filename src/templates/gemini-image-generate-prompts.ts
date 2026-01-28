/**
 * Gemini Image Generation Prompts
 *
 * Prompt templates for generating commercial product images using Gemini's
 * image generation capabilities. These prompts guide the model to either:
 * - Extract products and place on white backgrounds (white-studio)
 * - Create contextual lifestyle scenes (lifestyle)
 *
 * CRITICAL: These prompts strongly emphasize preserving the EXACT product
 * appearance. Image generation models tend to "enhance" or modify subjects.
 */

import type { GeminiImageVariant } from '../providers/interfaces/gemini-image-generate.provider.js';

/**
 * White studio prompt - frames as background REMOVAL, not generation
 *
 * This prompt is intentionally framed as an extraction/replacement task
 * to minimize the model's tendency to "improve" or modify the product.
 */
export const WHITE_STUDIO_PROMPT = `
## TASK: BACKGROUND REMOVAL AND REPLACEMENT

You are performing a simple background replacement task. Extract the product from the image and place it on a pure white background.

## CRITICAL - THIS IS NOT A GENERATION TASK:
- DO NOT generate or create a new product
- DO NOT modify, enhance, or redesign the product
- DO NOT add any creative elements
- Simply EXTRACT the existing product and place it on white

## WHAT TO DO:
1. Look at the TARGET IMAGE below
2. Extract/cut out the product EXACTLY as it appears
3. Place it on a pure white background (#FFFFFF)
4. Add a subtle soft shadow underneath
5. Center the product in frame

## WHAT NOT TO DO:
- DO NOT change ANY text on the product
- DO NOT change ANY patterns or decorations on the product
- DO NOT change ANY colors
- DO NOT add ANYTHING to the background (no floating elements)
- DO NOT redesign or "improve" the product
- DO NOT add decorative elements beside or around the product

## ALLOWED ADJUSTMENTS ONLY:
- Straighten if tilted (make upright)
- Smooth minor wrinkles in packaging
- Clean professional lighting

## OUTPUT:
The EXACT same product from the input image, extracted and placed on pure white background. Product must be IDENTICAL to input - same text, same patterns, same colors, same design.
`;

/**
 * Lifestyle prompt base — everything before the BACKGROUND section
 */
const LIFESTYLE_PROMPT_BASE = `
You are creating a lifestyle product photo in a natural setting.

## STEP 1 - STUDY THE REFERENCE IMAGES:
Look at ALL reference images and memorize:
- The EXACT text/brand name (copy character by character, including any non-English text)
- The EXACT position of decorative patterns ON the product
- The EXACT colors
- The EXACT shape and proportions

## STEP 2 - PRODUCT RULES:
Reproduce the EXACT same product:
- All patterns and decorations must stay ON THE PRODUCT in their original positions
- Do NOT move or change pattern positions
- Do NOT add patterns that weren't on the original
- Keep all text exactly as shown (preserve the original language)
- The product must look IDENTICAL to the references

## WHAT YOU MUST NOT DO:
- DO NOT generate a different product
- DO NOT change the pattern layout on the product
- DO NOT add human hands or body parts
- DO NOT simplify the product design
- DO NOT change colors or text
- DO NOT translate text to a different language

## ALLOWED IMPROVEMENTS:
- Straighten the product (upright, not tilted)
- Smooth packaging wrinkles
- Natural, soft lighting`;

/**
 * Generic background section (no product context available)
 */
const LIFESTYLE_BACKGROUND_GENERIC = `
## BACKGROUND:
- Appropriate lifestyle setting for the product type
- Natural contextual scene
- Props should complement but not distract`;

/**
 * Lifestyle prompt footer
 */
const LIFESTYLE_PROMPT_FOOTER = `
## OUTPUT:
The EXACT product from references in a lifestyle setting. Product design must match references exactly.
`;

/**
 * Pre-composed lifestyle prompt for the no-context fallback path.
 * Exported for backward compatibility with any code referencing it.
 */
export const LIFESTYLE_PROMPT = LIFESTYLE_PROMPT_BASE + LIFESTYLE_BACKGROUND_GENERIC + LIFESTYLE_PROMPT_FOOTER;

/**
 * Reference frame introduction text for white-studio variant
 */
export const WHITE_STUDIO_REFERENCE_INTRO = `## REFERENCE - THIS IS THE PRODUCT (DO NOT MODIFY IT):
The following images show the product. Your task is to EXTRACT this product and place it on white.
DO NOT redesign, regenerate, or modify the product in any way.

`;

/**
 * Reference frame introduction text for lifestyle variant
 */
export const LIFESTYLE_REFERENCE_INTRO = `## REFERENCE IMAGES - STUDY THE PRODUCT:
The following images show the ACTUAL product from different angles.
Study these to understand what the product looks like. Your output must show THIS EXACT product.

`;

/**
 * Target image introduction for white-studio variant
 */
export const WHITE_STUDIO_TARGET_INTRO = `
---
## TARGET IMAGE - EXTRACT THIS AND PLACE ON WHITE:
Below is the image to process. Remove the background and place the product on pure white.
DO NOT modify the product. Keep it EXACTLY as shown.

`;

/**
 * Target image introduction for lifestyle variant
 */
export const LIFESTYLE_TARGET_INTRO = `
---
## TARGET IMAGE - CREATE LIFESTYLE SCENE:
Below is the product image. Create a lifestyle scene with this EXACT product.
The product must look identical to the references.

`;

/**
 * Get the appropriate prompt for a variant
 *
 * @param variant - The image variant type
 * @returns The prompt template
 */
export function getImageGeneratePrompt(
  variant: GeminiImageVariant,
  productContext?: { title?: string; description?: string; category?: string },
): string {
  switch (variant) {
    case 'white-studio':
      return WHITE_STUDIO_PROMPT;
    case 'lifestyle':
      return buildLifestylePrompt(productContext);
    default:
      return WHITE_STUDIO_PROMPT;
  }
}

/**
 * Build lifestyle prompt with optional product context injected.
 * Uses structural composition (base + background + footer) rather than
 * string replacement to avoid silent failures if prompt text changes.
 */
function buildLifestylePrompt(
  productContext?: { title?: string; description?: string; category?: string },
): string {
  const hasContext = productContext &&
    (productContext.title || productContext.description || productContext.category);

  if (!hasContext) {
    return LIFESTYLE_PROMPT;
  }

  // Build product context section
  const contextLines: string[] = ['## PRODUCT CONTEXT:'];
  if (productContext.title) {
    contextLines.push(`- Product: ${productContext.title}`);
  }
  if (productContext.category) {
    contextLines.push(`- Category: ${productContext.category}`);
  }
  if (productContext.description) {
    // Truncate description to ~200 chars to avoid bloating the prompt
    const desc = productContext.description.length > 200
      ? productContext.description.slice(0, 200) + '…'
      : productContext.description;
    contextLines.push(`- Description: ${desc}`);
  }

  const contextAwareBackground = `
${contextLines.join('\n')}

## BACKGROUND:
- Create a lifestyle setting that is NATURAL and APPROPRIATE for this specific product
- The scene should match where this product would actually be used or displayed
- Props should complement the product's category and purpose
- Do NOT use generic settings — choose a scene that makes sense for this exact product`;

  return LIFESTYLE_PROMPT_BASE + contextAwareBackground + LIFESTYLE_PROMPT_FOOTER;
}

/**
 * Get reference frame introduction text for a variant
 *
 * @param variant - The image variant type
 * @param frameCount - Number of reference frames
 * @returns The introduction text
 */
export function getReferenceIntro(variant: GeminiImageVariant, frameCount: number): string {
  if (variant === 'white-studio') {
    return WHITE_STUDIO_REFERENCE_INTRO;
  }
  return `## REFERENCE IMAGES - STUDY THE PRODUCT:
The following ${frameCount} images show the ACTUAL product from different angles.
Study these to understand what the product looks like. Your output must show THIS EXACT product.

`;
}

/**
 * Get target image introduction text for a variant
 *
 * @param variant - The image variant type
 * @returns The introduction text
 */
export function getTargetIntro(variant: GeminiImageVariant): string {
  switch (variant) {
    case 'white-studio':
      return WHITE_STUDIO_TARGET_INTRO;
    case 'lifestyle':
      return LIFESTYLE_TARGET_INTRO;
    default:
      return WHITE_STUDIO_TARGET_INTRO;
  }
}

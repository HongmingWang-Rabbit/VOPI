/**
 * Gemini Quality Filter Prompts
 *
 * Prompt templates for evaluating commercial image quality using Gemini's
 * vision capabilities. These prompts guide the model to:
 * - Detect unwanted elements (hands, body parts)
 * - Identify product mismatches against references
 * - Catch background artifacts in white-studio images
 * - Evaluate overall quality
 */

/**
 * Prompt for evaluating a batch of commercial images WITH reference comparison
 */
export const BATCH_EVALUATION_PROMPT_WITH_REFS = `You are an expert e-commerce image quality analyst. You will first see REFERENCE IMAGES showing the ACTUAL product, then GENERATED IMAGES to evaluate.

## YOUR TASK:
Compare each GENERATED image against the REFERENCE images and decide which to KEEP and which to FILTER OUT.

## CRITICAL - MUST REJECT IMMEDIATELY:

### 1. HANDS OR BODY PARTS (human_hand, human_body)
- ANY visible human hand, finger, arm, or body part = REJECT
- Even partial hand visibility = REJECT
- This is the #1 priority - be very strict

### 2. WRONG PRODUCT (product_modified)
- Compare to REFERENCE images - it should be the SAME TYPE of product
- If it's a COMPLETELY DIFFERENT product category = REJECT
- If the product shape is fundamentally different = REJECT
- ACCEPT: minor color variations, lighting differences, artistic styling
- ACCEPT: different angle or perspective of the same product
- Only reject if the product is clearly NOT the same item

### 3. BACKGROUND CONTAMINATION (background_artifacts)
For WHITE-STUDIO images (white background):
- If there are PROMINENT distracting elements that compete with the product = REJECT
- If decorative elements are larger than the product = REJECT
- ACCEPT: subtle shadows, gradients, or soft lighting effects
- ACCEPT: small decorative elements that complement but don't overwhelm
- The focus should be on the product - minor background styling is OK

### 4. QUALITY ISSUES
- **blurry**: Not sharp or in focus = REJECT
- **cropped_product**: Product cut off = REJECT
- **awkward_angle**: Unprofessional angle = REJECT

## DEDUPLICATION:
- Keep only the BEST image per angle
- Max one white-studio AND one lifestyle per angle

## Output Format

Return a JSON object:
\`\`\`json
{
  "evaluations": [
    {
      "imageId": "frame_00001_lifestyle",
      "qualityScore": 85,
      "keep": true,
      "reason": "Product matches reference, professional quality, no hands",
      "issues": [],
      "category": "front-lifestyle",
      "angleType": "front",
      "backgroundType": "lifestyle"
    },
    {
      "imageId": "frame_00003_white-studio",
      "qualityScore": 0,
      "keep": false,
      "reason": "Decorative elements floating in white background",
      "issues": [{"type": "background_artifacts", "severity": "high", "description": "Cherry blossoms and fans floating beside product on white background"}],
      "category": "rejected",
      "angleType": "front",
      "backgroundType": "white-studio"
    }
  ],
  "summary": {
    "totalKept": 3,
    "totalFiltered": 5,
    "keptImages": ["frame_00001_lifestyle", ...],
    "filterReasons": {"human_hand": 2, "product_modified": 2, "background_artifacts": 1}
  }
}
\`\`\`

## STRICTNESS CRITERIA:
- If ANY human hand or finger is clearly visible: REJECT immediately
- If the product is a COMPLETELY DIFFERENT item (wrong category): REJECT
- If white-studio has PROMINENT decorative elements competing with product: REJECT
- Quality score below minimum threshold: REJECT

## LENIENCY FOR AI-GENERATED IMAGES:
- ACCEPT minor color/lighting variations - these are expected
- ACCEPT subtle background gradients or soft shadows - these enhance the image
- ACCEPT small artistic additions that don't distract from the product
- When the product is clearly the same item with minor styling differences: KEEP IT
- Err on the side of KEEPING images unless there are MAJOR issues`;

/**
 * Prompt for evaluating WITHOUT reference images (fallback)
 */
export const BATCH_EVALUATION_PROMPT_NO_REFS = `You are an expert e-commerce image quality analyst. Evaluate these commercial product images.

## CRITICAL - MUST REJECT IMMEDIATELY:

### 1. HANDS OR BODY PARTS (human_hand, human_body)
- ANY visible human hand, finger, arm, or body part = REJECT
- Even partial hand visibility = REJECT

### 2. QUALITY ISSUES
- **blurry**: Not sharp = REJECT
- **cropped_product**: Product cut off = REJECT
- **awkward_angle**: Unprofessional = REJECT

## DEDUPLICATION:
- Keep only the BEST image per angle
- Max one white-studio AND one lifestyle per angle

## Output Format
Return JSON with evaluations array and summary.

## STRICTNESS CRITERIA:
- If ANY human hand or finger is clearly visible: REJECT immediately
- If image appears blurry or out of focus: REJECT
- If product is significantly cut off: REJECT
- Quality score below minimum threshold: REJECT

## LENIENCY FOR AI-GENERATED IMAGES:
- ACCEPT minor styling variations and artistic elements
- ACCEPT subtle background enhancements
- Err on the side of KEEPING images unless there are MAJOR issues`;

/**
 * Reference images introduction for quality filter
 */
export const REFERENCE_IMAGES_INTRO = `## REFERENCE IMAGES - THIS IS THE ACTUAL PRODUCT:
The following images show what the REAL product looks like.
Use these to compare against the generated images below.
REJECT any generated image where the product looks significantly different.

`;

/**
 * Generated images introduction for quality filter
 */
export const GENERATED_IMAGES_INTRO = `
---
## GENERATED IMAGES TO EVALUATE:
Now evaluate each of the following generated images. Compare them against the REFERENCE images above.

`;

/**
 * Build evaluation rules text based on options
 *
 * @param minQualityScore - Minimum score to keep
 * @param allowHands - Whether to allow hands
 * @param hasReferences - Whether reference images are provided
 * @param imageCount - Number of images to evaluate
 * @returns The evaluation rules text
 */
export function buildEvaluationRules(
  minQualityScore: number,
  allowHands: boolean,
  hasReferences: boolean,
  imageCount: number
): string {
  return `
## Evaluation Rules:
- Minimum quality score to keep: ${minQualityScore}
- Allow images with hands: ${allowHands}
${hasReferences ? '- REJECT any image where the product looks different from the REFERENCE images\n- REJECT white-studio images with ANY decorative elements in the background' : ''}

Keep ALL images that meet quality standards. Do NOT artificially limit the count.
Now evaluate all ${imageCount} generated images and return the JSON response.`;
}

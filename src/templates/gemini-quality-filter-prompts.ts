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
- Compare to REFERENCE images - the product design MUST match
- If text/logos are different = REJECT
- If patterns/decorations are in DIFFERENT positions = REJECT
- If patterns are MISSING from the product = REJECT
- If colors are significantly different = REJECT
- If the product shape is different = REJECT
- If it looks like a DIFFERENT product entirely = REJECT

### 3. BACKGROUND CONTAMINATION (background_artifacts)
For WHITE-STUDIO images (white background):
- If there are ANY decorative elements in the background = REJECT
- Floating flowers, branches, fans, or patterns beside the product = REJECT
- The background must be PURE WHITE with only a shadow = KEEP
- Props or accessories around the product = REJECT

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
- If ANY human body part is visible (even partially): REJECT immediately
- If the product looks >10% different from references: REJECT
- If white-studio has ANY elements besides product and shadow: REJECT
- Quality score below minimum threshold: REJECT
- When uncertain about product match: REJECT (false negatives are safer than false positives)`;

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
- If ANY human body part is visible (even partially): REJECT immediately
- If image appears blurry or out of focus: REJECT
- If product is partially cut off: REJECT
- Quality score below minimum threshold: REJECT
- When uncertain: REJECT (false negatives are safer than false positives)`;

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

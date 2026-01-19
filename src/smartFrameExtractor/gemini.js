/**
 * gemini.js - Gemini API wrapper for frame classification
 *
 * WHY this module exists:
 * - Encapsulates all Gemini-specific logic
 * - Handles image encoding and prompt construction
 * - Enforces strict JSON output schema
 * - Provides retry logic for API reliability
 *
 * Key insight: We send ONLY pre-selected candidate frames to Gemini,
 * not the full video. This saves tokens and improves accuracy.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile } from 'fs/promises';
import path from 'path';

/**
 * Angle estimates for metadata (not used for selection, just for reference)
 * These are suggestions for what angle a variant might represent
 */
const ANGLE_ESTIMATES = [
  'front',        // Direct front view
  'back',         // Back view
  'left_side',    // Left side profile
  'right_side',   // Right side profile
  'top',          // Top-down view
  'bottom',       // Bottom view
  '3/4_front',    // 3/4 angle from front
  '3/4_back',     // 3/4 angle from back
  'detail',       // Close-up of features
  'open',         // Product opened/unfolded
  'closed',       // Product closed/folded
  'in_use',       // Being used/worn
  'with_contents',// Showing what's inside
  'other'         // Other unique angle
];

/**
 * Output schema that Gemini must follow
 * MULTI-PRODUCT AWARE: Groups shots by product
 */
const OUTPUT_SCHEMA = `{
  "video": {
    "filename": "string",
    "duration_sec": "number"
  },
  "products_detected": [
    {
      "product_id": "string - e.g., product_1, product_2",
      "description": "string - brief description of the product",
      "product_category": "string - e.g., wallet, bag, electronics, clothing, jewelry, etc."
    }
  ],
  "frame_evaluation": [
    {
      "frame_id": "string - e.g., frame_00012",
      "timestamp_sec": "number",
      "product_id": "string - which product this frame shows",
      "variant_id": "string - e.g., variant_1, variant_2 (group similar views together)",
      "angle_estimate": "string - estimated angle: front|back|left_side|right_side|top|bottom|3/4_front|3/4_back|detail|open|closed|in_use|other",
      "quality_score_0_100": "number",
      "similarity_note": "string - why this frame belongs to this variant group",
      "obstructions": {
        "has_obstruction": "boolean",
        "obstruction_types": ["array: hand|finger|arm|cord|tag|reflection|shadow|other_object"],
        "obstruction_description": "string or null",
        "removable_by_ai": "boolean"
      }
    }
  ],
  "variants_discovered": [
    {
      "product_id": "string",
      "variant_id": "string - e.g., variant_1",
      "angle_estimate": "string - best estimate of what angle this variant represents",
      "description": "string - what makes this variant unique (e.g., 'front view showing logo')",
      "best_frame_id": "string - the best frame for this variant",
      "best_frame_score": "number",
      "all_frame_ids": ["array of all frame_ids that belong to this variant"],
      "obstructions": {
        "has_obstruction": "boolean",
        "obstruction_types": ["array"],
        "obstruction_description": "string or null",
        "removable_by_ai": "boolean"
      },
      "background_recommendations": {
        "solid_color": "string - hex color code (e.g., #FFFFFF, #F5F5DC) that complements the product",
        "solid_color_name": "string - human readable name (e.g., 'white', 'beige', 'soft gray')",
        "real_life_setting": "string - description of a realistic setting (e.g., 'on a white marble table', 'on a wooden desk with soft lighting')",
        "creative_shot": "string - artistic/creative concept (e.g., 'floating with soft shadows on gradient background', 'dramatic lighting with reflective surface')"
      }
    }
  ]
}`;

/**
 * System prompt for Gemini
 * VARIANT-BASED: Discovers unique views dynamically instead of fixed angles
 */
const SYSTEM_PROMPT = `You are extracting REFERENCE frames for AI image generation from a product video.

## YOUR MISSION: DISCOVER ALL UNIQUE VIEWS (VARIANTS) OF EACH PRODUCT

### STEP 1: DETECT ALL PRODUCTS
Identify every distinct product in the video:
- Different items = different products (product_1, product_2, etc.)
- Same item at different times = same product

### STEP 2: DISCOVER VARIANTS (UNIQUE VIEWS)

**Instead of fixed angles, discover VARIANTS dynamically:**

Go through each frame and ask: "Is this a NEW unique view, or SIMILAR to one I've seen?"

**CREATE A NEW VARIANT when you see:**
- A distinctly different angle/perspective of the product
- The product in a different state (open vs closed, folded vs unfolded)
- A close-up showing different details
- A significantly different composition

**GROUP INTO SAME VARIANT when:**
- The angle/perspective is essentially the same
- Only minor differences (slightly rotated, different moment of same view)
- Would be redundant to keep both

**EXAMPLE for a wallet:**
- variant_1: Front view showing exterior
- variant_2: Back view showing back pocket
- variant_3: Open view showing card slots
- variant_4: Side view showing thickness
- variant_5: Detail shot of logo/stitching

**NAMING:**
- Use variant_1, variant_2, etc. (sequential numbers)
- Also provide angle_estimate for metadata (front, back, 3/4_front, detail, open, etc.)

### QUALITY SCORING

**Base score starts at 50, then adjust:**

Visibility:
- Product fully visible with gap from edges: +20
- Product touching edge slightly: +10
- Minor cut-off (<10%): -10
- Significant cut-off (>10%): -30

Sharpness/Focus:
- Sharp and clear: +15
- Slightly soft: +5
- Noticeably blurry: -15

Obstructions:
- No obstructions: +10
- Removable obstructions (hands, etc.): -10
- Blocking key features: -30

### OBSTRUCTION DETECTION

**Report obstructions for each frame:**
- "hand" - human hand holding/gripping product
- "finger" - fingers touching product
- "arm" - arm visible in frame
- "cord" - power cords, cables, straps
- "tag" - price tags, labels not part of product
- "reflection" - unwanted reflections
- "shadow" - harsh shadows
- "other_object" - any other covering object

**For each frame's obstructions field:**
- has_obstruction: true/false
- obstruction_types: array (e.g., ["hand", "finger"])
- obstruction_description: brief text
- removable_by_ai: true if AI can likely remove it cleanly

### OUTPUT REQUIREMENTS

**For frame_evaluation:**
- Evaluate EVERY frame provided
- Assign each frame to a variant_id (variant_1, variant_2, etc.)
- Similar views = same variant_id
- Different views = different variant_id
- Include angle_estimate as metadata

**For variants_discovered:**
- List ALL unique variants found
- For each variant, identify the BEST frame (highest quality_score)
- Include all frame_ids that belong to each variant
- A good video might have 3-8 variants; some might have more or fewer

**IMPORTANT:**
- Don't limit yourself to predefined angles
- Discover as many unique views as actually exist in the video
- If the video only shows 2 different angles, only create 2 variants
- If the video shows 10 different angles, create 10 variants
- The same frame should only belong to ONE variant

### BACKGROUND RECOMMENDATIONS

**For each variant, suggest backgrounds for commercial use:**

1. **solid_color**: A hex color that complements the product
   - Consider the product's colors and choose a contrasting or complementary background
   - White (#FFFFFF) or light gray (#F5F5F5) for most products
   - Beige (#F5F5DC) for warm-toned products
   - Black (#000000) for luxury/premium items
   - Soft pastels for lifestyle products

2. **real_life_setting**: A realistic setting appropriate for the product
   - Wallets/bags: "on a clean white marble surface", "on a wooden desk"
   - Electronics: "on a sleek dark desk with soft ambient lighting"
   - Jewelry: "on a velvet display surface", "on a reflective white surface"
   - Clothing: "laid flat on a neutral fabric background"
   - Be specific but not overly complex

3. **creative_shot**: An abstract/artistic concept for marketing (NOT real-world settings)
   - Use abstract elements: bubbles, waves, geometric shapes, particles, light streaks
   - Examples:
     - "floating among translucent soap bubbles with rainbow reflections"
     - "surrounded by flowing silk waves in complementary colors"
     - "geometric low-poly shapes floating around the product"
     - "glowing particle effects and light trails on dark background"
     - "abstract color gradient with bokeh light orbs"
     - "water splash effect frozen in time around the product"
     - "neon light tubes and glowing lines on dark surface"
   - Keep it abstract and eye-catching, avoid real-world settings

IMPORTANT: Return ONLY valid JSON. No markdown, no explanation.`;

/**
 * Initialize Gemini client
 *
 * @param {string} apiKey - Google AI API key
 * @returns {Object} Gemini client instance
 */
export function initGemini(apiKey) {
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY environment variable not set');
  }
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Encode image as base64 for Gemini
 *
 * WHY base64:
 * - Gemini's JS SDK expects inline base64 data
 * - PNG format preserves quality for analysis
 *
 * @param {string} imagePath - Path to image file
 * @returns {Promise<Object>} Image part for Gemini
 */
async function encodeImageForGemini(imagePath) {
  const imageData = await readFile(imagePath);
  const base64 = imageData.toString('base64');

  return {
    inlineData: {
      data: base64,
      mimeType: 'image/png'
    }
  };
}

/**
 * Build the prompt with frame metadata
 *
 * WHY include metadata:
 * - Gemini needs to reference frames by ID
 * - Timestamps help with temporal reasoning
 * - Sequence position helps identify coverage
 *
 * @param {Array} candidateMetadata - Frame metadata array
 * @param {Object} videoMetadata - Video metadata
 * @returns {string} Constructed prompt
 */
function buildPrompt(candidateMetadata, videoMetadata) {
  const metadataStr = JSON.stringify(candidateMetadata, null, 2);

  return `## Video Information
Filename: ${videoMetadata.filename}
Duration: ${videoMetadata.duration.toFixed(2)} seconds
Resolution: ${videoMetadata.width}x${videoMetadata.height}

## Candidate Frames
The following ${candidateMetadata.length} frames have been pre-selected as the sharpest, most stable moments in the video.

Frame metadata:
${metadataStr}

## Your Task
1. Analyze each frame image provided
2. For each frame, determine its quality and suitable labels
3. Recommend the best frame for each shot type (hero, side, detail, context)
4. Assess overall video quality

## Required Output Schema
${OUTPUT_SCHEMA}

Return ONLY the JSON object. No additional text.`;
}

/**
 * Call Gemini with candidate frames
 *
 * WHY multimodal call:
 * - We send actual images, not descriptions
 * - Gemini can assess visual quality directly
 * - More accurate than text-based scoring
 *
 * @param {Object} genAI - Gemini client
 * @param {Array} candidates - Selected candidate frames
 * @param {Array} candidateMetadata - Frame metadata
 * @param {Object} videoMetadata - Video metadata
 * @returns {Promise<Object>} Parsed Gemini response
 */
export async function classifyFramesWithGemini(
  genAI,
  candidates,
  candidateMetadata,
  videoMetadata,
  options = {}
) {
  const {
    model = 'gemini-2.0-flash',  // Fast and capable for this task
    maxRetries = 3,
    retryDelay = 2000
  } = options;

  console.log(`[gemini] Sending ${candidates.length} frames for classification...`);

  // Get the model
  const geminiModel = genAI.getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0.2,      // Low temperature for consistent output
      topP: 0.8,
      maxOutputTokens: 16384  // Increased for multi-product output
    }
  });

  // Build content parts: images + prompt
  const imageParts = await Promise.all(
    candidates.map(c => encodeImageForGemini(c.path))
  );

  // Add frame labels to images
  // WHY: Helps Gemini map images to metadata
  const labeledImages = imageParts.map((img, idx) => ({
    ...img,
    // Note: We'll reference by position in prompt
  }));

  const prompt = buildPrompt(candidateMetadata, videoMetadata);

  // Build the full content
  const content = [
    { text: SYSTEM_PROMPT },
    { text: '\n\n## Candidate Frame Images\n\nImages are provided in order (frame 1, frame 2, etc.):\n\n' },
    ...labeledImages.map((img, idx) => [
      { text: `\n--- Frame ${idx + 1} (${candidateMetadata[idx].frame_id}) ---\n` },
      img
    ]).flat(),
    { text: '\n\n' + prompt }
  ];

  // Retry logic
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[gemini] Attempt ${attempt}/${maxRetries}...`);

      const result = await geminiModel.generateContent(content);
      const response = await result.response;
      const text = response.text();

      // Parse JSON from response
      const parsed = parseGeminiResponse(text);

      console.log('[gemini] Classification complete');
      return parsed;
    } catch (e) {
      lastError = e;
      console.error(`[gemini] Attempt ${attempt} failed: ${e.message}`);

      if (attempt < maxRetries) {
        console.log(`[gemini] Retrying in ${retryDelay}ms...`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }

  throw new Error(`Gemini classification failed after ${maxRetries} attempts: ${lastError.message}`);
}

/**
 * Parse Gemini response and validate schema
 * Updated for variant-based schema
 */
function parseGeminiResponse(text) {
  // Clean up common issues
  let cleaned = text.trim();

  // Remove markdown code blocks if present
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  // Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse Gemini response as JSON: ${e.message}\nResponse: ${text.slice(0, 500)}`);
  }

  // Validate required fields
  const requiredFields = ['frame_evaluation'];
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Gemini response missing required field: ${field}`);
    }
  }

  // Validate frame_evaluation structure
  if (!Array.isArray(parsed.frame_evaluation)) {
    throw new Error('frame_evaluation must be an array');
  }

  // Validate variants_discovered if present
  if (parsed.variants_discovered && !Array.isArray(parsed.variants_discovered)) {
    throw new Error('variants_discovered must be an array');
  }

  // Log what was found
  const variantCount = parsed.variants_discovered?.length || 0;
  const frameCount = parsed.frame_evaluation?.length || 0;
  console.log(`[gemini] Parsed response: ${frameCount} frames evaluated, ${variantCount} variants discovered`);

  return parsed;
}

/**
 * Extract recommended frames from variant-based Gemini response
 *
 * @param {Object} geminiResult - Parsed Gemini response with variants_discovered
 * @param {Array} candidates - Original candidate frames
 * @returns {Array} Best frame for each variant with metadata
 */
export function getRecommendedFrames(geminiResult, candidates) {
  const recommended = [];
  const candidateMap = new Map(candidates.map(c => [c.frameId, c]));

  // Build maps from frame_evaluation
  const frameData = new Map();
  if (geminiResult.frame_evaluation) {
    for (const evalItem of geminiResult.frame_evaluation) {
      frameData.set(evalItem.frame_id, {
        score: evalItem.quality_score_0_100 || 50,
        variantId: evalItem.variant_id,
        angleEstimate: evalItem.angle_estimate,
        obstructions: evalItem.obstructions || {
          has_obstruction: false,
          obstruction_types: [],
          obstruction_description: null,
          removable_by_ai: true
        },
        similarityNote: evalItem.similarity_note
      });
    }
  }

  // Use variants_discovered if available, otherwise fall back to frame_evaluation
  const variants = geminiResult.variants_discovered || [];

  if (variants.length > 0) {
    // New variant-based approach
    for (const variant of variants) {
      const productId = variant.product_id || 'product_1';
      const variantId = variant.variant_id;
      const frameId = variant.best_frame_id;

      if (!frameId) {
        console.log(`[gemini] ${productId}/${variantId}: No frame selected`);
        continue;
      }

      const candidate = candidateMap.get(frameId);
      if (candidate) {
        const evalData = frameData.get(frameId) || {};

        recommended.push({
          ...candidate,
          productId,
          variantId,
          angleEstimate: variant.angle_estimate || evalData.angleEstimate || 'unknown',
          recommendedType: `${productId}_${variantId}`, // e.g., "product_1_variant_1"
          variantDescription: variant.description,
          geminiScore: variant.best_frame_score || evalData.score || 50,
          allFrameIds: variant.all_frame_ids || [frameId],
          obstructions: variant.obstructions || evalData.obstructions || {
            has_obstruction: false,
            obstruction_types: [],
            obstruction_description: null,
            removable_by_ai: true
          },
          backgroundRecommendations: variant.background_recommendations || {
            solid_color: '#FFFFFF',
            solid_color_name: 'white',
            real_life_setting: 'on a clean white surface with soft lighting',
            creative_shot: 'floating with soft shadow on gradient background'
          }
        });

        const obs = recommended[recommended.length - 1].obstructions;
        if (obs.has_obstruction) {
          console.log(`[gemini] ${productId}/${variantId} (${variant.angle_estimate}): obstructions [${obs.obstruction_types.join(', ')}]`);
        } else {
          console.log(`[gemini] ${productId}/${variantId} (${variant.angle_estimate}): ${variant.description}`);
        }
      } else {
        console.warn(`[gemini] Frame ${frameId} not found in candidates`);
      }
    }
  } else {
    // Fallback: group by variant_id from frame_evaluation
    const variantBest = new Map(); // variantId -> best frame

    for (const [frameId, data] of frameData) {
      const key = `${data.variantId}`;
      const existing = variantBest.get(key);

      if (!existing || data.score > existing.score) {
        variantBest.set(key, { frameId, ...data });
      }
    }

    for (const [variantId, data] of variantBest) {
      const candidate = candidateMap.get(data.frameId);
      if (candidate) {
        recommended.push({
          ...candidate,
          productId: 'product_1',
          variantId,
          angleEstimate: data.angleEstimate || 'unknown',
          recommendedType: `product_1_${variantId}`,
          geminiScore: data.score,
          obstructions: data.obstructions,
          backgroundRecommendations: {
            solid_color: '#FFFFFF',
            solid_color_name: 'white',
            real_life_setting: 'on a clean white surface with soft lighting',
            creative_shot: 'floating with soft shadow on gradient background'
          }
        });
      }
    }
  }

  // Log summary
  const products = [...new Set(recommended.map(r => r.productId))];
  const withObstructions = recommended.filter(r => r.obstructions?.has_obstruction).length;
  console.log(`[gemini] Discovered ${recommended.length} variants for ${products.length} product(s), ${withObstructions} have obstructions`);

  return recommended;
}

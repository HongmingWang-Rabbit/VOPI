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
 * Valid shot types for product photography
 * Covers all standard e-commerce angles
 */
const SHOT_TYPES = [
  'hero',    // Main product image (front/3-4 view)
  'front',   // Direct front view
  'back',    // Back view
  'left',    // Left side view
  'right',   // Right side view
  'top',     // Top-down view
  'bottom',  // Bottom view (if relevant)
  'detail',  // Close-up of features/texture
  'context', // In-use or lifestyle shot
  'scale'    // Size reference (hand, coin, etc.)
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
      "timestamp_range": {
        "start_sec": "number - when this product first appears",
        "end_sec": "number - when this product last appears"
      }
    }
  ],
  "frame_evaluation": [
    {
      "frame_id": "string - e.g., frame_00012",
      "timestamp_sec": "number",
      "product_id": "string - which product this frame shows",
      "angle": "string - one of: hero|front|back|left|right|top|bottom|detail|context|scale",
      "quality_score_0_100": "number",
      "reason": "string - brief explanation"
    }
  ],
  "recommended_shots": [
    {
      "product_id": "string - e.g., product_1",
      "angle": "string - one of: hero|front|back|left|right|top|bottom|detail|context|scale",
      "frame_id": "string or null",
      "timestamp_sec": "number or null",
      "reason": "string"
    }
  ],
  "coverage_by_product": [
    {
      "product_id": "string",
      "angles_found": ["array of angles with frames"],
      "angles_missing": ["array of angles without frames"]
    }
  ]
}`;

/**
 * System prompt for Gemini
 * MULTI-PRODUCT AWARE: Detects products and extracts all angles for each
 */
const SYSTEM_PROMPT = `You are extracting REFERENCE frames for AI image generation from a product video.

## YOUR MISSION: MAXIMIZE ANGLE COVERAGE FOR EACH PRODUCT

### STEP 1: DETECT ALL PRODUCTS
Identify every distinct product in the video:
- Different items = different products (product_1, product_2, etc.)
- Same item at different times = same product
- Note when each product appears (timestamp range)

### STEP 2: EXTRACT ALL ANGLES FOR EACH PRODUCT
For EACH product, find the best frame for EACH angle:

| Angle   | What to look for |
|---------|------------------|
| hero    | Best overall view (front or 3/4 angle) |
| front   | Direct front-facing view |
| back    | Rear view |
| left    | Left side profile (90° from front) |
| right   | Right side profile |
| top     | Top-down bird's eye view |
| bottom  | Underside view |
| detail  | Close-up of features, texture, labels |
| context | Product in use, in environment |
| scale   | Size reference (hand holding, next to object) |

### EXTRACTION RULES

**BE AGGRESSIVE - EXTRACT EVERYTHING USABLE:**
- Blurry but shows angle? EXTRACT IT
- Hand in frame? EXTRACT IT (good for scale!)
- Background messy? EXTRACT IT (AI will fix)
- Angle not perfect? EXTRACT IT (close enough)
- Same frame works for multiple angles? USE IT FOR ALL

**ONLY use null when angle is COMPLETELY ABSENT** for that product

**ONE FRAME = MULTIPLE USES:**
- A 3/4 view can be: hero + front
- Hand holding product can be: context + scale
- Close-up of label can be: detail + back

### OUTPUT
For EACH product, recommend frames for ALL 10 angles.
Group results by product in coverage_by_product.

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
 * Updated for multi-product schema
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

  // Validate required fields (relaxed for multi-product schema)
  const requiredFields = ['video', 'frame_evaluation', 'recommended_shots'];
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Gemini response missing required field: ${field}`);
    }
  }

  // Validate frame_evaluation structure
  if (!Array.isArray(parsed.frame_evaluation)) {
    throw new Error('frame_evaluation must be an array');
  }

  // Validate recommended_shots structure
  if (!Array.isArray(parsed.recommended_shots)) {
    throw new Error('recommended_shots must be an array');
  }

  // Validate angle types (now using 'angle' field instead of 'type')
  for (const shot of parsed.recommended_shots) {
    const angleField = shot.angle || shot.type; // Support both for compatibility
    if (angleField && !SHOT_TYPES.includes(angleField)) {
      console.warn(`[gemini] Unknown angle type: ${angleField}, allowing anyway`);
    }
  }

  return parsed;
}

/**
 * Extract recommended frames to final output
 * Updated for multi-product schema
 *
 * @param {Object} geminiResult - Parsed Gemini response
 * @param {Array} candidates - Original candidate frames
 * @returns {Array} Frames to extract with their recommended types
 */
export function getRecommendedFrames(geminiResult, candidates) {
  const recommended = [];
  const candidateMap = new Map(candidates.map(c => [c.frameId, c]));
  const seen = new Set(); // Track unique product+angle+frame combinations

  for (const shot of geminiResult.recommended_shots) {
    // Support both 'angle' (new) and 'type' (old) field names
    const angle = shot.angle || shot.type;
    const productId = shot.product_id || 'product_1';

    // Skip if no frame recommended for this angle
    if (!shot.frame_id) {
      console.log(`[gemini] ${productId}/${angle}: No suitable frame - ${shot.reason}`);
      continue;
    }

    // Create unique key to avoid duplicates
    const key = `${productId}_${angle}_${shot.frame_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const candidate = candidateMap.get(shot.frame_id);
    if (candidate) {
      recommended.push({
        ...candidate,
        productId,
        angle,
        recommendedType: `${productId}_${angle}`, // e.g., "product_1_hero"
        geminiReason: shot.reason,
        geminiTimestamp: shot.timestamp_sec
      });
    } else {
      console.warn(`[gemini] Frame ${shot.frame_id} not found in candidates`);
    }
  }

  // Log summary
  const products = [...new Set(recommended.map(r => r.productId))];
  console.log(`[gemini] Extracted ${recommended.length} frames for ${products.length} product(s)`);

  return recommended;
}

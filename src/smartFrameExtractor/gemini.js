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
 * Output schema that Gemini must follow
 *
 * WHY strict schema:
 * - Enables deterministic parsing
 * - Prevents hallucinated fields
 * - Ensures we get all required information
 */
const OUTPUT_SCHEMA = `{
  "video": {
    "filename": "string - original video filename",
    "duration_sec": "number - video duration in seconds"
  },
  "frame_evaluation": [
    {
      "frame_id": "string - e.g., frame_00012",
      "timestamp_sec": "number - timestamp in video",
      "quality_score_0_100": "number - your quality assessment 0-100",
      "labels": ["array of: 'hero' | 'side' | 'detail' | 'context'"],
      "reason": "string - brief explanation of suitability"
    }
  ],
  "recommended_shots": [
    {
      "type": "string - 'hero' | 'side' | 'detail' | 'context'",
      "frame_id": "string - e.g., frame_00012",
      "timestamp_sec": "number",
      "reason": "string - why this frame is recommended for this type"
    }
  ],
  "overall_quality": {
    "rating": "string - 'excellent' | 'usable' | 'poor'",
    "issues": ["array of: 'blur' | 'fast_motion' | 'hand_occlusion' | 'low_light' | 'background_clutter'"]
  }
}`;

/**
 * System prompt for Gemini
 *
 * WHY detailed prompt:
 * - Gemini needs context about the task
 * - Product photography has specific conventions
 * - We want reasoning, not just labels
 */
const SYSTEM_PROMPT = `You are an expert product photographer assistant analyzing candidate frames from a product video.

Your task is to classify frames and recommend the best shots for an e-commerce product listing.

## Frame Types

**HERO**: The main product image. Should show:
- Full product clearly visible
- Best angle (usually front or 3/4 view)
- Sharp focus, no motion blur
- Clean background or product stands out
- Would work as the primary listing image

**SIDE**: Secondary angles. Should show:
- Different perspective from hero (side, back, top)
- Product still clearly identifiable
- Good for showing product dimensions or alternative views

**DETAIL**: Close-up or feature shots. Should show:
- Specific features, textures, or components
- Can be partial product view
- Useful for highlighting quality or unique features

**CONTEXT**: Usage or lifestyle shots. Should show:
- Product in use or in environment
- Scale reference (hand holding product, etc.)
- Less strict on framing, more about storytelling

## Quality Assessment

Rate each frame 0-100 based on:
- Sharpness/focus (40%)
- Composition/framing (30%)
- Product visibility (20%)
- Background cleanliness (10%)

A frame can have multiple labels if it serves multiple purposes.

## Output Requirements

1. Evaluate ALL provided frames
2. Recommend at least one frame per type if suitable candidates exist
3. If no good candidate exists for a type, explain why
4. Be honest about quality issues - it helps the user reshoot if needed

IMPORTANT: Return ONLY valid JSON matching the schema. No markdown, no explanation outside JSON.`;

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
    model = 'gemini-1.5-flash',  // Fast and capable for this task
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
      maxOutputTokens: 4096
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
 *
 * WHY validation:
 * - LLMs can produce malformed JSON
 * - We need to catch this before downstream processing
 * - Provides clear error messages
 *
 * @param {string} text - Raw response text
 * @returns {Object} Parsed and validated response
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
  const requiredFields = ['video', 'frame_evaluation', 'recommended_shots', 'overall_quality'];
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Gemini response missing required field: ${field}`);
    }
  }

  // Validate frame_evaluation structure
  if (!Array.isArray(parsed.frame_evaluation)) {
    throw new Error('frame_evaluation must be an array');
  }

  for (const frame of parsed.frame_evaluation) {
    if (!frame.frame_id || typeof frame.quality_score_0_100 !== 'number') {
      throw new Error(`Invalid frame_evaluation entry: ${JSON.stringify(frame)}`);
    }
  }

  // Validate recommended_shots structure
  if (!Array.isArray(parsed.recommended_shots)) {
    throw new Error('recommended_shots must be an array');
  }

  const validTypes = ['hero', 'side', 'detail', 'context'];
  for (const shot of parsed.recommended_shots) {
    if (!validTypes.includes(shot.type)) {
      throw new Error(`Invalid shot type: ${shot.type}`);
    }
  }

  // Validate overall_quality
  const validRatings = ['excellent', 'usable', 'poor'];
  if (!validRatings.includes(parsed.overall_quality.rating)) {
    throw new Error(`Invalid quality rating: ${parsed.overall_quality.rating}`);
  }

  return parsed;
}

/**
 * Extract recommended frames to final output
 *
 * WHY separate extraction:
 * - We may want to re-extract at higher quality
 * - Allows for local search window optimization
 * - Keeps Gemini logic separate from file I/O
 *
 * @param {Object} geminiResult - Parsed Gemini response
 * @param {Array} candidates - Original candidate frames
 * @returns {Array} Frames to extract with their recommended types
 */
export function getRecommendedFrames(geminiResult, candidates) {
  const recommended = [];
  const candidateMap = new Map(candidates.map(c => [c.frameId, c]));

  for (const shot of geminiResult.recommended_shots) {
    const candidate = candidateMap.get(shot.frame_id);
    if (candidate) {
      recommended.push({
        ...candidate,
        recommendedType: shot.type,
        geminiReason: shot.reason,
        geminiTimestamp: shot.timestamp_sec
      });
    } else {
      console.warn(`[gemini] Recommended frame ${shot.frame_id} not found in candidates`);
    }
  }

  return recommended;
}

/**
 * commercialGen.js - Commercial image generation from reference frames
 *
 * WHY this module exists:
 * - Transforms extracted reference frames into professional commercial images
 * - Uses Gemini's image generation capabilities (Imagen 3)
 * - Applies appropriate prompts for product photography
 * - Handles different product types and angles
 *
 * Key insight: Reference frames provide product structure and details,
 * AI generation adds professional lighting, clean backgrounds, and polish.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

/**
 * Commercial photography style prompts by angle
 * These guide the AI to generate appropriate commercial looks
 */
const ANGLE_PROMPTS = {
  hero: 'main product shot, dramatic lighting, slight 3/4 angle, hero image',
  front: 'direct front view, symmetrical, clean product shot',
  back: 'back view showing rear details, even lighting',
  left: 'left side profile, clean side view',
  right: 'right side profile, clean side view',
  top: 'top-down bird eye view, flat lay style',
  bottom: 'bottom view showing underside',
  detail: 'close-up macro shot, showing texture and fine details',
  context: 'lifestyle shot, product in use, natural environment',
  scale: 'size reference shot, human hand or common object for scale'
};

/**
 * Background styles for different shot types
 */
const BACKGROUND_STYLES = {
  studio: 'pure white seamless studio background, professional product photography lighting',
  gradient: 'soft gradient background, subtle shadow, floating product effect',
  lifestyle: 'natural lifestyle environment, soft bokeh background',
  minimal: 'clean minimal background, subtle surface reflection'
};

/**
 * Generate commercial image prompt based on frame metadata
 *
 * KEY APPROACH: Background replacement only
 * - Keep the product EXACTLY as-is (preserves all text, labels, details)
 * - Only remove and replace the background
 * - Center the product in frame
 * - Generate appropriate background based on product angle and colors
 *
 * @param {Object} frame - Frame with product and angle info
 * @param {Object} options - Generation options
 * @returns {string} Constructed prompt
 */
function buildCommercialPrompt(frame, options = {}) {
  const {
    backgroundStyle = 'studio',
    additionalInstructions = ''
  } = options;

  const bgPrompt = BACKGROUND_STYLES[backgroundStyle] || BACKGROUND_STYLES.studio;

  // Build the full prompt - focus on background replacement only
  const prompt = `TASK: Remove the background and replace it with a professional product photography background.

CRITICAL RULES - READ CAREFULLY:
1. DO NOT modify the product in ANY way
2. DO NOT regenerate, redraw, or touch the product itself
3. DO NOT change any text, labels, logos, or details on the product
4. ONLY remove the existing background (hands, table, floor, etc.)
5. ONLY add a new clean background behind the product

WHAT TO DO:
1. Identify and isolate the product from the background
2. Remove everything that is NOT the product (hands, surfaces, clutter)
3. Center the product in the frame
4. Generate a new background: ${bgPrompt}
5. Add appropriate shadows/reflections that match the product's angle and lighting
6. Match the lighting direction of the original product

BACKGROUND REQUIREMENTS:
- Clean, professional e-commerce style
- Shadows should be soft and natural
- Lighting should complement the product's existing lighting
- Colors should not clash with the product

THE PRODUCT MUST REMAIN 100% UNCHANGED - only the background changes.

${additionalInstructions ? `ADDITIONAL: ${additionalInstructions}` : ''}`;

  return prompt;
}

/**
 * Supported image generation models
 * Based on: https://ai.google.dev/gemini-api/docs/image-generation
 */
const IMAGE_GEN_MODELS = {
  flash: 'gemini-2.0-flash-exp',           // Gemini 2.0 Flash experimental (with image output)
  imagen: 'imagen-3.0-generate-001'        // Imagen 3 for pure image generation
};

// Export for CLI help
export { IMAGE_GEN_MODELS };

/**
 * Generate a commercial image from a reference frame using Gemini
 *
 * WHY Gemini for image generation:
 * - Already integrated in our pipeline
 * - Supports image-to-image with reference
 * - Can understand product context for better results
 *
 * @param {Object} genAI - Gemini client
 * @param {Object} frame - Frame object with path and metadata
 * @param {string} outputPath - Where to save the generated image
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Generation result
 */
export async function generateCommercialImage(genAI, frame, outputPath, options = {}) {
  const {
    model = IMAGE_GEN_MODELS.flash,  // Image generation model
    backgroundStyle = 'studio',
    additionalInstructions = ''
  } = options;

  console.log(`[commercial] Generating commercial image for ${frame.recommendedType}...`);

  try {
    // Read the reference image
    const imageData = await readFile(frame.path);
    const base64Image = imageData.toString('base64');

    // Get the model with image generation config
    // IMPORTANT: responseModalities must be uppercase ['TEXT', 'IMAGE']
    const geminiModel = genAI.getGenerativeModel({
      model,
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],  // Enable image output (uppercase required)
        temperature: 0.4
      }
    });

    // Build the prompt
    const prompt = buildCommercialPrompt(frame, { backgroundStyle, additionalInstructions });

    // Create content with reference image
    const content = [
      {
        inlineData: {
          data: base64Image,
          mimeType: 'image/png'
        }
      },
      { text: prompt }
    ];

    // Generate
    const result = await geminiModel.generateContent(content);
    const response = await result.response;

    // Check if response contains generated image
    const parts = response.candidates?.[0]?.content?.parts || [];

    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        // Save the generated image
        const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        await writeFile(outputPath, imageBuffer);

        console.log(`[commercial] Saved: ${path.basename(outputPath)}`);

        return {
          success: true,
          outputPath,
          frameId: frame.frameId,
          angle: frame.angle,
          productId: frame.productId
        };
      }
    }

    // If no image in response, log what we got
    console.warn(`[commercial] Model did not return image for ${frame.recommendedType}`);

    // Log response details for debugging
    if (parts.length > 0) {
      const textParts = parts.filter(p => p.text).map(p => p.text.slice(0, 100));
      if (textParts.length > 0) {
        console.warn(`[commercial] Got text response instead: ${textParts[0]}...`);
      }
    }
    console.warn('[commercial] Image generation may not be available. Try using Imagen API or external tools.');

    return {
      success: false,
      reason: 'no_image_in_response',
      frameId: frame.frameId
    };

  } catch (error) {
    console.error(`[commercial] Failed to generate for ${frame.recommendedType}: ${error.message}`);

    // Check for specific error types
    if (error.message.includes('not supported') || error.message.includes('INVALID_ARGUMENT')) {
      console.error('[commercial] Image generation not supported by this model/API configuration.');
      console.error('[commercial] Consider using Google Vertex AI with Imagen, or external image generation APIs.');
    }

    return {
      success: false,
      reason: error.message,
      frameId: frame.frameId
    };
  }
}

/**
 * Generate commercial images for all recommended frames
 *
 * WHY batch processing:
 * - Handles multiple products and angles efficiently
 * - Provides progress feedback
 * - Collects results for summary
 *
 * @param {Object} genAI - Gemini client
 * @param {Array} frames - Recommended frames with metadata
 * @param {string} outputDir - Output directory for commercial images
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Batch generation results
 */
export async function generateCommercialImages(genAI, frames, outputDir, options = {}) {
  const {
    model = 'gemini-2.0-flash-exp',
    backgroundStyle = 'studio',
    concurrency = 1,  // Sequential by default to avoid rate limits
    skipExisting = true
  } = options;

  console.log(`[commercial] Starting commercial image generation for ${frames.length} frames...`);

  // Create output directory
  await mkdir(outputDir, { recursive: true });

  const results = {
    successful: [],
    failed: [],
    skipped: []
  };

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    // Build output filename
    const outputFilename = `commercial_${frame.recommendedType}_${frame.frameId}.png`;
    const outputPath = path.join(outputDir, outputFilename);

    console.log(`[commercial] Processing ${i + 1}/${frames.length}: ${frame.recommendedType}`);

    // Check if already exists
    if (skipExisting) {
      try {
        await readFile(outputPath);
        console.log(`[commercial] Skipping existing: ${outputFilename}`);
        results.skipped.push({ frameId: frame.frameId, outputPath });
        continue;
      } catch {
        // File doesn't exist, proceed with generation
      }
    }

    // Generate
    const result = await generateCommercialImage(genAI, frame, outputPath, {
      model,
      backgroundStyle
    });

    if (result.success) {
      results.successful.push(result);
    } else {
      results.failed.push(result);
    }

    // Small delay between requests to avoid rate limiting
    if (i < frames.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`[commercial] Generation complete: ${results.successful.length} successful, ${results.failed.length} failed, ${results.skipped.length} skipped`);

  return results;
}

/**
 * Alternative: Generate using external image generation API
 * This can be extended to support other providers like:
 * - Stability AI
 * - DALL-E
 * - Midjourney API
 *
 * @param {Object} frame - Frame object
 * @param {string} outputPath - Output path
 * @param {Object} options - API-specific options
 */
export async function generateWithExternalAPI(frame, outputPath, options = {}) {
  // Placeholder for external API integration
  // Can be implemented based on user's preferred provider
  throw new Error('External API not configured. Set up your preferred image generation provider.');
}

/**
 * Simple fallback: Copy reference frame with enhanced metadata
 * Used when image generation is not available
 *
 * @param {Object} frame - Frame object
 * @param {string} outputPath - Output path
 * @param {Object} options - Generation options for prompt
 */
export async function copyAsCommercialPlaceholder(frame, outputPath, options = {}) {
  const { copyFile } = await import('fs/promises');
  await copyFile(frame.path, outputPath);

  // Create a sidecar JSON with generation instructions
  const metadataPath = outputPath.replace('.png', '_prompt.json');
  const metadata = {
    source_frame: frame.frameId,
    product_id: frame.productId,
    angle: frame.angle,
    background_style: options.backgroundStyle || 'studio',
    suggested_prompt: buildCommercialPrompt(frame, options),
    note: 'This is a reference frame. Use with your preferred image generation tool.',
    approach: 'Background replacement only - keep product exactly as-is, only replace background'
  };

  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  return {
    success: true,
    outputPath,
    isPlaceholder: true
  };
}

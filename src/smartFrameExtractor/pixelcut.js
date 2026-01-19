/**
 * pixelcut.js - PixelCut API integration for commercial image generation
 *
 * WHY PixelCut:
 * - Specialized for product photography
 * - Clean background removal that preserves product exactly
 * - AI-generated backgrounds tailored for e-commerce
 * - Preserves all text/labels on products
 *
 * API Docs: https://www.pixelcut.ai/docs/developer-guide/
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const PIXELCUT_BASE_URL = 'https://api.developer.pixelcut.ai/v1';

/**
 * Background style prompts for generate-background API
 */
const BG_PROMPTS = {
  studio: 'Clean white studio background with soft professional lighting and subtle shadow',
  gradient: 'Soft gradient background from white to light gray with elegant shadow',
  lifestyle: 'Modern lifestyle setting, clean interior background, natural lighting',
  minimal: 'Minimalist surface with soft reflection, clean and modern'
};

/**
 * Make a request to PixelCut API
 *
 * @param {string} endpoint - API endpoint (e.g., 'remove-background')
 * @param {Object} body - Request body
 * @param {string} apiKey - PixelCut API key
 * @param {boolean} binaryResponse - Whether to expect binary image response
 * @returns {Promise<Object|Buffer>} API response
 */
async function pixelcutRequest(endpoint, body, apiKey, binaryResponse = false) {
  const url = `${PIXELCUT_BASE_URL}/${endpoint}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      'Accept': binaryResponse ? 'image/*' : 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PixelCut API error (${response.status}): ${errorText}`);
  }

  if (binaryResponse) {
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  }

  return response.json();
}

/**
 * Upload image and get a temporary URL for PixelCut API
 * Since PixelCut needs a URL, we need to either:
 * 1. Use a file hosting service
 * 2. Use base64 if supported
 * 3. Use their upload endpoint if available
 *
 * For now, we'll check if they support base64 or use a data URL approach
 */
async function getImageUrl(imagePath) {
  // Read file and convert to base64 data URL
  const imageData = await readFile(imagePath);
  const base64 = imageData.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

  // Return as data URL - some APIs accept this
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Remove background from product image
 *
 * @param {string} imagePath - Path to input image
 * @param {string} apiKey - PixelCut API key
 * @param {Object} options - Options
 * @returns {Promise<Buffer>} Image buffer with transparent background
 */
export async function removeBackground(imagePath, apiKey, options = {}) {
  const {
    addShadow = true,  // Add AI shadow for natural look
    crop = false       // Auto-crop to subject
  } = options;

  console.log(`[pixelcut] Removing background from ${path.basename(imagePath)}...`);

  // Read image as base64
  const imageData = await readFile(imagePath);
  const base64 = imageData.toString('base64');

  // PixelCut accepts image_url or image_base64
  const body = {
    image_base64: base64,
    format: 'png'  // PNG to preserve transparency
  };

  // Add shadow option if supported
  if (addShadow) {
    body.add_shadow = true;
  }

  const result = await pixelcutRequest('remove-background', body, apiKey);

  // Download the result image
  if (result.result_url) {
    console.log(`[pixelcut] Downloading result...`);
    const imageResponse = await fetch(result.result_url);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download result: ${imageResponse.status}`);
    }
    const buffer = await imageResponse.arrayBuffer();
    return Buffer.from(buffer);
  }

  throw new Error('No result_url in response');
}

/**
 * Generate a new background for a product image
 *
 * @param {string} imagePath - Path to image (should have transparent background)
 * @param {string} apiKey - PixelCut API key
 * @param {Object} options - Options
 * @returns {Promise<Buffer>} Image buffer with generated background
 */
export async function generateBackground(imagePath, apiKey, options = {}) {
  const {
    prompt = BG_PROMPTS.studio,
    backgroundStyle = 'studio'
  } = options;

  // Use predefined prompt if style provided
  const bgPrompt = BG_PROMPTS[backgroundStyle] || prompt;

  console.log(`[pixelcut] Generating ${backgroundStyle} background...`);

  // Read image as base64
  const imageData = await readFile(imagePath);
  const base64 = imageData.toString('base64');

  const body = {
    image_base64: base64,
    prompt: bgPrompt
  };

  const result = await pixelcutRequest('generate-background', body, apiKey);

  // Download the result image
  if (result.result_url) {
    console.log(`[pixelcut] Downloading result...`);
    const imageResponse = await fetch(result.result_url);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download result: ${imageResponse.status}`);
    }
    const buffer = await imageResponse.arrayBuffer();
    return Buffer.from(buffer);
  }

  throw new Error('No result_url in response');
}

/**
 * Full commercial image pipeline:
 * 1. Remove background
 * 2. Generate new professional background
 *
 * @param {string} inputPath - Path to input product image
 * @param {string} outputPath - Path to save result
 * @param {string} apiKey - PixelCut API key
 * @param {Object} options - Options
 * @returns {Promise<Object>} Result info
 */
export async function createCommercialImage(inputPath, outputPath, apiKey, options = {}) {
  const {
    backgroundStyle = 'studio',
    customPrompt = null,
    keepTransparent = false,  // Save the transparent version too
    tempDir = null
  } = options;

  console.log(`[pixelcut] Creating commercial image for ${path.basename(inputPath)}...`);

  try {
    // Step 1: Remove background
    const transparentBuffer = await removeBackground(inputPath, apiKey, {
      addShadow: false  // We'll let generate-background handle shadows
    });

    // Optionally save transparent version
    let transparentPath = null;
    if (keepTransparent) {
      transparentPath = outputPath.replace('.png', '_transparent.png');
      await writeFile(transparentPath, transparentBuffer);
      console.log(`[pixelcut] Saved transparent: ${path.basename(transparentPath)}`);
    }

    // Step 2: Generate new background
    // First save transparent to temp file for the next API call
    const tempPath = tempDir
      ? path.join(tempDir, `temp_${Date.now()}.png`)
      : outputPath.replace('.png', '_temp.png');

    await writeFile(tempPath, transparentBuffer);

    const finalBuffer = await generateBackground(tempPath, apiKey, {
      backgroundStyle,
      prompt: customPrompt
    });

    // Save final result
    await writeFile(outputPath, finalBuffer);
    console.log(`[pixelcut] Saved: ${path.basename(outputPath)}`);

    // Cleanup temp file
    const { unlink } = await import('fs/promises');
    await unlink(tempPath).catch(() => {});

    return {
      success: true,
      outputPath,
      transparentPath
    };

  } catch (error) {
    console.error(`[pixelcut] Failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Check API credits
 *
 * @param {string} apiKey - PixelCut API key
 * @returns {Promise<number>} Remaining credits
 */
export async function getCredits(apiKey) {
  const response = await fetch(`${PIXELCUT_BASE_URL}/credits`, {
    headers: {
      'X-API-Key': apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to get credits: ${response.status}`);
  }

  const data = await response.json();
  return data.credits;
}

// Export background prompts for customization
export { BG_PROMPTS };

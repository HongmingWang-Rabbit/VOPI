/**
 * photoroom.js - Photoroom API integration for background removal
 *
 * WHY Photoroom:
 * - Accepts local files via multipart/form-data
 * - High quality background removal
 * - Preserves product details and text perfectly
 * - v2/edit endpoint supports AI modifications via describeAnyChange
 *
 * API Docs:
 * - Basic: https://docs.photoroom.com/remove-background-api-basic-plan/node.js-integration
 * - Plus: https://docs.photoroom.com/image-editing-api-plus-plan
 */

import { readFile, writeFile } from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import https from 'https';

// Basic plan - background removal only
const PHOTOROOM_BASIC_URL = 'sdk.photoroom.com';
const PHOTOROOM_BASIC_ENDPOINT = '/v1/segment';

// Plus plan - full image editing including AI modifications
const PHOTOROOM_PLUS_URL = 'image-api.photoroom.com';
const PHOTOROOM_EDIT_ENDPOINT = '/v2/edit';

/**
 * Edit image using Photoroom v2/edit API with AI modifications
 *
 * WHY v2/edit:
 * - Supports describeAnyChange for AI-based modifications
 * - Can attempt to remove hands via prompt
 * - Combines background removal with AI edits
 *
 * @param {string} imagePath - Path to input image
 * @param {string} outputPath - Path to save result
 * @param {string} apiKey - Photoroom API key
 * @param {Object} options - Edit options
 * @returns {Promise<Object>} Result info
 */
/**
 * Build removal prompt based on obstruction types
 */
function buildRemovalPrompt(obstructions) {
  if (!obstructions || !obstructions.has_obstruction || obstructions.obstruction_types.length === 0) {
    return null; // No obstructions to remove
  }

  const typeDescriptions = {
    'hand': 'human hands and fingers',
    'finger': 'fingers',
    'arm': 'human arms',
    'cord': 'cords and cables',
    'tag': 'price tags and labels',
    'reflection': 'unwanted reflections',
    'shadow': 'harsh shadows',
    'other_object': 'foreign objects'
  };

  const items = obstructions.obstruction_types
    .map(t => typeDescriptions[t] || t)
    .join(', ');

  // Very restrictive prompt - ONLY remove obstructions, preserve product EXACTLY
  return `Erase ONLY the ${items} from this image. DO NOT modify, change, or alter the product in any way. The product must remain pixel-perfect identical. Replace the removed areas with transparent background only.`;
}

export async function editImageWithAI(imagePath, outputPath, apiKey, options = {}) {
  const {
    obstructions = null,  // Obstruction metadata from Gemini
    customPrompt = null
  } = options;

  // Build the prompt based on obstructions or use custom prompt
  const prompt = customPrompt || buildRemovalPrompt(obstructions) ||
    'Erase any human hands, fingers, or arms from this image. DO NOT modify the product in any way. Replace removed areas with transparent background only.';

  console.log(`[photoroom] Editing image with AI: ${path.basename(imagePath)}...`);
  console.log(`[photoroom] Prompt: ${prompt.slice(0, 100)}...`);

  return new Promise((resolve, reject) => {
    const boundary = '--------------------------' + Date.now().toString(16);

    const postOptions = {
      hostname: PHOTOROOM_PLUS_URL,
      path: PHOTOROOM_EDIT_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'x-api-key': apiKey
      }
    };

    const req = https.request(postOptions, (res) => {
      const contentType = res.headers['content-type'] || '';
      const isImage = contentType.includes('image/');

      if (!isImage) {
        let errorData = '';
        res.on('data', (chunk) => errorData += chunk);
        res.on('end', () => {
          console.error(`[photoroom] v2/edit API error (${res.statusCode}): ${errorData}`);
          reject(new Error(`Photoroom v2/edit error: ${errorData}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        try {
          const imageBuffer = Buffer.concat(chunks);
          await writeFile(outputPath, imageBuffer);
          console.log(`[photoroom] AI edit saved: ${path.basename(outputPath)}`);
          resolve({
            success: true,
            outputPath,
            size: imageBuffer.length,
            method: 'v2/edit'
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[photoroom] v2/edit request error: ${err.message}`);
      reject(err);
    });

    // Build multipart form data
    const filename = path.basename(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    // Helper to add form field
    const addField = (name, value) => {
      req.write(`--${boundary}\r\n`);
      req.write(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
      req.write(`${value}\r\n`);
    };

    // Add form fields
    addField('removeBackground', 'true');
    addField('outputFormat', 'png');
    addField('describeAnyChange.mode', 'ai.auto');
    addField('describeAnyChange.prompt', prompt);

    // Add image file header
    req.write(`--${boundary}\r\n`);
    req.write(`Content-Disposition: form-data; name="imageFile"; filename="${filename}"\r\n`);
    req.write(`Content-Type: ${mimeType}\r\n\r\n`);

    // Stream the file
    const fileStream = createReadStream(imagePath);

    fileStream.on('end', () => {
      req.write('\r\n');
      req.write(`--${boundary}--\r\n`);
      req.end();
    });

    fileStream.on('error', (err) => {
      reject(err);
    });

    fileStream.pipe(req, { end: false });
  });
}

/**
 * Generate image with solid color background using v2/edit API
 *
 * @param {string} imagePath - Path to input image
 * @param {string} outputPath - Path to save result
 * @param {string} apiKey - Photoroom API key
 * @param {string} bgColor - Hex color code (e.g., '#FFFFFF')
 * @returns {Promise<Object>} Result info
 */
export async function generateWithSolidBackground(imagePath, outputPath, apiKey, bgColor) {
  console.log(`[photoroom] Generating with solid background (${bgColor}): ${path.basename(imagePath)}...`);

  return new Promise((resolve, reject) => {
    const boundary = '--------------------------' + Date.now().toString(16);

    const postOptions = {
      hostname: PHOTOROOM_PLUS_URL,
      path: PHOTOROOM_EDIT_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'x-api-key': apiKey
      }
    };

    const req = https.request(postOptions, (res) => {
      const contentType = res.headers['content-type'] || '';
      const isImage = contentType.includes('image/');

      if (!isImage) {
        let errorData = '';
        res.on('data', (chunk) => errorData += chunk);
        res.on('end', () => {
          console.error(`[photoroom] Solid bg error (${res.statusCode}): ${errorData}`);
          reject(new Error(`Photoroom solid bg error: ${errorData}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        try {
          const imageBuffer = Buffer.concat(chunks);
          await writeFile(outputPath, imageBuffer);
          console.log(`[photoroom] Solid bg saved: ${path.basename(outputPath)}`);
          resolve({
            success: true,
            outputPath,
            size: imageBuffer.length,
            method: 'solid_background',
            bgColor
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    const filename = path.basename(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    const addField = (name, value) => {
      req.write(`--${boundary}\r\n`);
      req.write(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
      req.write(`${value}\r\n`);
    };

    addField('removeBackground', 'true');
    addField('outputFormat', 'png');
    addField('background.color', bgColor);
    // Add padding to center product at ~75% size
    addField('padding', '0.12');

    req.write(`--${boundary}\r\n`);
    req.write(`Content-Disposition: form-data; name="imageFile"; filename="${filename}"\r\n`);
    req.write(`Content-Type: ${mimeType}\r\n\r\n`);

    const fileStream = createReadStream(imagePath);
    fileStream.on('end', () => {
      req.write('\r\n');
      req.write(`--${boundary}--\r\n`);
      req.end();
    });
    fileStream.on('error', reject);
    fileStream.pipe(req, { end: false });
  });
}

/**
 * Generate image with AI-generated background using v2/edit API
 *
 * @param {string} imagePath - Path to input image
 * @param {string} outputPath - Path to save result
 * @param {string} apiKey - Photoroom API key
 * @param {string} bgPrompt - Description of desired background
 * @returns {Promise<Object>} Result info
 */
export async function generateWithAIBackground(imagePath, outputPath, apiKey, bgPrompt) {
  console.log(`[photoroom] Generating with AI background: ${path.basename(imagePath)}...`);
  console.log(`[photoroom] Background prompt: ${bgPrompt.slice(0, 80)}...`);

  return new Promise((resolve, reject) => {
    const boundary = '--------------------------' + Date.now().toString(16);

    const postOptions = {
      hostname: PHOTOROOM_PLUS_URL,
      path: PHOTOROOM_EDIT_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'x-api-key': apiKey
      }
    };

    const req = https.request(postOptions, (res) => {
      const contentType = res.headers['content-type'] || '';
      const isImage = contentType.includes('image/');

      if (!isImage) {
        let errorData = '';
        res.on('data', (chunk) => errorData += chunk);
        res.on('end', () => {
          console.error(`[photoroom] AI bg error (${res.statusCode}): ${errorData}`);
          reject(new Error(`Photoroom AI bg error: ${errorData}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        try {
          const imageBuffer = Buffer.concat(chunks);
          await writeFile(outputPath, imageBuffer);
          console.log(`[photoroom] AI bg saved: ${path.basename(outputPath)}`);
          resolve({
            success: true,
            outputPath,
            size: imageBuffer.length,
            method: 'ai_background',
            bgPrompt
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    const filename = path.basename(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    const addField = (name, value) => {
      req.write(`--${boundary}\r\n`);
      req.write(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
      req.write(`${value}\r\n`);
    };

    addField('removeBackground', 'true');
    addField('outputFormat', 'png');
    addField('background.prompt', bgPrompt);
    // Add padding to center product at ~75% size
    addField('padding', '0.12');

    req.write(`--${boundary}\r\n`);
    req.write(`Content-Disposition: form-data; name="imageFile"; filename="${filename}"\r\n`);
    req.write(`Content-Type: ${mimeType}\r\n\r\n`);

    const fileStream = createReadStream(imagePath);
    fileStream.on('end', () => {
      req.write('\r\n');
      req.write(`--${boundary}--\r\n`);
      req.end();
    });
    fileStream.on('error', reject);
    fileStream.pipe(req, { end: false });
  });
}

/**
 * Remove background from an image using Photoroom API (basic v1/segment)
 *
 * @param {string} imagePath - Path to input image
 * @param {string} outputPath - Path to save result
 * @param {string} apiKey - Photoroom API key
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Result info
 */
export async function removeBackground(imagePath, outputPath, apiKey, options = {}) {
  const {
    format = 'png',  // Output format (png for transparency)
    bgColor = null   // Optional background color (null = transparent)
  } = options;

  console.log(`[photoroom] Removing background from ${path.basename(imagePath)}...`);

  return new Promise((resolve, reject) => {
    const boundary = '--------------------------' + Date.now().toString(16);

    const postOptions = {
      hostname: PHOTOROOM_BASIC_URL,
      path: PHOTOROOM_BASIC_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'x-api-key': apiKey
      }
    };

    const req = https.request(postOptions, (res) => {
      // Check if response is an image
      const contentType = res.headers['content-type'] || '';
      const isImage = contentType.includes('image/');

      if (!isImage) {
        let errorData = '';
        res.on('data', (chunk) => errorData += chunk);
        res.on('end', () => {
          console.error(`[photoroom] API error: ${errorData}`);
          reject(new Error(`Photoroom API error: ${errorData}`));
        });
        return;
      }

      // Collect image data
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        try {
          const imageBuffer = Buffer.concat(chunks);
          await writeFile(outputPath, imageBuffer);
          console.log(`[photoroom] Saved: ${path.basename(outputPath)}`);
          resolve({
            success: true,
            outputPath,
            size: imageBuffer.length
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[photoroom] Request error: ${err.message}`);
      reject(err);
    });

    // Build multipart form data
    const filename = path.basename(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    // Write form data header
    req.write(`--${boundary}\r\n`);
    req.write(`Content-Disposition: form-data; name="image_file"; filename="${filename}"\r\n`);
    req.write(`Content-Type: ${mimeType}\r\n\r\n`);

    // Stream the file
    const fileStream = createReadStream(imagePath);

    fileStream.on('end', () => {
      req.write('\r\n');
      req.write(`--${boundary}--\r\n`);
      req.end();
    });

    fileStream.on('error', (err) => {
      reject(err);
    });

    fileStream.pipe(req, { end: false });
  });
}

/**
 * Generate all commercial versions for a single frame
 *
 * @param {Object} frame - Frame object with path and backgroundRecommendations
 * @param {string} outputDir - Output directory
 * @param {string} apiKey - Photoroom API key
 * @param {Object} options - Options
 * @returns {Promise<Object>} Results for all versions
 */
export async function generateAllVersions(frame, outputDir, apiKey, options = {}) {
  const {
    useAIEdit = false,
    versions = ['transparent', 'solid', 'real', 'creative'] // Which versions to generate
  } = options;

  const baseName = `${frame.recommendedType}_${frame.frameId}`;
  const hasObstruction = frame.obstructions?.has_obstruction;
  const bgRec = frame.backgroundRecommendations || {
    solid_color: '#FFFFFF',
    real_life_setting: 'on a clean white surface with soft lighting',
    creative_shot: 'floating with soft shadow on gradient background'
  };

  const results = {
    frameId: frame.frameId,
    recommendedType: frame.recommendedType,
    versions: {}
  };

  // 1. ALWAYS generate transparent PNG first (with obstruction removal if needed)
  // This becomes the source for all other versions
  const transparentPath = path.join(outputDir, `${baseName}_transparent.png`);
  let transparentSuccess = false;

  // Retry logic for transparent - critical for obstructed images
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (useAIEdit && hasObstruction) {
        results.versions.transparent = await editImageWithAI(frame.path, transparentPath, apiKey, {
          obstructions: frame.obstructions
        });
      } else {
        results.versions.transparent = await removeBackground(frame.path, transparentPath, apiKey);
      }
      transparentSuccess = results.versions.transparent?.success;
      if (transparentSuccess) break;
    } catch (err) {
      console.error(`[photoroom] Transparent attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      results.versions.transparent = { success: false, error: err.message };
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000)); // Wait before retry
      }
    }
  }
  await new Promise(r => setTimeout(r, 500));

  // For obstructed images, we MUST have transparent succeed to remove hands
  // Skip other versions if transparent failed - they would have hands in them
  if (hasObstruction && !transparentSuccess) {
    console.error(`[photoroom] Skipping other versions for ${baseName} - transparent failed and image has obstructions`);
    return results;
  }

  // Use transparent PNG as source for other versions (if it was generated successfully)
  // This ensures obstructions are removed from all versions
  const sourceForBackgrounds = transparentSuccess ? transparentPath : frame.path;

  // 2. Solid color background (using transparent PNG as source)
  if (versions.includes('solid')) {
    const outputPath = path.join(outputDir, `${baseName}_solid.png`);
    try {
      results.versions.solid = await generateWithSolidBackground(
        sourceForBackgrounds, outputPath, apiKey, bgRec.solid_color
      );
    } catch (err) {
      results.versions.solid = { success: false, error: err.message };
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 3. Real-life setting background (using transparent PNG as source)
  if (versions.includes('real')) {
    const outputPath = path.join(outputDir, `${baseName}_real.png`);
    try {
      results.versions.real = await generateWithAIBackground(
        sourceForBackgrounds, outputPath, apiKey, bgRec.real_life_setting
      );
    } catch (err) {
      results.versions.real = { success: false, error: err.message };
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 4. Creative shot background (using transparent PNG as source)
  if (versions.includes('creative')) {
    const outputPath = path.join(outputDir, `${baseName}_creative.png`);
    try {
      results.versions.creative = await generateWithAIBackground(
        sourceForBackgrounds, outputPath, apiKey, bgRec.creative_shot
      );
    } catch (err) {
      results.versions.creative = { success: false, error: err.message };
    }
  }

  // Remove transparent from results if user didn't request it
  if (!versions.includes('transparent')) {
    delete results.versions.transparent;
  }

  return results;
}

/**
 * Process multiple images for background removal
 *
 * @param {Array} frames - Array of frame objects with path property
 * @param {string} outputDir - Output directory
 * @param {string} apiKey - Photoroom API key
 * @param {Object} options - Options including useAIEdit for hand removal
 * @returns {Promise<Object>} Results summary
 */
export async function processFrames(frames, outputDir, apiKey, options = {}) {
  const {
    useAIEdit = false,  // Use v2/edit with describeAnyChange for obstruction removal
    ...restOptions
  } = options;

  const results = {
    successful: [],
    failed: []
  };

  console.log(`[photoroom] Mode: ${useAIEdit ? 'Smart (AI edit for obstructions, basic for clean)' : 'Basic (background removal only)'}`);

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const outputFilename = `commercial_${frame.recommendedType}_${frame.frameId}.png`;
    const outputPath = path.join(outputDir, outputFilename);

    const hasObstruction = frame.obstructions?.has_obstruction;
    const obstructionInfo = hasObstruction
      ? ` [obstructions: ${frame.obstructions.obstruction_types.join(', ')}]`
      : '';

    console.log(`[${i + 1}/${frames.length}] ${frame.recommendedType}${obstructionInfo}`);

    try {
      let result;

      if (useAIEdit && hasObstruction) {
        // Use AI edit ONLY for frames with obstructions
        result = await editImageWithAI(frame.path, outputPath, apiKey, {
          obstructions: frame.obstructions,
          ...restOptions
        });
      } else {
        // Basic background removal for clean frames (preserves quality)
        result = await removeBackground(frame.path, outputPath, apiKey, restOptions);
      }

      results.successful.push({
        ...result,
        frameId: frame.frameId,
        recommendedType: frame.recommendedType,
        hadObstructions: hasObstruction
      });
    } catch (error) {
      console.error(`[photoroom] Failed: ${error.message}`);
      results.failed.push({
        frameId: frame.frameId,
        recommendedType: frame.recommendedType,
        error: error.message
      });
    }

    // Small delay between requests (longer for AI edit)
    if (i < frames.length - 1) {
      await new Promise(r => setTimeout(r, useAIEdit ? 1000 : 300));
    }
  }

  return results;
}

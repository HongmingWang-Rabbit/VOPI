#!/usr/bin/env node

/**
 * index.js - CLI entry point for smart frame extraction pipeline
 *
 * WHY this module exists:
 * - Provides user-friendly CLI interface
 * - Orchestrates the full pipeline
 * - Handles configuration and output
 *
 * Usage:
 *   node src/smartFrameExtractor/index.js <video_path> [options]
 *
 * Example:
 *   node src/smartFrameExtractor/index.js ./product.mp4 --fps 5 --top-k 12
 */

// Load environment variables from .env file
// WHY: Allows storing API keys in .env instead of exporting in shell
import dotenv from 'dotenv';
dotenv.config();

import { parseArgs } from 'node:util';
import { mkdir, writeFile, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

/**
 * Supported video extensions
 */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];

/**
 * Default input folder path
 */
const DEFAULT_INPUT_FOLDER = './input';

import {
  getVideoMetadata,
  extractFramesDense,
  extractSingleFrame,
  extractBestFrameInWindow,
  checkFfmpegInstalled
} from './video.js';

import {
  initGemini,
  classifyFramesWithGemini,
  getRecommendedFrames
} from './gemini.js';

import {
  scoreFrames
} from './smartFrames.js';

/**
 * Select the best frame from each second of video
 *
 * WHY: At 10fps, we have 10 frames per second. Selecting the best one
 * from each second reduces candidates while preserving temporal coverage.
 *
 * @param {Array} scoredFrames - Frames with sharpness/motion scores
 * @param {number} fps - Frames per second used during extraction
 * @returns {Array} One best frame per second
 */
function selectBestFramePerSecond(scoredFrames, fps) {
  // Group frames by second
  const framesBySecond = new Map();

  for (const frame of scoredFrames) {
    const second = Math.floor(frame.timestamp);
    if (!framesBySecond.has(second)) {
      framesBySecond.set(second, []);
    }
    framesBySecond.get(second).push(frame);
  }

  // Select best frame from each second (highest score)
  const selected = [];
  for (const [second, frames] of framesBySecond) {
    const best = frames.reduce((a, b) => (a.score > b.score ? a : b));
    selected.push(best);
  }

  // Sort by timestamp
  selected.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`[selection] Selected ${selected.length} frames (1 per second from ${scoredFrames.length} total)`);
  return selected;
}

/**
 * CLI argument definitions
 */
const CLI_OPTIONS = {
  'input': {
    type: 'string',
    short: 'i',
    default: './input',
    description: 'Input folder to scan for videos (default: ./input)'
  },
  'fps': {
    type: 'string',
    short: 'f',
    default: '10',
    description: 'Frames per second to extract (default: 10)'
  },
  'batch-size': {
    type: 'string',
    default: '30',
    description: 'Batch size for Gemini analysis (default: 30)'
  },
  'output': {
    type: 'string',
    short: 'o',
    default: './output',
    description: 'Output directory (default: ./output)'
  },
  'skip-gemini': {
    type: 'boolean',
    default: false,
    description: 'Skip Gemini frame selection'
  },
  'keep-temp': {
    type: 'boolean',
    default: false,
    description: 'Keep temporary extracted frames'
  },
  'gemini-model': {
    type: 'string',
    short: 'm',
    default: 'gemini-2.0-flash',
    description: 'Gemini model to use (default: gemini-2.0-flash)'
  },
  'help': {
    type: 'boolean',
    short: 'h',
    default: false,
    description: 'Show this help message'
  },
  'verbose': {
    type: 'boolean',
    short: 'v',
    default: false,
    description: 'Verbose output'
  }
};

/**
 * Find the first video file in a directory
 *
 * WHY: Allows users to simply drop a video in ./input and run without arguments
 * Files are sorted alphabetically, so naming like "001_product.mp4" controls order
 *
 * @param {string} folderPath - Directory to scan
 * @returns {Promise<string|null>} Path to first video or null if none found
 */
async function findFirstVideo(folderPath) {
  if (!existsSync(folderPath)) {
    return null;
  }

  try {
    const files = await readdir(folderPath);

    // Filter to video files and sort alphabetically
    const videoFiles = files
      .filter(f => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .sort();

    if (videoFiles.length === 0) {
      return null;
    }

    return path.join(folderPath, videoFiles[0]);
  } catch (e) {
    return null;
  }
}

/**
 * Print usage information
 */
function printHelp() {
  console.log(`
Smart Frame Extraction Pipeline

Extracts the best product frames from a video using sharpness/motion
analysis and AI classification.

Usage:
  node src/smartFrameExtractor/index.js [video_path] [options]

  If no video path is provided, automatically picks the first video
  from the input folder (default: ./input).

Options:`);

  for (const [name, opt] of Object.entries(CLI_OPTIONS)) {
    const short = opt.short ? `-${opt.short}, ` : '    ';
    const defaultVal = opt.default !== undefined ? ` (default: ${opt.default})` : '';
    console.log(`  ${short}--${name.padEnd(15)} ${opt.description}${defaultVal}`);
  }

  console.log(`
Environment Variables:
  GOOGLE_AI_API_KEY    Required for Gemini frame selection (can be set in .env file)

Pipeline Steps:
  1. Analyze video metadata
  2. Extract frames at specified FPS (default: 10 fps)
  3. Score frames for sharpness and motion
  4. Select best frame per second (reduces 10 fps to 1 candidate/second)
  5. Tournament-style Gemini selection:
     - Process candidates in batches (default 30)
     - Gemini picks best per angle from each batch
     - Track best frame for each product+angle combination
  6. Save final selections to final_frames/

Examples:
  # Auto-detect: picks first video from ./input folder
  node src/smartFrameExtractor/index.js

  # Specify video directly
  node src/smartFrameExtractor/index.js ./product.mp4

  # Higher FPS for more frame options
  node src/smartFrameExtractor/index.js ./product.mp4 --fps 8

  # Larger batch size (faster but may miss some)
  node src/smartFrameExtractor/index.js --batch-size 40

  # Skip Gemini (use evenly spaced frames)
  node src/smartFrameExtractor/index.js --skip-gemini

After extraction, remove backgrounds with:
  npm run commercial -- ./output/<video_name>
`);
}

/**
 * Main pipeline orchestration
 */
async function main() {
  // Parse CLI arguments
  const { values: args, positionals } = parseArgs({
    options: CLI_OPTIONS,
    allowPositionals: true
  });

  // Handle help
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Determine video path: explicit argument or auto-detect from input folder
  let videoPath;

  if (positionals.length > 0) {
    // User provided explicit video path
    videoPath = positionals[0];
  } else {
    // Auto-detect from input folder
    const inputFolder = args.input || DEFAULT_INPUT_FOLDER;
    console.log(`Scanning input folder: ${inputFolder}`);

    videoPath = await findFirstVideo(inputFolder);

    if (!videoPath) {
      console.error(`Error: No video files found in ${inputFolder}`);
      console.error(`Supported formats: ${VIDEO_EXTENSIONS.join(', ')}`);
      console.error('\nEither:');
      console.error('  1. Place a video in the input folder');
      console.error('  2. Specify a video path directly: node index.js ./video.mp4');
      console.error('  3. Use --input to specify a different folder');
      process.exit(1);
    }

    console.log(`Found video: ${path.basename(videoPath)}`);
  }

  // Validate video exists
  if (!existsSync(videoPath)) {
    console.error(`Error: Video file not found: ${videoPath}`);
    process.exit(1);
  }

  // Check ffmpeg
  if (!checkFfmpegInstalled()) {
    console.error('Error: ffmpeg/ffprobe not found. Please install ffmpeg.');
    process.exit(1);
  }

  // Check Gemini API key (unless skipping)
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!args['skip-gemini'] && !apiKey) {
    console.error('Error: GOOGLE_AI_API_KEY environment variable not set.');
    console.error('Set it or use --skip-gemini to skip AI classification.');
    process.exit(1);
  }

  // Parse options
  const config = {
    fps: parseFloat(args.fps),
    batchSize: parseInt(args['batch-size'], 10),
    geminiModel: args['gemini-model'],
    verbose: args.verbose
  };

  // Setup output directories
  const videoName = path.basename(videoPath, path.extname(videoPath));
  const outputBase = path.join(args.output, videoName);
  const tempDir = path.join(outputBase, 'temp_frames');
  const candidatesDir = path.join(outputBase, 'candidates');
  const finalDir = path.join(outputBase, 'final_frames');

  await mkdir(tempDir, { recursive: true });
  await mkdir(candidatesDir, { recursive: true });
  await mkdir(finalDir, { recursive: true });

  console.log('='.repeat(60));
  console.log('Smart Frame Extraction Pipeline');
  console.log('='.repeat(60));
  console.log(`Video: ${videoPath}`);
  console.log(`Output: ${outputBase}`);
  console.log(`Config: fps=${config.fps}, batchSize=${config.batchSize}`);
  const totalSteps = 5;
  console.log('='.repeat(60));

  try {
    // Step 1: Get video metadata
    console.log(`\n[1/${totalSteps}] Analyzing video...`);
    const metadata = await getVideoMetadata(videoPath);
    console.log(`  Duration: ${metadata.duration.toFixed(2)}s`);
    console.log(`  Resolution: ${metadata.width}x${metadata.height}`);
    console.log(`  FPS: ${metadata.fps.toFixed(2)}`);

    // Step 2: Dense frame extraction
    console.log(`\n[2/${totalSteps}] Extracting frames at ${config.fps} fps...`);
    const frames = await extractFramesDense(videoPath, tempDir, { fps: config.fps });
    console.log(`  Extracted ${frames.length} frames`);

    // Step 3: Score frames for sharpness and motion
    console.log(`\n[3/${totalSteps}] Scoring frames...`);
    const scoredFrames = await scoreFrames(frames);
    console.log(`  Scored ${scoredFrames.length} frames`);

    // Step 4: Select best frame per second and save
    console.log(`\n[4/${totalSteps}] Selecting best frame per second...`);
    const candidateFrames = selectBestFramePerSecond(scoredFrames, config.fps);

    // Copy candidate frames for inspection
    const { copyFile } = await import('fs/promises');
    for (const frame of candidateFrames) {
      const destPath = path.join(candidatesDir, frame.filename);
      await copyFile(frame.path, destPath);
    }
    console.log(`  Saved ${candidateFrames.length} candidate frames to: ${candidatesDir}`);

    // Gemini classification
    let geminiResult = null;
    let recommendedFrames = [];

    if (!args['skip-gemini']) {
      console.log(`\n[5/${totalSteps}] AI variant discovery with Gemini...`);

      const genAI = initGemini(apiKey);
      const BATCH_SIZE = config.batchSize;

      // Track best frame per product+variant combination
      // Key: "product_1_variant_1", Value: { frame, score, description }
      const bestByVariant = new Map();

      // Process candidate frames in batches
      const batches = [];
      for (let i = 0; i < candidateFrames.length; i += BATCH_SIZE) {
        batches.push(candidateFrames.slice(i, i + BATCH_SIZE));
      }

      console.log(`  Processing ${candidateFrames.length} candidate frames in ${batches.length} batches...`);

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        console.log(`\n  Batch ${batchIdx + 1}/${batches.length}: frames ${batchIdx * BATCH_SIZE + 1}-${batchIdx * BATCH_SIZE + batch.length}`);

        const batchMetadata = batch.map((f, idx) => ({
          frame_id: f.frameId,
          timestamp_sec: Math.round(f.timestamp * 100) / 100,
          sequence_position: idx + 1,
          total_candidates: batch.length
        }));

        try {
          const batchResult = await classifyFramesWithGemini(
            genAI,
            batch,
            batchMetadata,
            metadata,
            { model: config.geminiModel }
          );

          const batchWinners = getRecommendedFrames(batchResult, batch);
          console.log(`    Gemini discovered ${batchWinners.length} variants`);

          // Update best frame for each variant
          for (const winner of batchWinners) {
            const key = `${winner.productId}_${winner.variantId}`;
            const score = winner.geminiScore || 50;

            const existing = bestByVariant.get(key);
            if (!existing || score > existing.score) {
              bestByVariant.set(key, {
                frame: winner,
                score: score,
                description: winner.variantDescription || winner.angleEstimate
              });
              if (existing) {
                console.log(`    Updated ${key}: ${winner.frameId} (score ${score} > ${existing.score})`);
              } else {
                console.log(`    Found ${key} (${winner.angleEstimate}): ${winner.frameId}`);
              }
            }
          }
        } catch (error) {
          console.error(`    Batch ${batchIdx + 1} failed: ${error.message}`);
        }

        // Small delay between batches
        if (batchIdx < batches.length - 1) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Collect best frames from all variants
      recommendedFrames = [];
      console.log(`\n  Best frame per variant:`);

      for (const [key, data] of bestByVariant) {
        console.log(`    ${key} (${data.description}): ${data.frame.frameId} (t=${data.frame.timestamp.toFixed(2)}s)`);
        recommendedFrames.push(data.frame);
      }

      console.log(`\n  Total: ${recommendedFrames.length} unique variants discovered`);

      // Save results with variant and obstruction metadata
      geminiResult = {
        products_detected: [...new Set(recommendedFrames.map(f => f.productId))].map(id => ({
          product_id: id,
          description: 'Detected product'
        })),
        variants_discovered: [...bestByVariant.entries()].map(([key, data]) => ({
          key,
          variant_id: data.frame.variantId,
          product_id: data.frame.productId,
          angle_estimate: data.frame.angleEstimate,
          description: data.description,
          frame_id: data.frame.frameId,
          timestamp: data.frame.timestamp,
          score: data.score,
          obstructions: data.frame.obstructions || null,
          background_recommendations: data.frame.backgroundRecommendations || null
        })),
        total_frames_analyzed: candidateFrames.length,
        batches_processed: batches.length
      };

      const geminiPath = path.join(outputBase, 'gemini_result.json');
      await writeFile(geminiPath, JSON.stringify(geminiResult, null, 2));

      // Save separate frames metadata for commercial step
      const framesMetadata = recommendedFrames.map(f => ({
        frame_id: f.frameId,
        filename: `${f.recommendedType}_${f.frameId}_t${f.timestamp.toFixed(2)}.png`,
        product_id: f.productId,
        variant_id: f.variantId,
        angle_estimate: f.angleEstimate,
        description: f.variantDescription,
        timestamp: f.timestamp,
        score: f.geminiScore,
        obstructions: f.obstructions || {
          has_obstruction: false,
          obstruction_types: [],
          obstruction_description: null,
          removable_by_ai: true
        },
        backgroundRecommendations: f.backgroundRecommendations || {
          solid_color: '#FFFFFF',
          solid_color_name: 'white',
          real_life_setting: 'on a clean white surface with soft natural lighting',
          creative_shot: 'floating with soft shadow on a light gradient background'
        }
      }));

      const framesMetadataPath = path.join(outputBase, 'frames_metadata.json');
      await writeFile(framesMetadataPath, JSON.stringify(framesMetadata, null, 2));
      console.log(`  Saved frames metadata to: ${framesMetadataPath}`);
    } else {
      console.log(`\n[5/${totalSteps}] Skipping Gemini (--skip-gemini)`);
      // Use evenly spaced candidate frames as variants
      const numVariants = Math.min(8, candidateFrames.length);
      const step = Math.floor(candidateFrames.length / numVariants);
      recommendedFrames = [];
      for (let i = 0; i < numVariants; i++) {
        const frameIdx = Math.min(i * step, candidateFrames.length - 1);
        const f = candidateFrames[frameIdx];
        recommendedFrames.push({
          ...f,
          productId: 'product_1',
          variantId: `variant_${i + 1}`,
          angleEstimate: 'unknown',
          recommendedType: `product_1_variant_${i + 1}`,
          variantDescription: 'Evenly spaced frame (no AI classification)'
        });
      }
    }

    // Copy final recommended frames to final_frames directory
    // Deduplicate by frameId (same frame may be recommended for multiple angles)
    const seenFrameIds = new Set();
    const uniqueFrames = [];

    for (const frame of recommendedFrames) {
      if (!seenFrameIds.has(frame.frameId)) {
        seenFrameIds.add(frame.frameId);
        uniqueFrames.push(frame);
      }
    }

    console.log(`\n  Saving ${uniqueFrames.length} unique frames (deduplicated from ${recommendedFrames.length})...`);

    for (const frame of uniqueFrames) {
      const outputFilename = `${frame.recommendedType}_${frame.frameId}_t${frame.timestamp.toFixed(2)}.png`;
      const outputPath = path.join(finalDir, outputFilename);

      // Copy from temp directory
      await copyFile(frame.path, outputPath);
      console.log(`    ${outputFilename}`);
    }

    // Cleanup temp files
    if (!args['keep-temp']) {
      await rm(tempDir, { recursive: true, force: true });
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('PIPELINE COMPLETE');
    console.log('='.repeat(60));
    console.log(`Final frames: ${finalDir}`);
    console.log(`All extracted: ${candidatesDir}`);
    if (geminiResult) {
      console.log(`Gemini result: ${path.join(outputBase, 'gemini_result.json')}`);

      // Show products detected
      if (geminiResult.products_detected) {
        console.log(`Products detected: ${geminiResult.products_detected.length}`);
        for (const p of geminiResult.products_detected) {
          console.log(`  - ${p.product_id}: ${p.description}`);
        }
      }

      // Show variants discovered
      if (geminiResult.variants_discovered) {
        console.log(`Variants discovered: ${geminiResult.variants_discovered.length}`);
        for (const v of geminiResult.variants_discovered) {
          const obsInfo = v.obstructions?.has_obstruction ? ` [${v.obstructions.obstruction_types.join(', ')}]` : '';
          console.log(`  - ${v.variant_id} (${v.angle_estimate}): ${v.description}${obsInfo}`);
        }
      }
    }
    console.log('\nNext step: npm run commercial -- ' + outputBase);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\nPipeline failed:', error.message);
    if (config.verbose) {
      console.error(error.stack);
    }

    // Cleanup on failure
    if (!args['keep-temp']) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    process.exit(1);
  }
}

// Run if executed directly
main().catch(console.error);

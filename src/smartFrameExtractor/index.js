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
  runSmartFramePipeline,
  computeSharpness,
  DEFAULT_CONFIG
} from './smartFrames.js';

import {
  initGemini,
  classifyFramesWithGemini,
  getRecommendedFrames
} from './gemini.js';

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
    default: '5',
    description: 'Frames per second to extract (default: 5)'
  },
  'top-k': {
    type: 'string',
    short: 'k',
    default: '24',
    description: 'Number of candidate frames to select (default: 24)'
  },
  'alpha': {
    type: 'string',
    short: 'a',
    default: '0.5',
    description: 'Motion penalty weight (default: 0.5)'
  },
  'min-gap': {
    type: 'string',
    short: 'g',
    default: '0.5',
    description: 'Minimum seconds between selected frames (default: 0.5)'
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
    description: 'Skip Gemini classification (scoring only)'
  },
  'keep-temp': {
    type: 'boolean',
    default: false,
    description: 'Keep temporary extracted frames'
  },
  'search-window': {
    type: 'string',
    short: 'w',
    default: '0.2',
    description: 'Search window (±seconds) for final frame extraction (default: 0.2)'
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
  GOOGLE_AI_API_KEY    Required for Gemini classification (can be set in .env file)

Examples:
  # Auto-detect: picks first video from ./input folder
  node src/smartFrameExtractor/index.js

  # Specify video directly
  node src/smartFrameExtractor/index.js ./product.mp4

  # Use custom input folder
  node src/smartFrameExtractor/index.js --input ./my_videos

  # Custom settings
  node src/smartFrameExtractor/index.js ./product.mp4 --fps 8 --top-k 20

  # Scoring only (no Gemini)
  node src/smartFrameExtractor/index.js --skip-gemini
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

  // Parse numeric options
  const config = {
    fps: parseFloat(args.fps),
    topK: parseInt(args['top-k'], 10),
    alpha: parseFloat(args.alpha),
    minTemporalGap: parseFloat(args['min-gap']),
    searchWindow: parseFloat(args['search-window']),
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
  console.log(`Config: fps=${config.fps}, topK=${config.topK}, alpha=${config.alpha}`);
  console.log('='.repeat(60));

  try {
    // Step 1: Get video metadata
    console.log('\n[1/6] Analyzing video...');
    const metadata = await getVideoMetadata(videoPath);
    console.log(`  Duration: ${metadata.duration.toFixed(2)}s`);
    console.log(`  Resolution: ${metadata.width}x${metadata.height}`);
    console.log(`  FPS: ${metadata.fps.toFixed(2)}`);

    // Step 2: Dense frame extraction
    console.log('\n[2/6] Extracting frames...');
    const frames = await extractFramesDense(videoPath, tempDir, { fps: config.fps });
    console.log(`  Extracted ${frames.length} frames`);

    // Step 3: Score and select candidates
    console.log('\n[3/6] Scoring frames...');
    const pipelineResult = await runSmartFramePipeline(videoPath, metadata, frames, config);

    const { candidates, candidateMetadata } = pipelineResult;
    console.log(`  Selected ${candidates.length} candidate frames`);

    // Copy candidates for inspection
    console.log('\n[4/6] Saving candidate frames...');
    const { copyFile } = await import('fs/promises');
    for (const candidate of candidates) {
      const destPath = path.join(candidatesDir, candidate.filename);
      await copyFile(candidate.path, destPath);
    }
    console.log(`  Saved to: ${candidatesDir}`);

    // Step 4: Gemini classification (optional)
    let geminiResult = null;
    let recommendedFrames = [];

    if (!args['skip-gemini']) {
      console.log('\n[5/6] AI classification with Gemini...');
      const genAI = initGemini(apiKey);
      geminiResult = await classifyFramesWithGemini(
        genAI,
        candidates,
        candidateMetadata,
        metadata,
        { model: config.geminiModel }
      );
      recommendedFrames = getRecommendedFrames(geminiResult, candidates);
      console.log(`  Recommended ${recommendedFrames.length} frames`);

      // Print recommendations
      console.log('\n  Recommendations:');
      for (const frame of recommendedFrames) {
        console.log(`    ${frame.recommendedType.toUpperCase()}: ${frame.frameId} (t=${frame.timestamp.toFixed(2)}s)`);
        console.log(`      Reason: ${frame.geminiReason}`);
      }

      // Save Gemini result
      const geminiPath = path.join(outputBase, 'gemini_result.json');
      await writeFile(geminiPath, JSON.stringify(geminiResult, null, 2));
    } else {
      console.log('\n[5/6] Skipping Gemini classification (--skip-gemini)');
      // Use top candidates as "recommended" (assume single product)
      const defaultAngles = ['hero', 'front', 'back', 'left', 'right', 'top', 'detail', 'context'];
      recommendedFrames = candidates.slice(0, defaultAngles.length).map((c, i) => ({
        ...c,
        productId: 'product_1',
        angle: defaultAngles[i],
        recommendedType: `product_1_${defaultAngles[i]}`,
        geminiReason: 'Top scoring frame (no AI classification)'
      }));
    }

    // Step 5: Extract final frames
    console.log('\n[6/6] Extracting final high-quality frames...');

    // Sharpness function for window search
    const sharpnessScore = async (imgPath) => computeSharpness(imgPath);

    for (const frame of recommendedFrames) {
      const outputFilename = `${frame.recommendedType}_${frame.frameId}_t${frame.timestamp.toFixed(2)}.png`;
      const outputPath = path.join(finalDir, outputFilename);

      if (config.searchWindow > 0) {
        // Use window search for optimal frame
        const result = await extractBestFrameInWindow(
          videoPath,
          frame.timestamp,
          outputPath,
          sharpnessScore,
          { windowSize: config.searchWindow, sampleCount: 5 }
        );
        console.log(`  ${frame.recommendedType}: ${outputFilename} (optimized t=${result.timestamp.toFixed(2)}s)`);
      } else {
        // Direct extraction
        await extractSingleFrame(videoPath, frame.timestamp, outputPath);
        console.log(`  ${frame.recommendedType}: ${outputFilename}`);
      }
    }

    // Save quality report
    const reportPath = path.join(outputBase, 'quality_report.json');
    await writeFile(reportPath, JSON.stringify(pipelineResult.qualityReport, null, 2));

    // Save frame scores for debugging
    if (config.verbose) {
      const scoresPath = path.join(outputBase, 'frame_scores.json');
      const scores = pipelineResult.scoredFrames.map(f => ({
        frameId: f.frameId,
        timestamp: f.timestamp,
        sharpness: Math.round(f.sharpness * 100) / 100,
        motion: Math.round(f.motion * 1000) / 1000,
        score: Math.round(f.score * 100) / 100
      }));
      await writeFile(scoresPath, JSON.stringify(scores, null, 2));
      console.log(`  Frame scores saved to: ${scoresPath}`);
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
    console.log(`Candidates: ${candidatesDir}`);
    console.log(`Quality report: ${reportPath}`);
    if (geminiResult) {
      console.log(`Gemini result: ${path.join(outputBase, 'gemini_result.json')}`);

      // Show products detected
      if (geminiResult.products_detected) {
        console.log(`Products detected: ${geminiResult.products_detected.length}`);
        for (const p of geminiResult.products_detected) {
          console.log(`  - ${p.product_id}: ${p.description}`);
        }
      }

      // Show coverage summary
      if (geminiResult.coverage_by_product) {
        console.log('Coverage by product:');
        for (const cov of geminiResult.coverage_by_product) {
          const found = cov.angles_found?.length || 0;
          const missing = cov.angles_missing?.length || 0;
          console.log(`  - ${cov.product_id}: ${found} angles found, ${missing} missing`);
        }
      }
    }
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

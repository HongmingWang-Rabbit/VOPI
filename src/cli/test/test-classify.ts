import { input, number, confirm } from '@inquirer/prompts';

import { videoService } from '../../services/video.service.js';
import { frameScoringService } from '../../services/frame-scoring.service.js';
import { geminiService, type RecommendedFrame } from '../../services/gemini.service.js';
import { getConfig } from '../../config/index.js';
import {
  printHeader,
  printStep,
  printSuccess,
  printError,
  printInfo,
  printWarn,
  printLabel,
  printDivider,
  printJson,
  printRaw,
  Timer,
  isValidDirectory,
  isValidFile,
  parseFramesFromDirectory,
} from './utils.js';

/**
 * Test the Classify step of the pipeline
 * Sends frames to Gemini for AI classification
 */
export async function testClassify(): Promise<{
  success: boolean;
  recommendedFrames?: RecommendedFrame[];
}> {
  printHeader('Test Classify Step (Gemini)');

  // Check API key
  let config;
  try {
    config = getConfig();
  } catch {
    printError('Failed to load configuration. Make sure .env file exists.');
    return { success: false };
  }

  if (!config.apis.googleAi) {
    printError('GOOGLE_AI_API_KEY not configured');
    printInfo('Please set GOOGLE_AI_API_KEY in your .env file');
    return { success: false };
  }

  printSuccess('Gemini API key found');
  printLabel('  Model', 'gemini-3-flash-preview (default)');
  printDivider();

  // Get frames directory from user
  const framesDir = await input({
    message: 'Enter path to frames directory:',
    validate: async (value) => {
      if (!value.trim()) return 'Frames directory is required';
      const isDir = await isValidDirectory(value);
      if (!isDir) return 'Directory not found or not accessible';
      return true;
    },
  });

  // Get video path for metadata
  const videoPath = await input({
    message: 'Enter path to original video (for metadata):',
    validate: async (value) => {
      if (!value.trim()) return 'Video path is required for Gemini';
      const isFile = await isValidFile(value);
      if (!isFile) return 'File not found or not accessible';
      return true;
    },
  });

  // Get number of candidates to send
  const maxCandidates = await number({
    message: 'Max candidates to send to Gemini (1-30):',
    default: 24,
    validate: (value) => {
      if (value === undefined) return 'Max candidates is required';
      if (value < 1 || value > 30) return 'Must be between 1 and 30';
      return true;
    },
  }) as number;

  printDivider();
  printInfo('Classification Configuration:');
  printLabel('  Frames Dir', framesDir);
  printLabel('  Video Path', videoPath);
  printLabel('  Max Candidates', maxCandidates);
  printLabel('  Model', 'gemini-3-flash-preview');
  printDivider();

  const timer = new Timer();

  try {
    // Load and score frames
    printStep(1, 'Loading and scoring frames...');
    const frames = await parseFramesFromDirectory(framesDir);
    printSuccess(`Loaded ${frames.length} frames`);

    // Score frames
    printStep(2, 'Scoring frames for candidate selection...');
    const scoredFrames = await frameScoringService.scoreFrames(frames, {});
    const { candidates } = frameScoringService.selectCandidates(scoredFrames, {
      topK: maxCandidates,
    });

    printSuccess(`Selected ${candidates.length} candidates`);

    // Get video metadata
    printStep(3, 'Getting video metadata...');
    const metadata = await videoService.getMetadata(videoPath);
    printSuccess('Video metadata loaded');
    printLabel('  Duration', `${metadata.duration.toFixed(2)}s`);
    printLabel('  Resolution', `${metadata.width}x${metadata.height}`);

    // Initialize Gemini
    printStep(4, 'Initializing Gemini service...');
    geminiService.init();
    printSuccess('Gemini service initialized');

    // Prepare candidate metadata
    const candidateMetadata = frameScoringService.prepareCandidateMetadata(candidates);

    // Confirm before making API call
    printDivider();
    printWarn(`This will send ${candidates.length} images to Gemini API`);
    const proceed = await confirm({
      message: 'Proceed with classification?',
      default: true,
    });

    if (!proceed) {
      printInfo('Classification cancelled');
      return { success: false };
    }

    // Call Gemini
    printStep(5, 'Sending frames to Gemini (this may take a while)...');
    const geminiTimer = new Timer();
    const geminiResult = await geminiService.classifyFrames(
      candidates,
      candidateMetadata,
      metadata,
      { maxRetries: 3 }
    );

    printSuccess(`Gemini responded in ${geminiTimer.elapsedFormatted()}`);

    // Show raw Gemini response summary
    printDivider();
    printInfo('Gemini Response Summary:');
    printLabel('  Products Detected', geminiResult.products_detected?.length || 0);
    printLabel('  Frames Evaluated', geminiResult.frame_evaluation?.length || 0);
    printLabel('  Variants Discovered', geminiResult.variants_discovered?.length || 0);

    // Extract recommended frames
    printStep(6, 'Extracting recommended frames...');
    const recommendedFrames = geminiService.getRecommendedFrames(geminiResult, candidates);

    printSuccess(`Got ${recommendedFrames.length} recommended frames`);

    // Show recommended frames
    printDivider();
    printInfo('Recommended Frames:');
    for (const frame of recommendedFrames) {
      printRaw(`\n  ${frame.recommendedType}:`);
      printRaw(`    Frame: ${frame.frameId} (t=${frame.timestamp.toFixed(2)}s)`);
      printRaw(`    Angle: ${frame.angleEstimate}`);
      printRaw(`    Gemini Score: ${frame.geminiScore}`);
      if (frame.variantDescription) {
        printRaw(`    Description: ${frame.variantDescription}`);
      }
      if (frame.obstructions?.has_obstruction) {
        printRaw(`    Obstructions: ${frame.obstructions.obstruction_types.join(', ')}`);
      }
    }

    const elapsed = timer.elapsedFormatted();
    printDivider();
    printSuccess(`Classification completed in ${elapsed}`);

    // Show full response option
    const showFullResponse = await confirm({
      message: 'Show full Gemini response?',
      default: false,
    });

    if (showFullResponse) {
      printDivider();
      printInfo('Full Gemini Response:');
      printJson(geminiResult);
    }

    return {
      success: true,
      recommendedFrames,
    };
  } catch (error) {
    printError(`Classification failed: ${(error as Error).message}`);
    return { success: false };
  }
}

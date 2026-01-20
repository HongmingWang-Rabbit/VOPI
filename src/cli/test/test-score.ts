import { input, number, confirm } from '@inquirer/prompts';

import { videoService } from '../../services/video.service.js';
import { frameScoringService, type ScoredFrame } from '../../services/frame-scoring.service.js';
import {
  printHeader,
  printStep,
  printSuccess,
  printError,
  printInfo,
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
 * Test the Score step of the pipeline
 * Scores frames based on sharpness and motion
 */
export async function testScore(): Promise<{
  success: boolean;
  scoredFrames?: ScoredFrame[];
  candidates?: ScoredFrame[];
  videoPath?: string;
}> {
  printHeader('Test Score Step');

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

  // Get video path (optional, for quality report)
  const videoPath = await input({
    message: 'Enter path to original video (optional, for quality report):',
    default: '',
  });

  // Get scoring parameters
  const alpha = await number({
    message: 'Motion penalty (alpha, 0-1):',
    default: 0.2,
    validate: (value) => {
      if (value === undefined) return 'Alpha is required';
      if (value < 0 || value > 1) return 'Alpha must be between 0 and 1';
      return true;
    },
  }) as number;

  const topK = await number({
    message: 'Number of candidates to select (topK):',
    default: 24,
    validate: (value) => {
      if (value === undefined) return 'TopK is required';
      if (value < 1) return 'TopK must be at least 1';
      return true;
    },
  }) as number;

  const minTemporalGap = await number({
    message: 'Minimum temporal gap between candidates (seconds):',
    default: 0.3,
    validate: (value) => {
      if (value === undefined) return 'Min gap is required';
      if (value < 0) return 'Min gap must be non-negative';
      return true;
    },
  }) as number;

  printDivider();
  printInfo('Scoring Configuration:');
  printLabel('  Frames Dir', framesDir);
  printLabel('  Alpha', alpha);
  printLabel('  TopK', topK);
  printLabel('  Min Gap', `${minTemporalGap}s`);
  printDivider();

  const timer = new Timer();

  try {
    // Load frames from directory
    printStep(1, 'Loading frames from directory...');
    const frames = await parseFramesFromDirectory(framesDir);
    printSuccess(`Loaded ${frames.length} frames`);

    // Score frames
    printStep(2, 'Scoring frames (this may take a while)...');
    let lastProgress = 0;
    const scoredFrames = await frameScoringService.scoreFrames(
      frames,
      { alpha, topK, minTemporalGap },
      (current, total) => {
        const progress = Math.floor((current / total) * 100);
        if (progress >= lastProgress + 10) {
          printInfo(`  Progress: ${progress}% (${current}/${total})`);
          lastProgress = progress;
        }
      }
    );

    printSuccess(`Scored ${scoredFrames.length} frames`);

    // Guard against empty results
    if (scoredFrames.length === 0) {
      throw new Error('No frames were scored');
    }

    // Show score statistics
    const sharpnessValues = scoredFrames.map((f) => f.sharpness);
    const motionValues = scoredFrames.map((f) => f.motion);
    const scoreValues = scoredFrames.map((f) => f.score);

    const avgSharpness = sharpnessValues.reduce((a, b) => a + b, 0) / sharpnessValues.length;
    const avgMotion = motionValues.reduce((a, b) => a + b, 0) / motionValues.length;
    const avgScore = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;

    printDivider();
    printInfo('Score Statistics:');
    printLabel('  Sharpness (avg)', avgSharpness.toFixed(2));
    printLabel('  Sharpness (max)', Math.max(...sharpnessValues).toFixed(2));
    printLabel('  Motion (avg)', avgMotion.toFixed(4));
    printLabel('  Combined (avg)', avgScore.toFixed(2));
    printLabel('  Combined (max)', Math.max(...scoreValues).toFixed(2));

    // Select candidates
    printStep(3, 'Selecting top candidates...');
    const { candidates } = frameScoringService.selectCandidates(scoredFrames, {
      topK,
      minTemporalGap,
    });

    printSuccess(`Selected ${candidates.length} candidates`);

    // Show top candidates
    printDivider();
    printInfo('Top 5 Candidates:');
    const topCandidates = candidates.slice(0, 5);
    for (const frame of topCandidates) {
      printRaw(
        `  ${frame.frameId}: score=${frame.score.toFixed(2)}, sharpness=${frame.sharpness.toFixed(2)}, motion=${frame.motion.toFixed(4)}, t=${frame.timestamp.toFixed(2)}s`
      );
    }

    // Generate quality report if video path provided
    if (videoPath && (await isValidFile(videoPath))) {
      printStep(4, 'Generating quality report...');
      const metadata = await videoService.getMetadata(videoPath);
      const report = frameScoringService.generateQualityReport(scoredFrames, metadata);

      printDivider();
      printInfo('Quality Report:');
      printJson(report);
    }

    const elapsed = timer.elapsedFormatted();
    printDivider();
    printSuccess(`Scoring completed in ${elapsed}`);

    // Show options
    const showAllCandidates = await confirm({
      message: 'Show all candidate frames?',
      default: false,
    });

    if (showAllCandidates) {
      printDivider();
      printInfo('All Candidates:');
      for (const frame of candidates) {
        printRaw(
          `  ${frame.frameId}: score=${frame.score.toFixed(2)}, t=${frame.timestamp.toFixed(2)}s, path=${frame.path}`
        );
      }
    }

    return {
      success: true,
      scoredFrames,
      candidates,
      videoPath: videoPath || undefined,
    };
  } catch (error) {
    printError(`Scoring failed: ${(error as Error).message}`);
    return { success: false };
  }
}

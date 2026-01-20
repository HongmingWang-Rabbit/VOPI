import { input, number, confirm } from '@inquirer/prompts';
import path from 'path';

import { videoService, type ExtractedFrame } from '../../services/video.service.js';
import {
  printHeader,
  printStep,
  printSuccess,
  printError,
  printInfo,
  printLabel,
  printDivider,
  createTempDir,
  cleanupTempDir,
  formatDuration,
  listFilesWithSizes,
  formatFileSize,
  Timer,
  isValidFile,
} from './utils.js';

/**
 * Test the Extract step of the pipeline
 * Extracts frames from a video at specified FPS
 */
export async function testExtract(): Promise<{
  success: boolean;
  frames?: ExtractedFrame[];
  outputDir?: string;
  tempDir?: string;
  videoPath?: string;
}> {
  printHeader('Test Extract Step');

  // Check FFmpeg availability first
  printStep(1, 'Checking FFmpeg installation...');
  const ffmpegCheck = await videoService.checkFfmpegInstalled();

  if (!ffmpegCheck.available) {
    printError(`FFmpeg not available: ${ffmpegCheck.error}`);
    printInfo('Please install FFmpeg and ensure it is in your PATH');
    return { success: false };
  }

  printSuccess(`FFmpeg ${ffmpegCheck.ffmpegVersion} detected`);
  printSuccess(`FFprobe ${ffmpegCheck.ffprobeVersion} detected`);
  printDivider();

  // Get input video path from user
  const videoPath = await input({
    message: 'Enter path to video file:',
    validate: async (value) => {
      if (!value.trim()) return 'Video path is required';
      const isFile = await isValidFile(value);
      if (!isFile) return 'File not found or not accessible';
      return true;
    },
  });

  // Get FPS
  const fps = await number({
    message: 'Frames per second to extract (1-30):',
    default: 5,
    validate: (value) => {
      if (value === undefined) return 'FPS is required';
      if (value < 1 || value > 30) return 'FPS must be between 1 and 30';
      return true;
    },
  }) as number;

  // Get quality
  const quality = await number({
    message: 'Quality (1=best, 31=worst):',
    default: 2,
    validate: (value) => {
      if (value === undefined) return 'Quality is required';
      if (value < 1 || value > 31) return 'Quality must be between 1 and 31';
      return true;
    },
  }) as number;

  // Create temp directory
  const tempDir = await createTempDir('vopi-extract');
  const framesDir = path.join(tempDir, 'frames');

  printDivider();
  printInfo('Extraction Configuration:');
  printLabel('  Video', videoPath);
  printLabel('  FPS', fps);
  printLabel('  Quality', quality);
  printLabel('  Output Dir', framesDir);
  printDivider();

  const timer = new Timer();

  try {
    // Get video metadata
    printStep(2, 'Reading video metadata...');
    const metadata = await videoService.getMetadata(videoPath);

    printSuccess('Video metadata loaded');
    printLabel('  Duration', formatDuration(metadata.duration));
    printLabel('  Resolution', `${metadata.width}x${metadata.height}`);
    printLabel('  FPS', metadata.fps.toFixed(2));
    printLabel('  Codec', metadata.codec);
    printDivider();

    // Calculate expected frames
    const expectedFrames = Math.floor(metadata.duration * fps);
    printInfo(`Expected to extract ~${expectedFrames} frames`);

    // Extract frames
    printStep(3, 'Extracting frames...');
    const frames = await videoService.extractFramesDense(videoPath, framesDir, {
      fps,
      quality,
    });

    const elapsed = timer.elapsedFormatted();

    printSuccess(`Extraction completed in ${elapsed}`);
    printLabel('  Frames extracted', frames.length);
    printDivider();

    // Show sample of extracted frames
    printInfo('Sample of extracted frames:');
    const sampleFrames = frames.slice(0, 5);
    for (const frame of sampleFrames) {
      printLabel(`  ${frame.frameId}`, `t=${frame.timestamp.toFixed(2)}s`);
    }
    if (frames.length > 5) {
      printInfo(`  ... and ${frames.length - 5} more frames`);
    }

    // Show directory contents
    const files = await listFilesWithSizes(framesDir);
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    printLabel('  Total size', formatFileSize(totalSize));
    printDivider();

    // Ask if user wants to keep the files
    const keepFiles = await confirm({
      message: 'Keep the extracted frames for further testing?',
      default: true,
    });

    if (!keepFiles) {
      await cleanupTempDir(tempDir);
      printInfo('Temp directory cleaned up');
      return { success: true };
    }

    printSuccess(`Frames saved at: ${framesDir}`);
    printInfo('Remember to clean up the temp directory when done.');

    return {
      success: true,
      frames,
      outputDir: framesDir,
      tempDir,
      videoPath,
    };
  } catch (error) {
    printError(`Extraction failed: ${(error as Error).message}`);
    await cleanupTempDir(tempDir);
    return { success: false };
  }
}

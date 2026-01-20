import { input, confirm } from '@inquirer/prompts';
import { stat } from 'fs/promises';
import path from 'path';

import { storageService } from '../../services/storage.service.js';
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
  formatFileSize,
  Timer,
  isValidFile,
  safeParseFilenameFromUrl,
} from './utils.js';

/**
 * Test the Download step of the pipeline
 * Downloads a video from a URL (HTTP/HTTPS or S3)
 */
export async function testDownload(): Promise<{ success: boolean; outputPath?: string; tempDir?: string }> {
  printHeader('Test Download Step');

  // Get input URL from user
  const url = await input({
    message: 'Enter video URL (HTTP/HTTPS or S3):',
    validate: (value) => {
      if (!value.trim()) return 'URL is required';
      if (!value.startsWith('http://') && !value.startsWith('https://') && !value.startsWith('s3://')) {
        return 'URL must start with http://, https://, or s3://';
      }
      return true;
    },
  });

  // Create temp directory
  const tempDir = await createTempDir('vopi-download');
  const outputFilename = safeParseFilenameFromUrl(url);
  const outputPath = path.join(tempDir, outputFilename);

  printDivider();
  printInfo('Download Configuration:');
  printLabel('  Source URL', url);
  printLabel('  Output Path', outputPath);
  printDivider();

  const timer = new Timer();

  try {
    // Initialize storage service
    printStep(1, 'Initializing storage service...');
    storageService.init();
    printSuccess('Storage service initialized');

    // Download the file
    printStep(2, 'Downloading video...');
    await storageService.downloadFromUrl(url, outputPath);

    const elapsed = timer.elapsedFormatted();

    // Verify file exists
    const fileExists = await isValidFile(outputPath);
    if (!fileExists) {
      throw new Error('Downloaded file not found');
    }

    // Get file size
    const stats = await stat(outputPath);

    printSuccess(`Download completed in ${elapsed}`);
    printDivider();
    printInfo('Download Results:');
    printLabel('  File', outputFilename);
    printLabel('  Size', formatFileSize(stats.size));
    printLabel('  Location', outputPath);
    printDivider();

    // Ask if user wants to keep the file
    const keepFile = await confirm({
      message: 'Keep the downloaded file for further testing?',
      default: true,
    });

    if (!keepFile) {
      await cleanupTempDir(tempDir);
      printInfo('Temp directory cleaned up');
      return { success: true };
    }

    printSuccess(`File saved at: ${outputPath}`);
    printInfo('Remember to clean up the temp directory when done.');

    return { success: true, outputPath, tempDir };
  } catch (error) {
    printError(`Download failed: ${(error as Error).message}`);
    await cleanupTempDir(tempDir);
    return { success: false };
  }
}

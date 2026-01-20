import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import { mkdir, rm, readdir, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

import type { ExtractedFrame } from '../../services/video.service.js';

/**
 * CLI Test Utilities
 */

/** Width of divider lines and headers */
const LINE_WIDTH = 60;

/** Default presigned URL expiration in seconds (1 hour) */
export const PRESIGN_EXPIRATION_SECONDS = 3600;

// Styling helpers
export const styles = {
  header: (text: string) => chalk.bold.cyan(`\n${'═'.repeat(LINE_WIDTH)}\n  ${text}\n${'═'.repeat(LINE_WIDTH)}\n`),
  success: (text: string) => chalk.green(`✓ ${text}`),
  error: (text: string) => chalk.red(`✗ ${text}`),
  info: (text: string) => chalk.blue(`ℹ ${text}`),
  warn: (text: string) => chalk.yellow(`⚠ ${text}`),
  dim: (text: string) => chalk.dim(text),
  label: (label: string, value: string) => `${chalk.gray(label + ':')} ${chalk.white(value)}`,
  step: (num: number, text: string) => chalk.cyan(`[${num}] ${text}`),
};

/**
 * Print a formatted header
 */
export function printHeader(title: string): void {
  console.log(styles.header(title));
}

/**
 * Print step progress
 */
export function printStep(step: number, message: string): void {
  console.log(styles.step(step, message));
}

/**
 * Print success message
 */
export function printSuccess(message: string): void {
  console.log(styles.success(message));
}

/**
 * Print error message
 */
export function printError(message: string): void {
  console.log(styles.error(message));
}

/**
 * Print info message
 */
export function printInfo(message: string): void {
  console.log(styles.info(message));
}

/**
 * Print warning message
 */
export function printWarn(message: string): void {
  console.log(styles.warn(message));
}

/**
 * Print a key-value pair
 */
export function printLabel(label: string, value: string | number): void {
  console.log(styles.label(label, String(value)));
}

/**
 * Print a divider line
 */
export function printDivider(): void {
  console.log(chalk.gray('─'.repeat(LINE_WIDTH)));
}

/**
 * Print raw text without formatting
 */
export function printRaw(text: string): void {
  console.log(text);
}

/**
 * Print JSON data with syntax highlighting
 */
export function printJson(data: unknown, indent = 2): void {
  const json = JSON.stringify(data, null, indent);
  console.log(chalk.gray(json));
}

/**
 * Format file size in human readable format
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Format duration in human readable format
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

/**
 * Create a temporary directory for testing
 */
export async function createTempDir(prefix = 'vopi-test'): Promise<string> {
  const tempBase = os.tmpdir();
  const timestamp = Date.now();
  const tempDir = path.join(tempBase, `${prefix}-${timestamp}`);
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up a temporary directory
 */
export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * List files in a directory with their sizes
 */
export async function listFilesWithSizes(dir: string): Promise<Array<{ name: string; size: number; path: string }>> {
  const files = await readdir(dir);
  const results: Array<{ name: string; size: number; path: string }> = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stats = await stat(filePath);
    if (stats.isFile()) {
      results.push({
        name: file,
        size: stats.size,
        path: filePath,
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Wait for user to press enter
 */
export async function waitForEnter(message = 'Press Enter to continue...'): Promise<void> {
  await input({ message, default: '' });
}

/**
 * Timer utility for measuring operations
 */
export class Timer {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  elapsed(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  elapsedFormatted(): string {
    return formatDuration(this.elapsed());
  }

  reset(): void {
    this.startTime = Date.now();
  }
}

/**
 * Check if a path is a valid file
 */
export async function isValidFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a path is a valid directory
 */
export async function isValidDirectory(dirPath: string): Promise<boolean> {
  try {
    const stats = await stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse frame files from a directory into ExtractedFrame objects
 * @param framesDir - Directory containing frame_*.png files
 * @returns Array of ExtractedFrame objects sorted by index
 * @throws Error if no frame files are found
 */
export async function parseFramesFromDirectory(framesDir: string): Promise<ExtractedFrame[]> {
  const files = await readdir(framesDir);
  const frameFiles = files
    .filter((f) => f.startsWith('frame_') && f.endsWith('.png'))
    .sort();

  if (frameFiles.length === 0) {
    throw new Error('No frame files found (expected frame_*.png)');
  }

  return frameFiles.map((filename, index) => {
    // Parse timestamp from filename: frame_00001_t0.00.png
    const match = filename.match(/frame_(\d+)_t([\d.]+)\.png/);
    const frameIndex = match ? parseInt(match[1]) : index + 1;
    const timestamp = match ? parseFloat(match[2]) : index * 0.2;

    return {
      filename,
      path: path.join(framesDir, filename),
      index: frameIndex,
      timestamp,
      frameId: `frame_${String(frameIndex).padStart(5, '0')}`,
    };
  });
}

/**
 * Safely parse a filename from a URL
 * @param url - URL to parse (HTTP/HTTPS/S3)
 * @param fallback - Fallback filename if parsing fails
 * @returns Extracted filename or fallback
 */
export function safeParseFilenameFromUrl(url: string, fallback = 'video.mp4'): string {
  try {
    // Convert s3:// to https:// for URL parsing
    const normalizedUrl = url.replace(/^s3:\/\//, 'https://');
    const parsedUrl = new URL(normalizedUrl);
    const basename = path.basename(parsedUrl.pathname);
    return basename || fallback;
  } catch {
    return fallback;
  }
}

#!/usr/bin/env node

/**
 * VOPI Pipeline Testing CLI
 * Interactive menu for testing individual pipeline steps
 */

import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';

// Load environment variables
import 'dotenv/config';

import { testDownload } from './test-download.js';
import { testExtract } from './test-extract.js';
import { testScore } from './test-score.js';
import { testClassify } from './test-classify.js';
import { testGenerate, testPhotoroomOperation } from './test-generate.js';
import { testUpload, testS3Operations } from './test-upload.js';
import { printDivider, printInfo, printError, printRaw } from './utils.js';

/**
 * Main menu options
 */
const MENU_CHOICES = [
  {
    name: '1. Download    - Download video from URL (HTTP/S3)',
    value: 'download',
    description: 'Test downloading a video from HTTP(S) or S3 URL',
  },
  {
    name: '2. Extract     - Extract frames from video (FFmpeg)',
    value: 'extract',
    description: 'Test frame extraction at specified FPS',
  },
  {
    name: '3. Score       - Score frames (sharpness/motion)',
    value: 'score',
    description: 'Test frame scoring algorithm',
  },
  {
    name: '4. Classify    - Classify frames with Gemini AI',
    value: 'classify',
    description: 'Test Gemini API for frame classification',
  },
  {
    name: '5. Generate    - Generate commercial images (Photoroom)',
    value: 'generate',
    description: 'Test Photoroom API for commercial image generation',
  },
  {
    name: '6. Upload      - Upload to S3/MinIO',
    value: 'upload',
    description: 'Test S3 upload operations',
  },
  {
    name: '─────────────────────────────────────────────',
    value: 'separator',
    disabled: true,
  },
  {
    name: '7. S3 Operations (list, download, delete, etc.)',
    value: 's3-ops',
    description: 'Additional S3 operations',
  },
  {
    name: '8. Photoroom Single Operation',
    value: 'photoroom-single',
    description: 'Test individual Photoroom operations',
  },
  {
    name: '─────────────────────────────────────────────',
    value: 'separator2',
    disabled: true,
  },
  {
    name: '0. Exit',
    value: 'exit',
  },
];

/**
 * Print welcome banner
 * Note: Uses console.log directly with chalk for multi-line colored ASCII art
 */
function printBanner(): void {
  printRaw(chalk.cyan(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ██╗   ██╗ ██████╗ ██████╗ ██╗    ████████╗███████╗███████╗  ║
║   ██║   ██║██╔═══██╗██╔══██╗██║    ╚══██╔══╝██╔════╝██╔════╝  ║
║   ██║   ██║██║   ██║██████╔╝██║       ██║   █████╗  ███████╗  ║
║   ╚██╗ ██╔╝██║   ██║██╔═══╝ ██║       ██║   ██╔══╝  ╚════██║  ║
║    ╚████╔╝ ╚██████╔╝██║     ██║       ██║   ███████╗███████║  ║
║     ╚═══╝   ╚═════╝ ╚═╝     ╚═╝       ╚═╝   ╚══════╝╚══════╝  ║
║                                                               ║
║              Video Object Processing Infrastructure           ║
║                    Pipeline Testing CLI                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`));
}

/**
 * Print pipeline overview
 * Note: Uses printRaw with chalk for multi-line colored diagram
 */
function printPipelineOverview(): void {
  printRaw(chalk.gray(`
Pipeline Steps:
  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ Download │ → │ Extract  │ → │  Score   │ → │ Classify │ → │ Generate │ → │  Upload  │
  │  (S3)    │   │ (FFmpeg) │   │ (Sharp)  │   │ (Gemini) │   │(Photoroom│   │  (S3)    │
  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
`));
}

/**
 * Run the selected test
 */
async function runTest(choice: string): Promise<void> {
  switch (choice) {
    case 'download':
      await testDownload();
      break;
    case 'extract':
      await testExtract();
      break;
    case 'score':
      await testScore();
      break;
    case 'classify':
      await testClassify();
      break;
    case 'generate':
      await testGenerate();
      break;
    case 'upload':
      await testUpload();
      break;
    case 's3-ops':
      await testS3Operations();
      break;
    case 'photoroom-single':
      await testPhotoroomOperation();
      break;
    default:
      break;
  }
}

/**
 * Main menu loop
 */
async function mainMenu(): Promise<void> {
  while (true) {
    printRaw(''); // Add spacing

    const choice = await select({
      message: 'Select a pipeline step to test:',
      choices: MENU_CHOICES,
      pageSize: 15,
    });

    if (choice === 'exit') {
      printDivider();
      printInfo('Goodbye!');
      process.exit(0);
    }

    if (choice === 'separator' || choice === 'separator2') {
      continue;
    }

    try {
      await runTest(choice);
    } catch (error) {
      if ((error as Error).name === 'ExitPromptError') {
        // User pressed Ctrl+C during prompt
        printInfo('Operation cancelled');
      } else {
        printError(`Error: ${(error as Error).message}`);
      }
    }

    printDivider();

    const continueMenu = await confirm({
      message: 'Return to main menu?',
      default: true,
    });

    if (!continueMenu) {
      printInfo('Goodbye!');
      process.exit(0);
    }
  }
}

/**
 * Entry point
 */
async function main(): Promise<void> {
  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    printRaw(chalk.yellow('\n\nInterrupted. Goodbye!'));
    process.exit(0);
  });

  printBanner();
  printPipelineOverview();
  printDivider();

  // Check for optional environment variables that enhance functionality
  const optionalEnvVars = [
    'DATABASE_URL',
    'REDIS_URL',
    'GOOGLE_AI_API_KEY',
    'PHOTOROOM_API_KEY',
    'S3_BUCKET',
  ];

  const missingEnvVars = optionalEnvVars.filter((name) => !process.env[name]);

  if (missingEnvVars.length > 0) {
    printInfo('Note: Some environment variables are not set:');
    for (const name of missingEnvVars) {
      printRaw(chalk.yellow(`  - ${name}`));
    }
    printRaw(chalk.gray('Some tests may not work without these.\n'));
  }

  try {
    await mainMenu();
  } catch (error) {
    if ((error as Error).name === 'ExitPromptError') {
      printRaw(chalk.yellow('\nGoodbye!'));
      process.exit(0);
    }
    throw error;
  }
}

// Run
main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});

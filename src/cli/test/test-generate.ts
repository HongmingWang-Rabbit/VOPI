import { input, select, confirm, checkbox } from '@inquirer/prompts';
import path from 'path';

import { photoroomService } from '../../services/photoroom.service.js';
import type { RecommendedFrame } from '../../services/gemini.service.js';
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
  createTempDir,
  cleanupTempDir,
  formatFileSize,
  listFilesWithSizes,
  Timer,
  isValidFile,
} from './utils.js';

type VersionType = 'transparent' | 'solid' | 'real' | 'creative';

/** Options for creating a mock RecommendedFrame */
interface MockFrameOptions {
  imagePath: string;
  useAIEdit: boolean;
  solidColor: string;
  realPrompt: string;
  creativePrompt: string;
}

/**
 * Create a mock RecommendedFrame for testing Photoroom generation
 */
function createMockRecommendedFrame(options: MockFrameOptions): RecommendedFrame {
  const { imagePath, useAIEdit, solidColor, realPrompt, creativePrompt } = options;

  return {
    filename: path.basename(imagePath),
    path: imagePath,
    index: 1,
    timestamp: 0,
    frameId: 'frame_00001',
    sharpness: 0,
    motion: 0,
    score: 0,
    productId: 'product_1',
    variantId: 'variant_a',
    angleEstimate: 'front',
    recommendedType: 'test_frame',
    geminiScore: 100,
    allFrameIds: ['frame_00001'],
    obstructions: {
      has_obstruction: useAIEdit,
      obstruction_types: useAIEdit ? ['hand'] : [],
      obstruction_description: useAIEdit ? 'Simulated obstruction for AI edit test' : null,
      removable_by_ai: true,
    },
    backgroundRecommendations: {
      solid_color: solidColor,
      solid_color_name: 'custom',
      real_life_setting: realPrompt,
      creative_shot: creativePrompt,
    },
  };
}

/** Version choices for checkbox prompt */
const VERSION_CHOICES: Array<{ name: string; value: VersionType; checked: boolean }> = [
  { name: 'Transparent (background removal)', value: 'transparent', checked: true },
  { name: 'Solid (white background)', value: 'solid', checked: true },
  { name: 'Real (AI-generated realistic setting)', value: 'real', checked: true },
  { name: 'Creative (AI-generated artistic background)', value: 'creative', checked: true },
];

/**
 * Test the Generate step of the pipeline
 * Generates commercial images via Photoroom API
 */
export async function testGenerate(): Promise<{
  success: boolean;
  outputDir?: string;
  tempDir?: string;
}> {
  printHeader('Test Generate Step (Photoroom)');

  // Check API key
  let config;
  try {
    config = getConfig();
  } catch {
    printError('Failed to load configuration. Make sure .env file exists.');
    return { success: false };
  }

  if (!config.apis.photoroom) {
    printError('PHOTOROOM_API_KEY not configured');
    printInfo('Please set PHOTOROOM_API_KEY in your .env file');
    return { success: false };
  }

  printSuccess('Photoroom API key found');
  printLabel('  Basic Host', config.apis.photoroomBasicHost);
  printLabel('  Plus Host', config.apis.photoroomPlusHost);
  printDivider();

  // Get input image from user
  const imagePath = await input({
    message: 'Enter path to image file (PNG/JPG):',
    validate: async (value) => {
      if (!value.trim()) return 'Image path is required';
      const isFile = await isValidFile(value);
      if (!isFile) return 'File not found or not accessible';
      const ext = path.extname(value).toLowerCase();
      if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
        return 'File must be PNG or JPG';
      }
      return true;
    },
  });

  // Select which versions to generate
  const versions = await checkbox<VersionType>({
    message: 'Select versions to generate:',
    choices: VERSION_CHOICES,
  });

  if (versions.length === 0) {
    printError('At least one version must be selected');
    return { success: false };
  }

  // Ask about AI edit for obstructions
  const useAIEdit = await confirm({
    message: 'Use AI edit to remove obstructions (hands, fingers, etc)?',
    default: false,
  });

  // Get background settings if needed
  let solidColor = '#FFFFFF';
  let realPrompt = 'on a clean white surface with soft lighting';
  let creativePrompt = 'floating with soft shadow on gradient background';

  if (versions.includes('solid')) {
    solidColor = await input({
      message: 'Solid background color (hex):',
      default: '#FFFFFF',
    });
  }

  if (versions.includes('real')) {
    realPrompt = await input({
      message: 'Real-life setting prompt:',
      default: 'on a clean white surface with soft lighting',
    });
  }

  if (versions.includes('creative')) {
    creativePrompt = await input({
      message: 'Creative shot prompt:',
      default: 'floating with soft shadow on gradient background',
    });
  }

  // Create temp directory for output
  const tempDir = await createTempDir('vopi-generate');

  printDivider();
  printInfo('Generation Configuration:');
  printLabel('  Input Image', imagePath);
  printLabel('  Versions', versions.join(', '));
  printLabel('  Use AI Edit', useAIEdit ? 'Yes' : 'No');
  printLabel('  Output Dir', tempDir);
  printDivider();

  // Confirm before making API calls
  printWarn(`This will make ${versions.length} API calls to Photoroom`);
  const proceed = await confirm({
    message: 'Proceed with generation?',
    default: true,
  });

  if (!proceed) {
    await cleanupTempDir(tempDir);
    printInfo('Generation cancelled');
    return { success: false };
  }

  const timer = new Timer();

  // Create a mock RecommendedFrame for the service
  const mockFrame = createMockRecommendedFrame({
    imagePath,
    useAIEdit,
    solidColor,
    realPrompt,
    creativePrompt,
  });

  try {
    printStep(1, 'Generating commercial images...');

    const result = await photoroomService.generateAllVersions(mockFrame, tempDir, {
      useAIEdit,
      versions,
    });

    const elapsed = timer.elapsedFormatted();

    // Show results
    printDivider();
    printInfo('Generation Results:');

    let successCount = 0;
    let failCount = 0;

    for (const [version, versionResult] of Object.entries(result.versions)) {
      if (versionResult.success) {
        successCount++;
        printSuccess(`${version}: ${path.basename(versionResult.outputPath || '')} (${formatFileSize(versionResult.size || 0)})`);
      } else {
        failCount++;
        printError(`${version}: ${versionResult.error}`);
      }
    }

    printDivider();
    printLabel('  Successful', successCount);
    printLabel('  Failed', failCount);
    printLabel('  Time', elapsed);

    // List all output files
    const outputFiles = await listFilesWithSizes(tempDir);
    if (outputFiles.length > 0) {
      printDivider();
      printInfo('Output Files:');
      for (const file of outputFiles) {
        printLabel(`  ${file.name}`, formatFileSize(file.size));
      }

      const totalSize = outputFiles.reduce((sum, f) => sum + f.size, 0);
      printLabel('  Total', formatFileSize(totalSize));
    }

    printDivider();
    printSuccess(`Generation completed in ${elapsed}`);

    // Ask if user wants to keep the files
    const keepFiles = await confirm({
      message: 'Keep the generated files?',
      default: true,
    });

    if (!keepFiles) {
      await cleanupTempDir(tempDir);
      printInfo('Temp directory cleaned up');
      return { success: successCount > 0 };
    }

    printSuccess(`Files saved at: ${tempDir}`);
    printInfo('Remember to clean up the temp directory when done.');

    return {
      success: successCount > 0,
      outputDir: tempDir,
      tempDir,
    };
  } catch (error) {
    printError(`Generation failed: ${(error as Error).message}`);
    await cleanupTempDir(tempDir);
    return { success: false };
  }
}

/**
 * Test individual Photoroom operations
 */
export async function testPhotoroomOperation(): Promise<{ success: boolean }> {
  printHeader('Test Individual Photoroom Operation');

  const operation = await select({
    message: 'Select operation to test:',
    choices: [
      { name: 'Remove Background (v1/segment)', value: 'remove' },
      { name: 'Solid Color Background', value: 'solid' },
      { name: 'AI Background (prompt-based)', value: 'ai' },
      { name: 'AI Edit (obstruction removal)', value: 'edit' },
    ],
  });

  const imagePath = await input({
    message: 'Enter path to image file:',
    validate: async (value) => {
      if (!value.trim()) return 'Image path is required';
      const isFile = await isValidFile(value);
      if (!isFile) return 'File not found';
      return true;
    },
  });

  const tempDir = await createTempDir('vopi-photoroom');
  const outputPath = path.join(tempDir, `output_${operation}.png`);

  const timer = new Timer();

  try {
    switch (operation) {
      case 'remove': {
        printStep(1, 'Removing background...');
        await photoroomService.removeBackground(imagePath, outputPath);
        break;
      }
      case 'solid': {
        const color = await input({
          message: 'Background color (hex):',
          default: '#FFFFFF',
        });
        printStep(1, 'Generating with solid background...');
        await photoroomService.generateWithSolidBackground(imagePath, outputPath, color);
        break;
      }
      case 'ai': {
        const prompt = await input({
          message: 'Background prompt:',
          default: 'on a clean white surface with soft studio lighting',
        });
        printStep(1, 'Generating with AI background...');
        await photoroomService.generateWithAIBackground(imagePath, outputPath, prompt);
        break;
      }
      case 'edit': {
        const prompt = await input({
          message: 'Edit prompt (what to remove/change):',
          default: 'Erase any human hands from this image',
        });
        printStep(1, 'Applying AI edit...');
        await photoroomService.editImageWithAI(imagePath, outputPath, { customPrompt: prompt });
        break;
      }
    }

    printSuccess(`Operation completed in ${timer.elapsedFormatted()}`);
    printLabel('  Output', outputPath);

    const keepFile = await confirm({
      message: 'Keep the output file?',
      default: true,
    });

    if (!keepFile) {
      await cleanupTempDir(tempDir);
    } else {
      printSuccess(`File saved at: ${outputPath}`);
    }

    return { success: true };
  } catch (error) {
    printError(`Operation failed: ${(error as Error).message}`);
    await cleanupTempDir(tempDir);
    return { success: false };
  }
}

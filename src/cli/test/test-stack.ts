import { select, input, confirm } from '@inquirer/prompts';
import { mkdir, rm, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

import { globalConfigService } from '../../services/global-config.service.js';
import { PipelineTimer } from '../../utils/timer.js';
import {
  stackRunner,
  getStackTemplate,
  processorRegistry,
  stackTemplates,
  stagingStackTemplates,
  setupProcessors,
  type ProcessorContext,
  type WorkDirs,
  type StackTemplate,
  type FrameMetadata,
  type PipelineData,
} from '../../processors/index.js';
import { initDatabase, getDatabase, schema } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import type { Job } from '../../db/schema.js';
import type { CommercialVersion } from '../../types/job.types.js';
import {
  printHeader,
  printSuccess,
  printError,
  printInfo,
  printLabel,
  printDivider,
  printWarn,
  printJson,
  printRaw,
  Timer,
  formatDuration,
} from './utils.js';

/**
 * Ensure processors are registered (idempotent)
 */
function ensureProcessorsRegistered(): void {
  if (processorRegistry.getAll().length === 0) {
    setupProcessors();
  }
}

/**
 * Test processor stack execution
 */
export async function testStack(): Promise<void> {
  printHeader('Test Processor Stack');

  // Ensure processors are registered for IO type display
  ensureProcessorsRegistered();

  // List available stacks
  const productionStacks = Object.entries(stackTemplates).map(([id, stack]) => ({
    name: `${id} - ${stack.name}`,
    value: id,
    description: (stack as StackTemplate).description || `${stack.steps.length} steps`,
  }));

  const stagingStacks = Object.entries(stagingStackTemplates).map(([id, stack]) => ({
    name: `${id} - ${stack.name} (staging)`,
    value: `staging:${id}`,
    description: (stack as StackTemplate).description || `${stack.steps.length} steps`,
  }));

  printInfo('Available processor stacks:');
  printDivider();

  // Select stack
  const stackChoice = await select({
    message: 'Select a stack to run:',
    choices: [
      { name: '── Production Stacks ──', value: 'sep1', disabled: true },
      ...productionStacks,
      { name: '── Staging/Test Stacks ──', value: 'sep2', disabled: true },
      ...stagingStacks,
    ],
    pageSize: 20,
  });

  // Get stack template
  let stack: StackTemplate | undefined;
  let stackId: string;

  if (stackChoice.startsWith('staging:')) {
    stackId = stackChoice.replace('staging:', '');
    stack = stagingStackTemplates[stackId];
  } else {
    stackId = stackChoice;
    stack = getStackTemplate(stackId);
  }

  if (!stack) {
    printError(`Stack '${stackId}' not found`);
    return;
  }

  // Run the stack using shared logic
  await runStackWithConfig(stack);
}

/**
 * Shared function to run a stack with user configuration
 */
async function runStackWithConfig(stack: StackTemplate): Promise<void> {
  // Ensure processors are registered
  ensureProcessorsRegistered();

  // Show stack details
  printDivider();
  printInfo(`Stack: ${stack.name}`);
  if (stack.description) {
    printLabel('Description', stack.description);
  }
  printLabel('Steps', String(stack.steps.length));
  printRaw('');
  for (let i = 0; i < stack.steps.length; i++) {
    const step = stack.steps[i];
    const processor = processorRegistry.get(step.processor);
    const ioInfo = processor
      ? `[${processor.io.requires.join(', ') || 'none'}] → [${processor.io.produces.join(', ') || 'none'}]`
      : '[unknown]';
    printRaw(`  ${i + 1}. ${step.processor} ${ioInfo}`);
  }

  printDivider();

  // Determine required inputs based on the first processor
  const firstProcessor = processorRegistry.get(stack.steps[0]?.processor);
  const requiredIO = firstProcessor?.io.requires || [];

  printInfo(`Required inputs: [${requiredIO.join(', ') || 'none'}]`);

  let videoUrl: string | undefined;
  let imagePaths: string[] | undefined;
  let framesMetadata: FrameMetadata[] | undefined;
  let textData: string | undefined;
  let productType: string | undefined;

  // Check if we need metadata (frames/scores/classifications) - if so, ask for it first
  // since metadata file can contain images too
  const needsMetadata = requiredIO.some((io) => ['frames', 'scores', 'classifications'].includes(io));

  if (needsMetadata) {
    // Ask for metadata file first
    const metadataPath = await input({
      message: 'Enter path to metadata JSON file (see input/sample-frames-metadata.json):',
      validate: (value) => {
        if (!value.trim()) return 'Metadata file path is required';
        return true;
      },
    });
    try {
      // Strip surrounding quotes if present (user may copy-paste with quotes)
      const cleanPath = metadataPath.trim().replace(/^['"]|['"]$/g, '');
      const metadataContent = await readFile(cleanPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);
      framesMetadata = metadata.frames;
      // Also extract images if present in metadata
      if (metadata.images) {
        imagePaths = metadata.images;
      }
      // Extract productType if present (used by claid-bg-remove)
      if (metadata.productType) {
        productType = metadata.productType;
      }
      printSuccess(`Loaded ${framesMetadata?.length || 0} frames from metadata file`);
      if (imagePaths?.length) {
        printInfo(`Images: ${imagePaths.length} from metadata`);
      }
      if (productType) {
        printInfo(`Product type: ${productType}`);
      }
    } catch (error) {
      printError(`Failed to load metadata: ${(error as Error).message}`);
      return;
    }
  }

  // Prompt for remaining required IO types (skip ones already loaded from metadata)
  for (const ioType of requiredIO) {
    switch (ioType) {
      case 'video': {
        const videoInput = await input({
          message: 'Enter video URL or local path:',
          validate: (value) => {
            if (!value.trim()) return 'Video URL/path is required';
            return true;
          },
        });
        // Strip surrounding quotes (user may copy-paste with quotes)
        videoUrl = videoInput.trim().replace(/^['"]|['"]$/g, '');
        break;
      }

      case 'images': {
        // Skip if already loaded from metadata
        if (imagePaths?.length) {
          break;
        }
        const imagesInput = await input({
          message: 'Enter image paths (comma-separated):',
          validate: (value) => {
            if (!value.trim()) return 'At least one image path is required';
            return true;
          },
        });
        // Strip surrounding quotes from each path (user may copy-paste with quotes)
        imagePaths = imagesInput.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, ''));
        break;
      }

      // Note: Old IO types 'frames', 'scores', 'classifications' have been simplified to just 3 types
      // Frame metadata is now handled via the unified metadata object, not as separate IO types

      case 'text': {
        const textInput = await input({
          message: 'Enter text data:',
        });
        // Strip surrounding quotes (user may copy-paste with quotes)
        textData = textInput.trim().replace(/^['"]|['"]$/g, '');
        break;
      }

      default:
        printWarn(`Unknown IO type: ${ioType}`);
    }
  }

  // Ask about commercial versions if stack includes commercial generation
  const hasCommercialProcessor = stack.steps.some((s) =>
    s.processor.includes('commercial') || s.processor.includes('generate')
  );
  let commercialVersions: string[] = ['transparent']; // Default to minimal

  if (hasCommercialProcessor) {
    const allVersions = await confirm({
      message: 'Generate all commercial versions? (transparent, solid, real, creative)',
      default: true,
    });
    if (allVersions) {
      commercialVersions = ['transparent', 'solid', 'real', 'creative'];
    }
  }

  // Ask about processor options
  const configureOptions = await confirm({
    message: 'Configure processor options?',
    default: false,
  });

  const processorOptions: Record<string, Record<string, unknown>> = {};

  if (configureOptions) {
    for (const step of stack.steps) {
      const configureThis = await confirm({
        message: `Configure options for '${step.processor}'?`,
        default: false,
      });

      if (configureThis) {
        const optionsJson = await input({
          message: `Enter JSON options for '${step.processor}':`,
          default: '{}',
        });
        try {
          processorOptions[step.processor] = JSON.parse(optionsJson);
        } catch {
          printWarn(`Invalid JSON for ${step.processor}, using defaults`);
        }
      }
    }
  }

  // Create mock job and context
  // Use a real UUID since complete-job processor updates the database which expects UUID format
  const jobId = randomUUID();
  const mockJob: Job = {
    id: jobId,
    videoUrl: videoUrl || '',
    config: {
      fps: 10,
      batchSize: 30,
      commercialVersions: commercialVersions as CommercialVersion[],
      aiCleanup: true,
      geminiModel: 'gemini-2.0-flash',
    },
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    callbackUrl: null,
    progress: null,
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
    apiKeyId: null,
    userId: null,
    productMetadata: null,
  };

  // Create work directories
  const workDirs = await createWorkDirs(jobId);

  // Initialize database (required by globalConfigService and some processors)
  printInfo('Initializing database...');
  await initDatabase();
  const db = getDatabase();

  // Insert job record into database (required for foreign key constraints)
  printInfo('Creating job record...');
  await db.insert(schema.jobs).values({
    id: jobId,
    videoUrl: videoUrl || '',
    config: mockJob.config,
    status: 'pending',
  });

  // Get effective config (requires database)
  const effectiveConfig = await globalConfigService.getEffectiveConfig();

  // Create timer
  const timer = new PipelineTimer(jobId);
  const overallTimer = new Timer();

  // Create processor context (override commercialVersions with user's choice)
  const context: ProcessorContext = {
    job: mockJob,
    jobId,
    config: {
      fps: effectiveConfig.fps,
      batchSize: effectiveConfig.batchSize,
      commercialVersions: commercialVersions as CommercialVersion[],
      aiCleanup: effectiveConfig.aiCleanup,
      geminiModel: effectiveConfig.geminiModel,
    },
    workDirs,
    onProgress: async (progress) => {
      printRaw(`  [${progress.status}] ${progress.percentage}% - ${progress.message || ''}`);
    },
    timer,
    effectiveConfig,
  };

  printDivider();
  printInfo('Starting stack execution...');
  printLabel('Job ID', jobId);
  printLabel('Work Dir', workDirs.root);
  printDivider();

  try {
    // Prepare initial data with required metadata object
    const initialData: PipelineData = { metadata: {} };
    if (videoUrl) {
      // For stacks starting with download, pass the URL as video.sourceUrl
      // For stacks starting with extract-frames, pass as video.path (local file)
      if (stack.steps[0]?.processor === 'download') {
        initialData.video = { sourceUrl: videoUrl };
        mockJob.videoUrl = videoUrl;  // Also set for backwards compatibility
      } else {
        initialData.video = { path: videoUrl };
      }
    }
    if (imagePaths) {
      initialData.images = imagePaths;
    }
    if (framesMetadata) {
      initialData.frames = framesMetadata;
      initialData.recommendedFrames = framesMetadata;
      // Also set in unified metadata
      initialData.metadata.frames = framesMetadata;
    }
    if (textData) {
      initialData.text = textData;
    }
    if (productType) {
      initialData.productType = productType;
    }

    // Run the stack - initialData always has metadata now
    const result = await stackRunner.execute(
      stack,
      context,
      Object.keys(processorOptions).length > 0 ? { processorOptions } : undefined,
      initialData
    );

    printDivider();
    printSuccess(`Stack completed in ${formatDuration(overallTimer.elapsed() / 1000)}`);
    printDivider();

    // Show results summary
    printInfo('Results:');

    if (result.frames?.length) {
      printLabel('Frames extracted', String(result.frames.length));
    }
    if (result.candidateFrames?.length) {
      printLabel('Candidate frames', String(result.candidateFrames.length));
    }
    if (result.recommendedFrames?.length) {
      printLabel('Recommended frames', String(result.recommendedFrames.length));
    }
    if (result.uploadedUrls?.length) {
      printLabel('Uploaded URLs', String(result.uploadedUrls.length));
    }
    if (result.video?.path) {
      printLabel('Video path', result.video.path);
    }

    // Show timing summary
    printDivider();
    printInfo('Timing Summary:');
    timer.logSummary();

    // Wait for pino-pretty worker to flush logs before showing prompts
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Show where results are stored
    printDivider();
    printInfo('Results stored at:');
    printLabel('Work directory', workDirs.root);
    printLabel('  - Frames', workDirs.frames);
    printLabel('  - Final', workDirs.final);
    if (result.uploadedUrls?.length) {
      printLabel('S3/MinIO', `jobs/${jobId}/frames/ (${result.uploadedUrls.length} files)`);
    }
    printLabel('Database Job ID', jobId);

    // Ask to show full result
    const showFull = await confirm({
      message: 'Show full result JSON?',
      default: false,
    });

    if (showFull) {
      printJson(result);
    }

    // Cleanup
    const cleanup = await confirm({
      message: 'Clean up work directory and database records?',
      default: true,
    });

    if (cleanup) {
      await rm(workDirs.root, { recursive: true, force: true });
      // Delete job and related records (cascades to videos, frames, etc.)
      await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
      printInfo('Work directory and database records cleaned up');
    } else {
      printInfo(`Work directory preserved at: ${workDirs.root}`);
      printInfo(`Job record preserved in database: ${jobId}`);
    }
  } catch (error) {
    // Wait for pino-pretty worker to flush logs before showing prompts
    await new Promise((resolve) => setTimeout(resolve, 100));

    printError(`Stack execution failed: ${(error as Error).message}`);

    const showStack = await confirm({
      message: 'Show error stack trace?',
      default: false,
    });

    if (showStack) {
      console.error((error as Error).stack);
    }

    // Ask about cleanup on error
    const cleanup = await confirm({
      message: 'Clean up work directory and database records?',
      default: false,
    });

    if (cleanup) {
      await rm(workDirs.root, { recursive: true, force: true });
      // Delete job and related records (cascades to videos, frames, etc.)
      await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
      printInfo('Work directory and database records cleaned up');
    } else {
      printInfo(`Work directory preserved for debugging at: ${workDirs.root}`);
      printInfo(`Job record preserved in database: ${jobId}`);
    }
  }
}

/**
 * Show available stack templates and optionally run one
 */
export async function showStacks(): Promise<void> {
  printHeader('Available Stack Templates');

  // Ensure processors are registered for IO type display
  ensureProcessorsRegistered();

  // Build choices for selection
  const productionChoices = Object.entries(stackTemplates).map(([id, stack]) => {
    const requiredInputs = stackRunner.getRequiredInputs(stack);
    const producedOutputs = stackRunner.getProducedOutputs(stack);
    return {
      name: `${id} - ${stack.name}`,
      value: id,
      description: `${stack.description || ''}\n      Steps: ${stack.steps.map((s) => s.processor).join(' → ')}\n      Requires: [${requiredInputs.join(', ') || 'none'}] → Produces: [${producedOutputs.join(', ')}]`,
    };
  });

  const stagingChoices = Object.entries(stagingStackTemplates).map(([id, stack]) => {
    const requiredInputs = stackRunner.getRequiredInputs(stack);
    const producedOutputs = stackRunner.getProducedOutputs(stack);
    return {
      name: `${id} - ${stack.name} (staging)`,
      value: `staging:${id}`,
      description: `${stack.description || ''}\n      Steps: ${stack.steps.map((s) => s.processor).join(' → ')}\n      Requires: [${requiredInputs.join(', ') || 'none'}] → Produces: [${producedOutputs.join(', ')}]`,
    };
  });

  // Show summary first
  printInfo(`Production Stacks: ${Object.keys(stackTemplates).length}`);
  for (const [id, stack] of Object.entries(stackTemplates)) {
    printRaw(`  • ${id}: ${stack.name}`);
  }
  printRaw('');
  printInfo(`Staging/Test Stacks: ${Object.keys(stagingStackTemplates).length}`);
  for (const [id, stack] of Object.entries(stagingStackTemplates)) {
    printRaw(`  • ${id}: ${stack.name}`);
  }
  printDivider();

  // Ask if user wants to run a stack
  const wantToRun = await confirm({
    message: 'Would you like to run a stack?',
    default: true,
  });

  if (!wantToRun) {
    return;
  }

  // Select stack to run
  const stackChoice = await select({
    message: 'Select a stack to run:',
    choices: [
      { name: '── Production Stacks ──', value: 'sep1', disabled: true },
      ...productionChoices,
      { name: '── Staging/Test Stacks ──', value: 'sep2', disabled: true },
      ...stagingChoices,
      { name: '── Cancel ──', value: 'cancel', disabled: false },
    ],
    pageSize: 20,
  });

  if (stackChoice === 'cancel' || stackChoice === 'sep1' || stackChoice === 'sep2') {
    return;
  }

  // Get stack template
  let stack: StackTemplate | undefined;
  let stackId: string;

  if (stackChoice.startsWith('staging:')) {
    stackId = stackChoice.replace('staging:', '');
    stack = stagingStackTemplates[stackId];
  } else {
    stackId = stackChoice;
    stack = getStackTemplate(stackId);
  }

  if (!stack) {
    printError(`Stack '${stackId}' not found`);
    return;
  }

  // Run the stack using the same flow as testStack
  await runStackWithConfig(stack);
}

/**
 * Show registered processors
 */
export async function showProcessors(): Promise<void> {
  printHeader('Registered Processors');

  // Ensure processors are registered
  ensureProcessorsRegistered();

  const processors = processorRegistry.getAll();

  printInfo(`Total: ${processors.length} processors`);
  printDivider();

  // Group by category (based on folder structure)
  const categories: Record<string, typeof processors> = {
    'Storage': [],
    'FFmpeg': [],
    'Sharp': [],
    'Gemini': [],
    'Photoroom': [],
    'Claid': [],
    'Database': [],
    'Utility': [],
    'Other': [],
  };

  for (const processor of processors) {
    const id = processor.id;
    if (id.includes('download') || id.includes('upload')) {
      categories['Storage'].push(processor);
    } else if (id.includes('extract-frames')) {
      categories['FFmpeg'].push(processor);
    } else if (id.includes('center') || id.includes('rotate') || id.includes('score')) {
      categories['Sharp'].push(processor);
    } else if (id.includes('gemini')) {
      categories['Gemini'].push(processor);
    } else if (id.includes('photoroom') || id.includes('extract-products') || id.includes('generate-commercial')) {
      categories['Photoroom'].push(processor);
    } else if (id.includes('claid')) {
      categories['Claid'].push(processor);
    } else if (id.includes('save') || id.includes('complete')) {
      categories['Database'].push(processor);
    } else if (id.includes('filter')) {
      categories['Utility'].push(processor);
    } else {
      categories['Other'].push(processor);
    }
  }

  for (const [category, procs] of Object.entries(categories)) {
    if (procs.length === 0) continue;

    printRaw(`\n${category}:`);
    for (const proc of procs) {
      const requires = proc.io.requires.length > 0 ? proc.io.requires.join(', ') : 'none';
      const produces = proc.io.produces.length > 0 ? proc.io.produces.join(', ') : 'none';
      printLabel(`  ${proc.id}`, `[${requires}] → [${produces}]`);
    }
  }
}

/**
 * Create working directories for test execution
 * Uses project's output/ folder for easy access to results
 */
async function createWorkDirs(jobId: string): Promise<WorkDirs> {
  // Use project's output folder instead of system temp for easier access
  const projectRoot = process.cwd();
  const root = path.join(projectRoot, 'output', jobId);
  const workDirs: WorkDirs = {
    root,
    video: path.join(root, 'video'),
    frames: path.join(root, 'frames'),
    candidates: path.join(root, 'candidates'),
    extracted: path.join(root, 'extracted'),
    final: path.join(root, 'final'),
    commercial: path.join(root, 'commercial'),
  };

  await Promise.all([
    mkdir(workDirs.video, { recursive: true }),
    mkdir(workDirs.frames, { recursive: true }),
    mkdir(workDirs.candidates, { recursive: true }),
    mkdir(workDirs.extracted, { recursive: true }),
    mkdir(workDirs.final, { recursive: true }),
    mkdir(workDirs.commercial, { recursive: true }),
  ]);

  return workDirs;
}

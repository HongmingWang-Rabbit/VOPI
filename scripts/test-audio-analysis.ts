/**
 * Test script for audio analysis pipeline
 * Run with: npx tsx scripts/test-audio-analysis.ts <video-path>
 */

// Load environment variables first
import 'dotenv/config';

import { mkdir, copyFile, stat } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

import { globalConfigService } from '../src/services/global-config.service.js';
import { PipelineTimer } from '../src/utils/timer.js';
import {
  stackRunner,
  processorRegistry,
  setupProcessors,
  type ProcessorContext,
  type WorkDirs,
  type PipelineData,
  type StackTemplate,
} from '../src/processors/index.js';
import { initDatabase, getDatabase, schema } from '../src/db/index.js';
import { eq } from 'drizzle-orm';
import type { Job } from '../src/db/schema.js';
import type { CommercialVersion } from '../src/types/job.types.js';

/**
 * Local file audio analysis stack - skips download, uses local video path
 */
const localAudioAnalysisStack: StackTemplate = {
  id: 'local_audio_analysis',
  name: 'Local Audio Analysis Pipeline',
  description: 'Extract audio and generate product metadata from local video file',
  steps: [
    { processor: 'extract-audio' },
    { processor: 'gemini-audio-analysis' },
    { processor: 'complete-job' },
  ],
};

async function main() {
  const videoPath = process.argv[2];

  if (!videoPath) {
    console.error('Usage: npx tsx scripts/test-audio-analysis.ts <video-path>');
    process.exit(1);
  }

  // Verify file exists
  try {
    const stats = await stat(videoPath);
    console.log('\n=== Audio Analysis Pipeline Test ===\n');
    console.log(`Video: ${videoPath}`);
    console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  } catch {
    console.error(`Error: Video file not found: ${videoPath}`);
    process.exit(1);
  }

  // Ensure processors are registered
  if (processorRegistry.getAll().length === 0) {
    setupProcessors();
  }

  // Use local file stack (skips download step)
  const stack = localAudioAnalysisStack;
  console.log(`\nStack: ${stack.name}`);
  console.log(`Description: ${stack.description}`);
  console.log(`Steps: ${stack.steps.map(s => s.processor).join(' → ')}\n`);

  // Create job ID and work dirs
  const jobId = randomUUID();
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

  console.log(`Job ID: ${jobId}`);
  console.log(`Work Dir: ${root}\n`);

  // Initialize database
  console.log('Initializing database...');
  await initDatabase();
  const db = getDatabase();

  // Create mock job
  const mockJob: Job = {
    id: jobId,
    videoUrl: videoPath,
    config: {
      fps: 10,
      batchSize: 30,
      commercialVersions: ['transparent', 'solid', 'real', 'creative'],
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
    productMetadata: null,
  };

  // Insert job record
  console.log('Creating job record...');
  await db.insert(schema.jobs).values({
    id: jobId,
    videoUrl: videoPath,
    config: mockJob.config,
    status: 'pending',
  });

  // Get effective config
  const effectiveConfig = await globalConfigService.getEffectiveConfig();

  // Create timer
  const timer = new PipelineTimer(jobId);
  const startTime = Date.now();

  // Create processor context
  const context: ProcessorContext = {
    job: mockJob,
    jobId,
    config: {
      fps: effectiveConfig.fps,
      batchSize: effectiveConfig.batchSize,
      commercialVersions: effectiveConfig.commercialVersions as CommercialVersion[],
      aiCleanup: effectiveConfig.aiCleanup,
      geminiModel: effectiveConfig.geminiModel,
    },
    workDirs,
    onProgress: async (progress) => {
      console.log(`  [${progress.status}] ${progress.percentage}% - ${progress.message || ''}`);
    },
    timer,
    effectiveConfig,
  };

  console.log('\n--- Starting Pipeline Execution ---\n');

  try {
    // Prepare initial data - use video.path since we skip download step
    const initialData: PipelineData = {
      metadata: {},
      video: { path: videoPath },
    };

    // Run the stack
    const result = await stackRunner.execute(stack, context, undefined, initialData);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n--- Pipeline Completed in ${elapsed}s ---\n`);

    // Show results
    console.log('=== Results ===\n');

    if (result.transcript) {
      console.log('Transcript:');
      console.log('-'.repeat(50));
      console.log(result.transcript.substring(0, 500) + (result.transcript.length > 500 ? '...' : ''));
      console.log('-'.repeat(50));
      console.log(`(Full transcript: ${result.transcript.length} characters)\n`);
    }

    if (result.productMetadata) {
      console.log('Product Metadata:');
      console.log('-'.repeat(50));
      console.log(JSON.stringify(result.productMetadata, null, 2).substring(0, 1000));
      console.log('-'.repeat(50));
    }

    // Check for metadata file
    if (result.audio?.path) {
      console.log(`\nAudio file: ${result.audio.path}`);
    }

    // Show where outputs are stored
    console.log('\n=== Output Locations ===\n');
    console.log(`Work Directory: ${workDirs.root}`);
    console.log(`  - Video: ${workDirs.video}`);

    // Check job for productMetadata
    const updatedJob = await db.query.jobs.findFirst({
      where: eq(schema.jobs.id, jobId),
    });

    if (updatedJob?.productMetadata) {
      console.log('\n=== Product Metadata (from DB) ===\n');
      console.log('Transcript:', updatedJob.productMetadata.transcript?.substring(0, 200) + '...');
      console.log('Title:', updatedJob.productMetadata.product?.title);
      console.log('Price:', updatedJob.productMetadata.product?.price, updatedJob.productMetadata.product?.currency);
      console.log('Category:', updatedJob.productMetadata.product?.category);
    }

    console.log(`\nDatabase Job ID: ${jobId}`);

    // Show full result
    console.log('\n=== Full Pipeline Result ===\n');
    console.log(JSON.stringify({
      transcript: result.transcript ? `${result.transcript.substring(0, 200)}...` : null,
      productMetadata: result.productMetadata,
      audio: result.audio,
      video: result.video,
    }, null, 2));

    // Don't cleanup - keep the results for inspection
    console.log('\n=== Test Complete ===');
    console.log(`\nResults preserved at: ${workDirs.root}`);
    console.log(`To clean up later: rm -rf ${workDirs.root}`);
    console.log(`To delete DB record: DELETE FROM jobs WHERE id = '${jobId}'`);

  } catch (error) {
    console.error(`\n--- Pipeline Failed ---`);
    console.error(`Error: ${(error as Error).message}`);
    console.error((error as Error).stack);

    // Keep work dir for debugging
    console.log(`\nWork directory preserved for debugging: ${workDirs.root}`);

    // Cleanup DB record on error
    await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
    console.log('Database record cleaned up');

    process.exit(1);
  }
}

main().catch(console.error);

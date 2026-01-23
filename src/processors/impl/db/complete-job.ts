/**
 * Complete Job Processor
 *
 * Marks job as complete and saves final results.
 * Stores product metadata directly in the database if audio analysis was performed.
 */

import { eq } from 'drizzle-orm';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { getDatabase, schema } from '../../../db/index.js';
import { JobStatus, type JobResult } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import type { ProductMetadata, MetadataFileOutput } from '../../../types/product-metadata.types.js';
import { createMetadataFileOutput } from '../../../types/product-metadata.types.js';

const logger = createChildLogger({ service: 'processor:complete-job' });

/**
 * Build full ProductMetadata from pipeline output
 */
function buildFullProductMetadata(data: PipelineData): ProductMetadata | null {
  const output = data.metadata?.productMetadata;
  if (!output?.title) {
    return null;
  }

  // Check if we have full metadata in extensions
  const fullMetadata = data.metadata?.extensions?.fullProductMetadata as ProductMetadata | undefined;
  if (fullMetadata) {
    return fullMetadata;
  }

  // Build from output format
  return {
    title: output.title,
    description: output.description,
    shortDescription: output.shortDescription,
    bulletPoints: output.bulletPoints || [],
    brand: output.brand,
    category: output.category,
    keywords: output.keywords,
    tags: output.tags,
    color: output.color,
    materials: output.materials,
    confidence: {
      overall: output.confidence,
      title: output.confidence,
      description: output.confidence,
    },
    extractedFromAudio: output.extractedFromAudio,
    transcriptExcerpts: output.transcriptExcerpts,
  };
}

export const completeJobProcessor: Processor = {
  id: 'complete-job',
  displayName: 'Complete Job',
  statusKey: JobStatus.COMPLETED,
  io: {
    // Terminal processor: accepts any pipeline state and doesn't add new IO types.
    // Writes final result to auxiliary metadata (not tracked in IO validation).
    requires: [],
    produces: [],
    // No metadata requirements - this is a terminal processor
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, onProgress } = context;
    const db = getDatabase();

    logger.info({ jobId }, 'Completing job');

    await onProgress?.({
      status: JobStatus.COMPLETED,
      percentage: 95,
      message: 'Finalizing results',
    });

    // Gather results - prefer metadata.frames, fall back to legacy fields
    const metadataFrames = data.metadata?.frames || [];
    const recommendedFrames = metadataFrames.length > 0 ? metadataFrames : (data.recommendedFrames || []);
    const candidateFrames = data.candidateFrames || [];
    const framesAnalyzed = data.metadata?.framesAnalyzed ?? candidateFrames.length;
    const uploadedUrls = data.uploadedUrls || [];
    const commercialImageUrls = data.metadata?.commercialImageUrls || {};

    // Build metadata file output if product metadata was extracted
    let metadataOutput: MetadataFileOutput | undefined;
    const productMetadata = buildFullProductMetadata(data);
    if (productMetadata) {
      const transcript = data.metadata?.transcript || '';
      const audioDuration = data.metadata?.audioDuration;
      metadataOutput = createMetadataFileOutput(transcript, productMetadata, audioDuration);
      logger.info({ jobId, title: productMetadata.title }, 'Product metadata extracted from audio');
    }

    const result: JobResult = {
      variantsDiscovered: recommendedFrames.length,
      framesAnalyzed,
      finalFrames: uploadedUrls,
      commercialImages: commercialImageUrls,
    };

    await onProgress?.({
      status: JobStatus.COMPLETED,
      percentage: 100,
      message: 'Pipeline completed',
    });

    // Update job with result (if it exists in the database)
    // In test mode, the job may not exist - this is safe to ignore
    try {
      await db
        .update(schema.jobs)
        .set({
          status: JobStatus.COMPLETED,
          result,
          productMetadata: metadataOutput ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, jobId));
    } catch (error) {
      // Log but don't fail if job doesn't exist (e.g., in test mode)
      logger.warn({ jobId, error: (error as Error).message }, 'Could not update job record - may be running in test mode');
    }

    logger.info({
      jobId,
      variantsDiscovered: result.variantsDiscovered,
      hasMetadata: !!metadataOutput,
    }, 'Pipeline completed');

    // Return the pipeline data - productMetadata stays as the simplified version
    // The full MetadataFileOutput is only stored in the database
    return {
      success: true,
      data: {
        metadata: {
          ...data.metadata,
          result,
        },
      },
    };
  },
};

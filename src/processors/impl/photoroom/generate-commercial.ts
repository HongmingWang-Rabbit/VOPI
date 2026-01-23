/**
 * Generate Commercial Processor
 *
 * Generates commercial image versions using Photoroom.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, CommercialImageData, FrameMetadata } from '../../types.js';
import { getFrameDbIdMap, getInputFrames } from '../../types.js';
import { photoroomService } from '../../../services/photoroom.service.js';
import { storageService } from '../../../services/storage.service.js';
import { getDatabase, schema } from '../../../db/index.js';
import type { NewCommercialImage } from '../../../db/schema.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import {
  PROGRESS,
  calculateProgress,
  DEFAULT_FRAME_OBSTRUCTIONS,
  DEFAULT_BACKGROUND_RECOMMENDATIONS,
} from '../../constants.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:generate-commercial' });

interface VersionUploadResult {
  version: string;
  url: string;
  localPath: string;
  bgColor?: string;
  bgPrompt?: string;
}

interface FrameGenerationResult {
  variantKey: string;
  commercialImages: CommercialImageData[];
  variantImages: Record<string, string>;
  hasErrors: boolean;
}

/**
 * Upload a commercial image version to S3 and save to database
 */
async function uploadAndSaveVersion(
  jobId: string,
  frameDbId: string | undefined,
  version: string,
  localPath: string,
  timer: ProcessorContext['timer'],
  bgColor?: string,
  bgPrompt?: string
): Promise<VersionUploadResult> {
  const s3Key = storageService.getJobKey(jobId, 'commercial', path.basename(localPath));
  const { url } = await timer.timeOperation(
    's3_upload_commercial',
    () => storageService.uploadFile(localPath, s3Key),
    { version }
  );

  if (frameDbId) {
    const db = getDatabase();
    await db.insert(schema.commercialImages).values({
      jobId,
      frameId: frameDbId,
      version,
      localPath,
      s3Url: url,
      backgroundColor: bgColor,
      backgroundPrompt: bgPrompt,
      success: true,
    } satisfies NewCommercialImage);
  }

  return { version, url, localPath, bgColor, bgPrompt };
}

/**
 * Save a failed version record to database
 */
async function saveFailedVersion(
  jobId: string,
  frameDbId: string,
  version: string,
  error?: string
): Promise<void> {
  const db = getDatabase();
  await db.insert(schema.commercialImages).values({
    jobId,
    frameId: frameDbId,
    version,
    success: false,
    error,
  } satisfies NewCommercialImage);
}

/**
 * Process a single frame's commercial versions
 */
async function processFrameVersions(
  frame: FrameMetadata,
  jobId: string,
  workDirs: ProcessorContext['workDirs'],
  timer: ProcessorContext['timer'],
  versions: string[],
  frameDbId: string | undefined,
  extractionResults: Map<string, { success: boolean; outputPath?: string }>
): Promise<FrameGenerationResult> {
  const variantKey = frame.recommendedType || frame.frameId;
  const commercialImages: CommercialImageData[] = [];
  const variantImages: Record<string, string> = {};
  let hasErrors = false;

  // Check if we have pre-extracted product
  const extraction = extractionResults.get(frame.frameId);
  const hasExtractedProduct = !!(extraction?.success && extraction.outputPath);

  // Generate commercial versions
  const result = await timer.timeOperation(
    'photoroom_generate_versions',
    () => photoroomService.generateAllVersions(
      {
        frameId: frame.frameId,
        path: frame.path,
        timestamp: frame.timestamp,
        filename: frame.filename,
        index: frame.index,
        sharpness: frame.sharpness ?? 0,
        motion: frame.motion ?? 0,
        score: frame.score ?? 0,
        productId: frame.productId ?? 'unknown',
        variantId: frame.variantId ?? 'default',
        angleEstimate: frame.angleEstimate ?? '',
        recommendedType: frame.recommendedType ?? frame.frameId,
        variantDescription: frame.variantDescription ?? '',
        geminiScore: frame.geminiScore ?? 0,
        rotationAngleDeg: frame.rotationAngleDeg ?? 0,
        allFrameIds: frame.allFrameIds ?? [frame.frameId],
        obstructions: frame.obstructions ?? DEFAULT_FRAME_OBSTRUCTIONS,
        backgroundRecommendations: frame.backgroundRecommendations ?? DEFAULT_BACKGROUND_RECOMMENDATIONS,
      },
      workDirs.commercial,
      {
        versions,
        transparentSource: hasExtractedProduct ? extraction.outputPath : undefined,
        skipTransparent: hasExtractedProduct,
      }
    ),
    { frameId: frame.frameId, versions }
  );

  // Handle pre-extracted transparent version
  if (hasExtractedProduct && versions.includes('transparent')) {
    const uploadResult = await uploadAndSaveVersion(
      jobId,
      frameDbId,
      'transparent',
      extraction.outputPath!,
      timer
    );
    variantImages.transparent = uploadResult.url;
    commercialImages.push({
      frameId: frame.frameId,
      version: 'transparent',
      path: extraction.outputPath,
      s3Url: uploadResult.url,
      success: true,
    });
  }

  // Process other versions
  for (const [version, versionResult] of Object.entries(result.versions)) {
    if (versionResult.success && versionResult.outputPath) {
      const uploadResult = await uploadAndSaveVersion(
        jobId,
        frameDbId,
        version,
        versionResult.outputPath,
        timer,
        versionResult.bgColor,
        versionResult.bgPrompt
      );
      variantImages[version] = uploadResult.url;
      commercialImages.push({
        frameId: frame.frameId,
        version,
        path: versionResult.outputPath,
        s3Url: uploadResult.url,
        success: true,
        backgroundColor: versionResult.bgColor,
        backgroundPrompt: versionResult.bgPrompt,
      });
    } else {
      hasErrors = true;
      commercialImages.push({
        frameId: frame.frameId,
        version,
        success: false,
        error: versionResult.error,
      });

      if (frameDbId) {
        await saveFailedVersion(jobId, frameDbId, version, versionResult.error);
      }
    }
  }

  return { variantKey, commercialImages, variantImages, hasErrors };
}

export const generateCommercialProcessor: Processor = {
  id: 'generate-commercial',
  displayName: 'Generate Commercial Images',
  statusKey: JobStatus.GENERATING,
  io: {
    requires: ['images', 'frames'],
    produces: ['images'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, config, workDirs, onProgress, timer } = context;

    // Get input frames with fallback to legacy fields
    const inputFrames = getInputFrames(data);
    if (inputFrames.length === 0) {
      return { success: false, error: 'No frames for commercial generation' };
    }

    // Get frameId -> dbId mapping (handles both legacy and new formats)
    const frameRecords = getFrameDbIdMap(data);

    const extractionResults = data.extractionResults || new Map();
    const versions = (options?.versions as string[]) ?? config.commercialVersions;

    logger.info({ jobId, frameCount: inputFrames.length, versions }, 'Generating commercial images');

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: PROGRESS.GENERATE_COMMERCIAL.START,
      message: 'Generating commercial images',
    });

    // Process frames in parallel (Photoroom API rate limited)
    const concurrency = getConcurrency('PHOTOROOM_GENERATE', options);
    let processedCount = 0;

    const parallelResults = await parallelMap(
      inputFrames,
      async (frame): Promise<FrameGenerationResult & { error?: string }> => {
        const frameDbId = frameRecords.get(frame.frameId) || frame.dbId;

        try {
          const result = await processFrameVersions(
            frame,
            jobId,
            workDirs,
            timer,
            versions,
            frameDbId,
            extractionResults
          );

          // Update progress
          processedCount++;
          await onProgress?.({
            status: JobStatus.GENERATING,
            percentage: calculateProgress(processedCount, inputFrames.length, PROGRESS.GENERATE_COMMERCIAL.START, PROGRESS.GENERATE_COMMERCIAL.END),
            message: `Generating images for ${frame.recommendedType || frame.frameId}`,
          });

          return result;
        } catch (error) {
          processedCount++;
          logger.error({ error, frame: frame.frameId, jobId }, 'Commercial generation failed for frame');
          return {
            variantKey: frame.recommendedType || frame.frameId,
            commercialImages: [{
              frameId: frame.frameId,
              version: 'all',
              success: false,
              error: (error as Error).message,
            }],
            variantImages: {},
            hasErrors: true,
            error: (error as Error).message,
          };
        }
      },
      { concurrency }
    );

    // Collect results
    const allCommercialImages: CommercialImageData[] = [];
    const commercialImageUrls: Record<string, Record<string, string>> = {};
    let totalErrors = 0;
    let successfulFrames = 0;

    for (let i = 0; i < inputFrames.length; i++) {
      const result = parallelResults.results[i];

      if (isParallelError(result)) {
        totalErrors++;
        allCommercialImages.push({
          frameId: inputFrames[i].frameId,
          version: 'all',
          success: false,
          error: result.message,
        });
      } else {
        allCommercialImages.push(...result.commercialImages);
        commercialImageUrls[result.variantKey] = result.variantImages;

        if (result.hasErrors) {
          totalErrors++;
        } else {
          successfulFrames++;
        }
      }
    }

    const successCount = allCommercialImages.filter((c) => c.success).length;
    logger.info({
      jobId,
      generatedCount: successCount,
      totalErrors,
      successfulFrames,
      totalFrames: inputFrames.length,
    }, 'Commercial generation complete');

    // Return partial success info in metadata
    return {
      success: true,
      data: {
        commercialImages: allCommercialImages,
        // New unified metadata
        metadata: {
          ...data.metadata,
          commercialImageUrls,
          commercialGenerationStats: {
            totalFrames: inputFrames.length,
            successfulFrames,
            totalErrors,
            totalImagesGenerated: successCount,
          },
        },
      },
    };
  },
};

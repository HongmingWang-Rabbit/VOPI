/**
 * Stability AI Commercial Image Processor
 *
 * Generates commercial image versions using Stability AI:
 * - transparent: Already processed by previous bg-remove processor (pass-through)
 * - solid: Solid color background using Sharp (local processing)
 * - real: Realistic AI-generated background using Stability Replace Background and Relight
 * - creative: Creative AI-generated background using Stability Replace Background and Relight
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, CommercialImageData, FrameMetadata } from '../../types.js';
import { getFrameDbIdMap, getInputFrames } from '../../types.js';
import { stabilityCommercialProvider, type CommercialBackgroundOptions } from '../../../providers/implementations/stability-commercial.provider.js';
import { storageService } from '../../../services/storage.service.js';
import { getDatabase, schema } from '../../../db/index.js';
import type { NewCommercialImage } from '../../../db/schema.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import {
  PROGRESS,
  calculateProgress,
  DEFAULT_BACKGROUND_RECOMMENDATIONS,
} from '../../constants.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:stability-commercial' });

/** All available commercial versions */
export const ALL_COMMERCIAL_VERSIONS = ['transparent', 'solid', 'real', 'creative'] as const;

/** Default commercial versions (minimal - frontend can request more) */
const DEFAULT_VERSIONS = ['transparent'] as const;

/** Default background color for solid backgrounds */
const DEFAULT_BG_COLOR = '#FFFFFF';

/** Default padding for generated images */
const DEFAULT_PADDING = 0.12;

/** Default AI background options for 'real' version */
const REAL_BACKGROUND_OPTIONS: Omit<CommercialBackgroundOptions, 'backgroundPrompt'> = {
  foregroundPrompt: 'product photography, high quality, detailed',
  negativePrompt: 'blurry, low quality, distorted, deformed',
  lightSourceDirection: 'above',
  lightSourceStrength: 0.6,
  preserveOriginalSubject: 0.95,
};

/** Default AI background options for 'creative' version */
const CREATIVE_BACKGROUND_OPTIONS: Omit<CommercialBackgroundOptions, 'backgroundPrompt'> = {
  foregroundPrompt: 'commercial product shot, studio lighting, professional',
  negativePrompt: 'blurry, low quality, distorted, deformed, text, watermark',
  lightSourceDirection: 'above',
  lightSourceStrength: 0.7,
  preserveOriginalSubject: 0.9,
};

interface VersionGenerationResult {
  version: string;
  success: boolean;
  localPath?: string;
  s3Url?: string;
  bgColor?: string;
  bgPrompt?: string;
  error?: string;
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
): Promise<{ url: string }> {
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

  return { url };
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
 * Process a single version for a frame
 */
async function processVersion(
  version: string,
  frame: FrameMetadata,
  jobId: string,
  workDirs: ProcessorContext['workDirs'],
  timer: ProcessorContext['timer'],
  frameDbId: string | undefined,
  bgRec: typeof DEFAULT_BACKGROUND_RECOMMENDATIONS
): Promise<VersionGenerationResult> {
  const baseName = `${frame.recommendedType || frame.frameId}_${frame.frameId}`;
  const sourceImage = frame.path;

  try {
    switch (version) {
      case 'transparent': {
        // Transparent version - already processed by claid/stability bg-remove
        // Just upload the current frame path as transparent version
        const { url } = await uploadAndSaveVersion(jobId, frameDbId, 'transparent', sourceImage, timer);
        return {
          version: 'transparent',
          success: true,
          localPath: sourceImage,
          s3Url: url,
        };
      }

      case 'solid': {
        // Solid color background (using Sharp - no API call)
        const outputPath = path.join(workDirs.commercial, `${baseName}_solid.png`);
        const result = await timer.timeOperation(
          'stability_solid_background',
          () => stabilityCommercialProvider.generateWithSolidBackground(sourceImage, outputPath, {
            backgroundColor: bgRec.solid_color || DEFAULT_BG_COLOR,
            padding: DEFAULT_PADDING,
          }),
          { frameId: frame.frameId, version: 'solid' }
        );

        if (result.success && result.outputPath) {
          const { url } = await uploadAndSaveVersion(jobId, frameDbId, 'solid', result.outputPath, timer, result.bgColor);
          return {
            version: 'solid',
            success: true,
            localPath: result.outputPath,
            s3Url: url,
            bgColor: result.bgColor,
          };
        }
        return { version: 'solid', success: false, error: result.error };
      }

      case 'real': {
        // Real-life setting (using Stability AI Replace Background)
        const outputPath = path.join(workDirs.commercial, `${baseName}_real.png`);
        const result = await timer.timeOperation(
          'stability_real_background',
          () => stabilityCommercialProvider.generateWithAIBackground(sourceImage, outputPath, {
            backgroundPrompt: bgRec.real_life_setting || 'on a clean white surface with soft natural lighting',
            ...REAL_BACKGROUND_OPTIONS,
          }),
          { frameId: frame.frameId, version: 'real' }
        );

        if (result.success && result.outputPath) {
          const { url } = await uploadAndSaveVersion(jobId, frameDbId, 'real', result.outputPath, timer, undefined, result.bgPrompt);
          return {
            version: 'real',
            success: true,
            localPath: result.outputPath,
            s3Url: url,
            bgPrompt: result.bgPrompt,
          };
        }
        return { version: 'real', success: false, error: result.error };
      }

      case 'creative': {
        // Creative shot (using Stability AI Replace Background)
        const outputPath = path.join(workDirs.commercial, `${baseName}_creative.png`);
        const result = await timer.timeOperation(
          'stability_creative_background',
          () => stabilityCommercialProvider.generateWithAIBackground(sourceImage, outputPath, {
            backgroundPrompt: bgRec.creative_shot || 'floating with soft shadow on elegant gradient background',
            ...CREATIVE_BACKGROUND_OPTIONS,
          }),
          { frameId: frame.frameId, version: 'creative' }
        );

        if (result.success && result.outputPath) {
          const { url } = await uploadAndSaveVersion(jobId, frameDbId, 'creative', result.outputPath, timer, undefined, result.bgPrompt);
          return {
            version: 'creative',
            success: true,
            localPath: result.outputPath,
            s3Url: url,
            bgPrompt: result.bgPrompt,
          };
        }
        return { version: 'creative', success: false, error: result.error };
      }

      default:
        return { version, success: false, error: `Unknown version: ${version}` };
    }
  } catch (err) {
    const error = (err as Error).message;
    // Don't save here - let caller handle DB saves consistently
    return { version, success: false, error };
  }
}

/**
 * Process a single frame's commercial versions using Stability AI
 * Versions are processed in parallel for better performance
 */
async function processFrameVersions(
  frame: FrameMetadata,
  jobId: string,
  workDirs: ProcessorContext['workDirs'],
  timer: ProcessorContext['timer'],
  versions: string[],
  frameDbId: string | undefined
): Promise<FrameGenerationResult> {
  const variantKey = frame.recommendedType || frame.frameId;
  const bgRec = frame.backgroundRecommendations || DEFAULT_BACKGROUND_RECOMMENDATIONS;

  // Process all versions in parallel for better performance
  const results = await Promise.all(
    versions.map((version) =>
      processVersion(version, frame, jobId, workDirs, timer, frameDbId, bgRec)
    )
  );

  // Collect results
  const commercialImages: CommercialImageData[] = [];
  const variantImages: Record<string, string> = {};
  let hasErrors = false;

  for (const result of results) {
    if (result.success && result.s3Url) {
      variantImages[result.version] = result.s3Url;
      commercialImages.push({
        frameId: frame.frameId,
        version: result.version,
        path: result.localPath,
        s3Url: result.s3Url,
        success: true,
        backgroundColor: result.bgColor,
        backgroundPrompt: result.bgPrompt,
      });
    } else {
      hasErrors = true;
      commercialImages.push({
        frameId: frame.frameId,
        version: result.version,
        success: false,
        error: result.error,
      });
      if (frameDbId) {
        await saveFailedVersion(jobId, frameDbId, result.version, result.error);
      }
    }
  }

  return { variantKey, commercialImages, variantImages, hasErrors };
}

export const stabilityCommercialProcessor: Processor = {
  id: 'stability-commercial',
  displayName: 'Generate Commercial Images (Stability)',
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

    // Check if provider is available
    if (!stabilityCommercialProvider.isAvailable()) {
      logger.warn({ jobId }, 'Stability API not configured, skipping commercial generation');
      return {
        success: true,
        data: {},
      };
    }

    // Get frameId -> dbId mapping (handles both legacy and new formats)
    const frameRecords = getFrameDbIdMap(data);

    const versions = (options?.versions as string[]) ?? config.commercialVersions ?? [...DEFAULT_VERSIONS];

    logger.info({ jobId, frameCount: inputFrames.length, versions }, 'Generating commercial images with Stability AI');

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: PROGRESS.GENERATE_COMMERCIAL.START,
      message: 'Generating commercial images (Stability AI)',
    });

    // Process frames in parallel with concurrency limit
    const concurrency = getConcurrency('STABILITY_COMMERCIAL', options);
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
            frameDbId
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
          logger.error({ error, frame: frame.frameId, jobId }, 'Stability commercial generation failed for frame');
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
    }, 'Stability commercial generation complete');

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

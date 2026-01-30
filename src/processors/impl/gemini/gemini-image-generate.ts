/**
 * Gemini Image Generation Processor
 *
 * Generates commercial image versions using Gemini's image generation:
 * - white-studio: Clean white background with professional lighting
 * - lifestyle: Contextual lifestyle setting
 *
 * This processor replaces the traditional pipeline of:
 * - claid-bg-remove
 * - fill-product-holes
 * - center-product
 * - stability-commercial
 * - stability-upscale
 *
 * With a single Gemini-based approach that handles everything.
 */

import path from 'path';
import type {
  Processor,
  ProcessorContext,
  PipelineData,
  ProcessorResult,
  CommercialImageData,
  FrameMetadata,
} from '../../types.js';
import { getFrameDbIdMap, getInputFrames } from '../../types.js';
import { geminiImageGenerateProvider } from '../../../providers/implementations/gemini-image-generate.provider.js';
import type { GeminiImageVariant } from '../../../providers/interfaces/gemini-image-generate.provider.js';
import { storageService } from '../../../services/storage.service.js';
import { getDatabase, schema } from '../../../db/index.js';
import type { NewCommercialImage } from '../../../db/schema.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import type { TokenUsageTracker } from '../../../utils/token-usage.js';
import { selectBestAngles } from '../../../utils/frame-selection.js';
import { PROGRESS, calculateProgress } from '../../constants.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:gemini-image-generate' });

/** Default variants to generate */
const DEFAULT_VARIANTS: GeminiImageVariant[] = ['white-studio', 'lifestyle'];

/** Default max angles to select for generation */
const DEFAULT_MAX_ANGLES = 4;

interface FrameGenerationResult {
  frameId: string;
  recommendedType: string;
  commercialImages: CommercialImageData[];
  hasErrors: boolean;
}

/**
 * Upload a commercial image to S3 and save to database
 */
async function uploadAndSaveVersion(
  jobId: string,
  frameDbId: string | undefined,
  version: string,
  localPath: string,
  timer: ProcessorContext['timer']
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
 * Process a single frame - generate all variants
 */
async function processFrame(
  frame: FrameMetadata,
  jobId: string,
  workDirs: ProcessorContext['workDirs'],
  timer: ProcessorContext['timer'],
  variants: GeminiImageVariant[],
  frameDbId: string | undefined,
  productContext: {
    title?: string;
    description?: string;
    category?: string;
  },
  referenceFramePaths: string[],
  tokenUsage?: TokenUsageTracker
): Promise<FrameGenerationResult> {
  const recommendedType = frame.recommendedType || frame.frameId;
  const commercialImages: CommercialImageData[] = [];
  let hasErrors = false;

  // Generate each variant
  for (const variant of variants) {
    const outputPath = path.join(workDirs.commercial, `${frame.frameId}_${variant}.png`);

    try {
      const result = await timer.timeOperation(
        `gemini_generate_${variant}`,
        () => geminiImageGenerateProvider.generateVariant(frame.path, outputPath, {
          variant,
          productTitle: productContext.title,
          productDescription: productContext.description,
          productCategory: productContext.category,
          referenceFramePaths,
        }, tokenUsage),
        { frameId: frame.frameId, variant }
      );

      if (result.success && result.outputPath) {
        // Upload to S3 and save DB record
        const { url } = await uploadAndSaveVersion(
          jobId,
          frameDbId,
          variant,
          result.outputPath,
          timer
        );

        commercialImages.push({
          frameId: frame.frameId,
          version: variant,
          path: result.outputPath,
          s3Url: url,
          success: true,
        });
      } else {
        hasErrors = true;
        commercialImages.push({
          frameId: frame.frameId,
          version: variant,
          success: false,
          error: result.error,
        });
        if (frameDbId) {
          await saveFailedVersion(jobId, frameDbId, variant, result.error);
        }
      }
    } catch (err) {
      hasErrors = true;
      const error = (err as Error).message;
      commercialImages.push({
        frameId: frame.frameId,
        version: variant,
        success: false,
        error,
      });
      if (frameDbId) {
        await saveFailedVersion(jobId, frameDbId, variant, error);
      }
    }
  }

  return {
    frameId: frame.frameId,
    recommendedType,
    commercialImages,
    hasErrors,
  };
}

export const geminiImageGenerateProcessor: Processor = {
  id: 'gemini-image-generate',
  displayName: 'Generate Images (Gemini)',
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
    const { jobId, workDirs, onProgress, timer } = context;

    // Get input frames with fallback to legacy fields
    const allFrames = getInputFrames(data);
    if (allFrames.length === 0) {
      return { success: false, error: 'No frames for Gemini image generation' };
    }

    // Check if provider is available
    if (!geminiImageGenerateProvider.isAvailable()) {
      logger.warn({ jobId }, 'Gemini API not configured, skipping image generation');
      return {
        success: true,
        data: {
          metadata: {
            ...data.metadata,
            extensions: {
              ...data.metadata?.extensions,
              geminiImageGenerateSkipped: true,
              geminiImageGenerateSkipReason: 'GOOGLE_AI_API_KEY not configured',
            },
            commercialGenerationStats: {
              totalFrames: 0,
              successfulFrames: 0,
              totalErrors: 0,
              totalImagesGenerated: 0,
            },
          },
        },
      };
    }

    // Get options
    const maxAngles = (options?.maxAngles as number) ?? DEFAULT_MAX_ANGLES;
    const variants = (options?.variants as GeminiImageVariant[]) ?? DEFAULT_VARIANTS;

    // Select best angles for diversity
    const inputFrames = selectBestAngles(allFrames, maxAngles);

    // Get frameId -> dbId mapping
    const frameRecords = getFrameDbIdMap(data);

    // Get product context from metadata
    const productContext = {
      title: data.metadata?.productMetadata?.title,
      description: data.metadata?.productMetadata?.description,
      category: data.metadata?.productType || data.metadata?.productMetadata?.category,
    };

    // Collect ALL frame paths as reference for context
    // This helps Gemini understand what the actual product looks like
    const referenceFramePaths = allFrames.map(f => f.path);

    logger.info({
      jobId,
      totalFrames: allFrames.length,
      selectedFrames: inputFrames.length,
      referenceFrameCount: referenceFramePaths.length,
      variants,
      maxAngles,
      hasProductContext: !!(productContext.title || productContext.description),
    }, 'Generating images with Gemini (with reference context)');

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: PROGRESS.GENERATE_COMMERCIAL.START,
      message: 'Generating images with Gemini AI',
    });

    // Process frames with concurrency limit
    const concurrency = getConcurrency('GEMINI_IMAGE_GENERATE', options);
    let processedCount = 0;

    const parallelResults = await parallelMap(
      inputFrames,
      async (frame): Promise<FrameGenerationResult & { error?: string }> => {
        const frameDbId = frameRecords.get(frame.frameId) || frame.dbId;

        try {
          const result = await processFrame(
            frame,
            jobId,
            workDirs,
            timer,
            variants,
            frameDbId,
            productContext,
            referenceFramePaths,
            context.tokenUsage
          );

          // Update progress
          processedCount++;
          await onProgress?.({
            status: JobStatus.GENERATING,
            percentage: calculateProgress(
              processedCount,
              inputFrames.length,
              PROGRESS.GENERATE_COMMERCIAL.START,
              PROGRESS.GENERATE_COMMERCIAL.END
            ),
            message: `Generating images for ${frame.recommendedType || frame.frameId}`,
          });

          return result;
        } catch (error) {
          processedCount++;
          logger.error({
            error,
            frame: frame.frameId,
            jobId,
          }, 'Gemini image generation failed for frame');

          return {
            frameId: frame.frameId,
            recommendedType: frame.recommendedType || frame.frameId,
            commercialImages: [{
              frameId: frame.frameId,
              version: 'all',
              success: false,
              error: (error as Error).message,
            }],
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

        // Track URLs by frameId
        for (const img of result.commercialImages) {
          if (img.success && img.s3Url) {
            if (!commercialImageUrls[img.frameId]) {
              commercialImageUrls[img.frameId] = {};
            }
            commercialImageUrls[img.frameId][img.version] = img.s3Url;
          }
        }

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
      totalImagesExpected: inputFrames.length * variants.length,
      commercialUrlFrameIds: Object.keys(commercialImageUrls),
    }, 'Gemini image generation complete');

    return {
      success: true,
      data: {
        commercialImages: allCommercialImages,
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

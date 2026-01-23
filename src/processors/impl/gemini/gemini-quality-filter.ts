/**
 * Gemini Quality Filter Processor
 *
 * Filters commercial images using AI to:
 * 1. Remove images with hands or human body parts
 * 2. Remove blurry or low-quality images
 * 3. Remove images where product doesn't match reference
 * 4. Remove white-studio images with background contamination
 *
 * This processor:
 * - Runs AFTER commercial image generation (images already on S3 under commercial/)
 * - Filters out bad images using AI evaluation
 * - Copies ONLY kept images to agent-filtered/ folder (locally and S3)
 * - Updates commercialImages data to only include kept ones
 */

import { copyFile, mkdir } from 'fs/promises';
import path from 'path';
import type {
  Processor,
  ProcessorContext,
  PipelineData,
  ProcessorResult,
  CommercialImageData,
} from '../../types.js';
import { getInputFrames } from '../../types.js';
import { geminiQualityFilterProvider } from '../../../providers/implementations/gemini-quality-filter.provider.js';
import { storageService } from '../../../services/storage.service.js';
import { getDatabase, schema } from '../../../db/index.js';
import { eq, and } from 'drizzle-orm';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { PROGRESS } from '../../constants.js';

const logger = createChildLogger({ service: 'processor:gemini-quality-filter' });

/**
 * Delimiter used to separate frameId and version in image IDs.
 * Using '::' to avoid conflicts with underscores in frameId (e.g., frame_00001).
 */
const IMAGE_ID_DELIMITER = '::';

/**
 * Output folder name for agent-filtered images
 */
const AGENT_FILTERED_FOLDER = 'agent-filtered';

/**
 * Build a unique image ID from frameId and version
 */
function buildImageId(frameId: string, version: string): string {
  return `${frameId}${IMAGE_ID_DELIMITER}${version}`;
}

/**
 * Parse an image ID back into frameId and version
 */
function parseImageId(imageId: string): { frameId: string; version: string } | null {
  const parts = imageId.split(IMAGE_ID_DELIMITER);
  if (parts.length !== 2) {
    return null;
  }
  return { frameId: parts[0], version: parts[1] };
}

/**
 * Default filter options
 */
const DEFAULT_OPTIONS = {
  minQualityScore: 60,
  allowHands: false,
};

/**
 * Type guard for successful commercial images with required fields
 */
function isKeptImage(
  img: CommercialImageData
): img is CommercialImageData & { path: string; s3Url: string } {
  return img.success === true && typeof img.path === 'string' && typeof img.s3Url === 'string';
}

export const geminiQualityFilterProcessor: Processor = {
  id: 'gemini-quality-filter',
  displayName: 'AI Quality Filter',
  statusKey: JobStatus.GENERATING,
  io: {
    requires: ['images'],
    produces: ['images'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, onProgress, timer } = context;

    // Get commercial images to filter
    const commercialImages = data.commercialImages;
    if (!commercialImages || commercialImages.length === 0) {
      logger.info({ jobId }, 'No commercial images to filter');
      return { success: true, data: {} };
    }

    // Filter to only successful images with paths
    const successfulImages = commercialImages.filter(
      (img): img is CommercialImageData & { path: string } =>
        img.success && !!img.path
    );

    if (successfulImages.length === 0) {
      logger.info({ jobId }, 'No successful commercial images to filter');
      return { success: true, data: {} };
    }

    // Check if provider is available
    if (!geminiQualityFilterProvider.isAvailable()) {
      logger.warn({ jobId }, 'Gemini API not configured, skipping quality filter');
      return { success: true, data: {} };
    }

    const opts = {
      ...DEFAULT_OPTIONS,
      ...(options as Partial<typeof DEFAULT_OPTIONS>),
    };

    // Get original frames as reference for comparison
    const originalFrames = getInputFrames(data);
    const referenceImages = originalFrames.map(f => f.path);

    logger.info({
      jobId,
      totalImages: successfulImages.length,
      referenceImageCount: referenceImages.length,
      minQualityScore: opts.minQualityScore,
    }, 'Starting AI quality filter with reference comparison');

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: PROGRESS.GENERATE_COMMERCIAL.END - 5,
      message: 'AI filtering images for quality',
    });

    // Prepare images for filtering using safe delimiter
    const imagesToFilter = successfulImages.map(img => ({
      id: buildImageId(img.frameId, img.version),
      path: img.path,
      variant: img.version,
    }));

    // Run quality filter with reference images
    const filterResult = await timer.timeOperation(
      'gemini_quality_filter',
      () => geminiQualityFilterProvider.filterImages(imagesToFilter, {
        minQualityScore: opts.minQualityScore,
        allowHands: opts.allowHands,
        referenceImages,  // Pass original frames for comparison
      }),
      { imageCount: imagesToFilter.length, referenceCount: referenceImages.length }
    );

    // Create set of kept image IDs for fast lookup
    const keptIds = new Set(filterResult.kept.map(img => img.imageId));

    // Build lookup map from imageId to original commercial image data
    const imageIdToData = new Map<string, CommercialImageData>();
    for (const img of commercialImages) {
      if (img.success) {
        const imageId = buildImageId(img.frameId, img.version);
        imageIdToData.set(imageId, img);
      }
    }

    // Separate kept and filtered images with proper validation using type guard
    const keptImages: (CommercialImageData & { path: string; s3Url: string })[] = [];
    const db = getDatabase();

    for (const img of commercialImages) {
      const imageId = buildImageId(img.frameId, img.version);

      // Only keep images that:
      // 1. Are in the kept set
      // 2. Pass the type guard (successful with path and s3Url)
      if (keptIds.has(imageId) && isKeptImage(img)) {
        keptImages.push(img);
      } else if (img.success) {
        logger.debug({
          imageId,
          frameId: img.frameId,
          version: img.version,
          hasPath: !!img.path,
          hasS3Url: !!img.s3Url,
        }, 'Image filtered out by quality check');
      }
    }

    // Update database records for filtered images
    for (const evaluation of filterResult.filtered) {
      // Parse imageId using safe parser
      const parsed = parseImageId(evaluation.imageId);
      if (!parsed) {
        logger.warn({
          imageId: evaluation.imageId,
          reason: evaluation.reason,
        }, 'Failed to parse imageId for filtered image, skipping DB update');
        continue;
      }

      const { version } = parsed;

      // Get the original image data to find the database frame ID
      const originalImg = imageIdToData.get(evaluation.imageId);

      // Require localPath for precise database updates
      // This prevents accidentally updating wrong records when version alone is ambiguous
      if (!originalImg?.path) {
        logger.warn({
          imageId: evaluation.imageId,
          version,
          reason: evaluation.reason,
        }, 'No localPath for filtered image, skipping DB update to avoid ambiguity');
        continue;
      }

      try {
        // Use jobId, version, AND localPath for precise updates
        await db
          .update(schema.commercialImages)
          .set({
            success: false,
            error: `Quality filtered: ${evaluation.reason}`,
          })
          .where(
            and(
              eq(schema.commercialImages.jobId, jobId),
              eq(schema.commercialImages.version, version),
              eq(schema.commercialImages.localPath, originalImg.path)
            )
          );
      } catch (err) {
        logger.warn({
          error: (err as Error).message,
          imageId: evaluation.imageId,
          version,
          localPath: originalImg.path,
        }, 'Failed to update filtered image record');
      }
    }

    // Create agent-filtered directory
    const filteredDir = path.join(context.workDirs.root, AGENT_FILTERED_FOLDER);
    await mkdir(filteredDir, { recursive: true });

    // Copy kept images to agent-filtered folder and upload to S3 under agent-filtered/
    const updatedCommercialImages: CommercialImageData[] = [];
    const updatedCommercialImageUrls: Record<string, Record<string, string>> = {};

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: PROGRESS.GENERATE_COMMERCIAL.END - 3,
      message: `Copying ${keptImages.length} approved images`,
    });

    for (const img of keptImages) {
      try {
        const filename = path.basename(img.path);
        const filteredPath = path.join(filteredDir, filename);

        // Copy locally to agent-filtered folder
        await copyFile(img.path, filteredPath);

        // Upload to S3 under agent-filtered/
        const s3Key = storageService.getJobKey(jobId, AGENT_FILTERED_FOLDER, filename);
        const { url } = await timer.timeOperation(
          's3_upload_filtered',
          () => storageService.uploadFile(filteredPath, s3Key),
          { version: img.version }
        );

        // Create updated image record with new path and URL
        const updatedImg: CommercialImageData = {
          ...img,
          path: filteredPath,
          s3Url: url,
        };
        updatedCommercialImages.push(updatedImg);

        // Track URLs
        if (!updatedCommercialImageUrls[img.frameId]) {
          updatedCommercialImageUrls[img.frameId] = {};
        }
        updatedCommercialImageUrls[img.frameId][img.version] = url;

        logger.debug({
          frameId: img.frameId,
          version: img.version,
          filteredPath,
          url,
        }, 'Copied approved image to agent-filtered');
      } catch (err) {
        logger.error({
          error: (err as Error).message,
          frameId: img.frameId,
          version: img.version,
        }, 'Failed to copy approved image');
      }
    }

    logger.info({
      jobId,
      inputCount: successfulImages.length,
      keptCount: filterResult.stats.totalKept,
      filteredCount: filterResult.stats.totalFiltered,
      copiedCount: updatedCommercialImages.length,
      filterReasons: filterResult.stats.filterReasons,
    }, 'AI quality filter complete');

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: PROGRESS.GENERATE_COMMERCIAL.END,
      message: `Approved ${updatedCommercialImages.length} of ${successfulImages.length} images`,
    });

    return {
      success: true,
      data: {
        commercialImages: updatedCommercialImages,
        metadata: {
          ...data.metadata,
          commercialImageUrls: updatedCommercialImageUrls,
          extensions: {
            ...data.metadata?.extensions,
            qualityFilterStats: {
              totalInput: filterResult.stats.totalInput,
              totalKept: filterResult.stats.totalKept,
              totalFiltered: filterResult.stats.totalFiltered,
              filterReasons: filterResult.stats.filterReasons,
            },
          },
        },
      },
    };
  },
};

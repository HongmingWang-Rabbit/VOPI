/**
 * Fill Product Holes Processor
 *
 * Detects and fills transparent holes/gaps in product images after background removal.
 * Uses flood-fill algorithm to distinguish between intentional transparent background
 * and holes left by obstruction removal (e.g., hands covering the product).
 *
 * Algorithm:
 * 1. Extract alpha channel from PNG image
 * 2. Flood-fill from image edges to mark all "background" transparent pixels
 * 3. Any remaining transparent pixels are "holes" inside/along the product
 * 4. Use Photoroom's inpainting to fill detected holes
 */

import path from 'path';
import sharp from 'sharp';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { photoroomService } from '../../../services/photoroom.service.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:fill-product-holes' });

/**
 * Detect holes in an image using flood-fill from edges
 *
 * @param width - Image width
 * @param height - Image height
 * @param alphaData - Alpha channel data (0-255 per pixel)
 * @param alphaThreshold - Threshold below which pixels are considered transparent
 * @returns Array of hole pixel indices and total hole count
 */
function detectHoles(
  width: number,
  height: number,
  alphaData: Uint8Array,
  alphaThreshold: number
): { holeCount: number; totalPixels: number; opaquePixels: number } {
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);

  // Helper to check if pixel is transparent
  const isTransparent = (idx: number): boolean => alphaData[idx] <= alphaThreshold;

  // Helper to get pixel index
  const getIdx = (y: number, x: number): number => y * width + x;

  // BFS queue for flood-fill
  const queue: number[] = [];

  // Start flood-fill from all transparent edge pixels
  // Top and bottom edges
  for (let x = 0; x < width; x++) {
    const topIdx = getIdx(0, x);
    const bottomIdx = getIdx(height - 1, x);
    if (isTransparent(topIdx) && !visited[topIdx]) {
      queue.push(topIdx);
      visited[topIdx] = 1;
    }
    if (isTransparent(bottomIdx) && !visited[bottomIdx]) {
      queue.push(bottomIdx);
      visited[bottomIdx] = 1;
    }
  }

  // Left and right edges
  for (let y = 0; y < height; y++) {
    const leftIdx = getIdx(y, 0);
    const rightIdx = getIdx(y, width - 1);
    if (isTransparent(leftIdx) && !visited[leftIdx]) {
      queue.push(leftIdx);
      visited[leftIdx] = 1;
    }
    if (isTransparent(rightIdx) && !visited[rightIdx]) {
      queue.push(rightIdx);
      visited[rightIdx] = 1;
    }
  }

  // BFS flood-fill to mark all background pixels (connected to edges)
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1], // 4-connectivity
    [-1, -1], [-1, 1], [1, -1], [1, 1], // 8-connectivity for better detection
  ];

  while (queue.length > 0) {
    const idx = queue.shift()!;
    const y = Math.floor(idx / width);
    const x = idx % width;

    for (const [dy, dx] of directions) {
      const ny = y + dy;
      const nx = x + dx;

      if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
        const neighborIdx = getIdx(ny, nx);
        if (!visited[neighborIdx] && isTransparent(neighborIdx)) {
          visited[neighborIdx] = 1;
          queue.push(neighborIdx);
        }
      }
    }
  }

  // Count holes: transparent pixels NOT marked as background
  let holeCount = 0;
  let opaquePixels = 0;

  for (let i = 0; i < totalPixels; i++) {
    if (!isTransparent(i)) {
      opaquePixels++;
    } else if (!visited[i]) {
      // Transparent but not connected to edges = hole
      holeCount++;
    }
  }

  return { holeCount, totalPixels, opaquePixels };
}

export const fillProductHolesProcessor: Processor = {
  id: 'fill-product-holes',
  displayName: 'Fill Product Holes',
  statusKey: JobStatus.EXTRACTING_PRODUCT,
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

    const frames = data.recommendedFrames || data.frames;
    if (!frames || frames.length === 0) {
      return { success: false, error: 'No frames to process for hole filling' };
    }

    // Configurable options
    const alphaThreshold = (options?.alphaThreshold as number) ?? 10;
    // Minimum hole percentage relative to product area (default 0.01% = very sensitive)
    const minHolePercentage = (options?.minHolePercentage as number) ?? 0.01;
    // Minimum absolute hole pixel count to trigger inpainting (default 100 pixels)
    // This catches significant holes even in very large images where percentage is tiny
    const minHolePixels = (options?.minHolePixels as number) ?? 100;

    logger.info({ jobId, frameCount: frames.length, alphaThreshold, minHolePercentage, minHolePixels }, 'Detecting and filling product holes');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 66,
      message: 'Detecting product holes',
    });

    const updatedFrames = [];
    let totalHolesFilled = 0;

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const progress = 66 + Math.round(((i + 1) / frames.length) * 4);

      await onProgress?.({
        status: JobStatus.EXTRACTING_PRODUCT,
        percentage: progress,
        message: `Checking holes ${i + 1}/${frames.length}`,
      });

      try {
        // Load image and extract alpha channel
        const image = sharp(frame.path);
        const { width, height } = await image.metadata();

        if (!width || !height) {
          logger.warn({ frameId: frame.frameId }, 'Could not get image dimensions, skipping hole detection');
          updatedFrames.push(frame);
          continue;
        }

        // Extract raw RGBA data
        const { data: rawData } = await image
          .raw()
          .ensureAlpha()
          .toBuffer({ resolveWithObject: true });

        // Extract alpha channel (every 4th byte starting from index 3)
        const alphaData = new Uint8Array(width * height);
        for (let j = 0; j < width * height; j++) {
          alphaData[j] = rawData[j * 4 + 3];
        }

        // Detect holes using flood-fill
        const { holeCount, opaquePixels } = await timer.timeOperation(
          'detect_holes',
          () => Promise.resolve(detectHoles(width, height, alphaData, alphaThreshold)),
          { frameId: frame.frameId }
        );

        // Calculate hole percentage relative to product (opaque pixels)
        const holePercentage = opaquePixels > 0 ? (holeCount / opaquePixels) * 100 : 0;

        logger.info({
          frameId: frame.frameId,
          holeCount,
          opaquePixels,
          holePercentage: holePercentage.toFixed(4) + '%',
        }, 'Hole detection complete');

        // Trigger inpainting if EITHER:
        // 1. Hole percentage exceeds threshold (relative to product size)
        // 2. Absolute hole pixel count exceeds threshold (catches large holes in big images)
        const shouldFill = holeCount > 0 && (
          holePercentage >= minHolePercentage ||
          holeCount >= minHolePixels
        );

        if (shouldFill) {
          logger.info({
            frameId: frame.frameId,
            holeCount,
            holePercentage: holePercentage.toFixed(4) + '%',
            reason: holePercentage >= minHolePercentage ? 'percentage' : 'absolute_count',
          }, 'Filling product holes with Photoroom');

          const outputPath = path.join(workDirs.extracted, `${frame.frameId}_filled.png`);

          const inpaintResult = await timer.timeOperation(
            'inpaint_holes',
            () => photoroomService.inpaintHoles(frame.path, outputPath, {
              prompt: 'Fill in any missing or transparent parts of the product to make it complete and whole. Maintain the product texture and appearance.',
            }),
            { frameId: frame.frameId }
          );

          if (inpaintResult.success) {
            logger.info({ frameId: frame.frameId, outputPath }, 'Holes filled successfully');
            updatedFrames.push({ ...frame, path: outputPath });
            totalHolesFilled++;
          } else {
            logger.warn({ frameId: frame.frameId, error: inpaintResult.error }, 'Hole filling failed, keeping original');
            updatedFrames.push(frame);
          }
        } else {
          // No significant holes, keep original
          if (holeCount > 0) {
            logger.debug({
              frameId: frame.frameId,
              holeCount,
              holePercentage: holePercentage.toFixed(4) + '%',
              minHolePercentage,
              minHolePixels,
            }, 'Holes below both thresholds, skipping inpaint');
          }
          updatedFrames.push(frame);
        }
      } catch (error) {
        logger.warn({ frameId: frame.frameId, error: (error as Error).message }, 'Hole detection failed, keeping original');
        updatedFrames.push(frame);
      }
    }

    logger.info({ jobId, totalHolesFilled, totalFrames: frames.length }, 'Product hole filling complete');

    return {
      success: true,
      data: {
        images: updatedFrames.map((f) => f.path),
        recommendedFrames: updatedFrames,
      },
    };
  },
};

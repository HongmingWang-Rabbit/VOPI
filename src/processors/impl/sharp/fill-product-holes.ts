/**
 * Fill Product Holes Processor
 *
 * Detects and fills transparent holes/gaps in product images after background removal.
 * Uses convex hull algorithm to distinguish between intentional transparent background
 * and holes left by obstruction removal (e.g., hands covering the product).
 *
 * Algorithm:
 * 1. Extract alpha channel from PNG image
 * 2. Compute convex hull of the product boundary
 * 3. Any transparent pixels INSIDE the convex hull are "holes"
 * 4. Use Stability AI's inpainting model to fill the holes
 *
 * Optimizations:
 * - Scanline algorithm for efficient convex polygon filling
 * - Boundary point sampling for large images
 */

import path from 'path';
import sharp from 'sharp';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { stabilityService } from '../../../services/stability.service.js';
import { safeUnlink } from '../../../utils/fs.js';

const logger = createChildLogger({ service: 'processor:fill-product-holes' });

// =============================================================================
// Constants
// =============================================================================

/** Default target number of boundary points to sample (controls computation vs accuracy tradeoff) */
const DEFAULT_BOUNDARY_SAMPLE_TARGET = 500;

// =============================================================================
// Geometry Helpers (exported for testing)
// =============================================================================

/**
 * Point type for convex hull computation
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Compute cross product of vectors OA and OB where O is origin
 * Returns positive if counter-clockwise, negative if clockwise, 0 if collinear
 */
export function crossProduct(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Compute convex hull using Andrew's monotone chain algorithm
 * Returns points in counter-clockwise order
 *
 * Note: This function does NOT mutate the input array
 */
export function computeConvexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];

  // Clone and sort points by x, then by y (avoid mutating input)
  const sorted = [...points].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);

  // Build lower hull
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  // Build upper hull
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Remove last point of each half because it's repeated
  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

/**
 * Compute X intersections of a horizontal scanline with convex hull edges
 * Returns sorted array of X coordinates where scanline crosses hull edges
 */
export function getHullScanlineIntersections(hull: Point[], y: number): number[] {
  const intersections: number[] = [];

  for (let i = 0; i < hull.length; i++) {
    const p1 = hull[i];
    const p2 = hull[(i + 1) % hull.length];

    // Check if this edge crosses the scanline
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);

    if (y >= minY && y < maxY) {
      // Calculate X intersection using linear interpolation
      if (p2.y !== p1.y) {
        const t = (y - p1.y) / (p2.y - p1.y);
        const x = p1.x + t * (p2.x - p1.x);
        intersections.push(x);
      }
    }
  }

  // Sort intersections for scanline filling
  intersections.sort((a, b) => a - b);
  return intersections;
}

/**
 * Fill convex hull interior using scanline algorithm
 * Much more efficient than point-by-point testing: O(height * edges) vs O(pixels * edges)
 *
 * @param hull - Convex hull vertices
 * @param width - Image width
 * @param height - Image height
 * @returns Uint8Array where 255 = inside hull, 0 = outside
 */
export function fillConvexHullScanline(hull: Point[], width: number, height: number): Uint8Array {
  const filled = new Uint8Array(width * height);

  if (hull.length < 3) return filled;

  // Find bounding box
  let minY = Infinity, maxY = -Infinity;
  for (const p of hull) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  // Process each scanline
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(height - 1, Math.ceil(maxY)); y++) {
    const intersections = getHullScanlineIntersections(hull, y);

    // Fill between pairs of intersections
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(width - 1, Math.floor(intersections[i + 1]));

      for (let x = xStart; x <= xEnd; x++) {
        filled[y * width + x] = 255;
      }
    }
  }

  return filled;
}

/**
 * Detect holes in an image using convex hull approach
 *
 * Algorithm:
 * 1. Extract alpha channel from PNG image
 * 2. Sample boundary points of the opaque region
 * 3. Compute convex hull of the product
 * 4. Any transparent pixel INSIDE the convex hull is a hole
 *
 * This correctly detects edge gaps (like hand cutouts) as holes because
 * they fall inside the convex hull of the product.
 *
 * @param imagePath - Path to the PNG image
 * @param alphaThreshold - Threshold below which pixels are considered transparent
 * @param boundarySampleTarget - Target number of boundary points to sample (default: 500)
 * @returns Hole statistics and a mask buffer (255 = hole, 0 = not hole)
 */
async function detectHoles(
  imagePath: string,
  alphaThreshold: number,
  boundarySampleTarget: number = DEFAULT_BOUNDARY_SAMPLE_TARGET
): Promise<{ holeCount: number; totalPixels: number; opaquePixels: number; holeMask: Uint8Array; width: number; height: number }> {
  // Load image
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error('Could not get image dimensions');
  }

  const totalPixels = width * height;

  // Extract alpha channel as raw data
  const { data: rawData } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Extract alpha channel
  const alphaData = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaData[i] = rawData[i * 4 + 3];
  }

  // Helper to check if pixel is transparent
  const isTransparent = (idx: number): boolean => alphaData[idx] <= alphaThreshold;

  // Helper to get pixel index
  const getIdx = (y: number, x: number): number => y * width + x;

  // Sample boundary points (pixels that are opaque and adjacent to transparent)
  // Sample every Nth pixel to reduce computation for large images
  const boundaryPoints: Point[] = [];
  const sampleRate = Math.max(1, Math.floor(Math.min(width, height) / boundarySampleTarget));

  for (let y = 0; y < height; y += sampleRate) {
    for (let x = 0; x < width; x += sampleRate) {
      const idx = getIdx(y, x);
      if (!isTransparent(idx)) {
        // Check if this is a boundary pixel (adjacent to transparent)
        let isBoundary = false;
        for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            if (isTransparent(getIdx(ny, nx))) {
              isBoundary = true;
              break;
            }
          } else {
            // Edge of image counts as boundary
            isBoundary = true;
            break;
          }
        }

        if (isBoundary) {
          boundaryPoints.push({ x, y });
        }
      }
    }
  }

  // Count opaque pixels accurately (full scan, not sampled)
  let opaquePixels = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (!isTransparent(i)) {
      opaquePixels++;
    }
  }

  // Validate we have a meaningful product
  if (opaquePixels === 0) {
    logger.warn('No opaque pixels found - image may be fully transparent');
    return {
      holeCount: 0,
      totalPixels,
      opaquePixels: 0,
      holeMask: new Uint8Array(totalPixels),
      width,
      height,
    };
  }

  logger.info({ boundaryPoints: boundaryPoints.length, sampleRate, opaquePixels }, 'Collected boundary points for convex hull');

  // Compute convex hull
  const hull = computeConvexHull(boundaryPoints);
  logger.info({ hullPoints: hull.length }, 'Computed convex hull');

  if (hull.length < 3) {
    // No valid hull, return empty mask
    return {
      holeCount: 0,
      totalPixels,
      opaquePixels,
      holeMask: new Uint8Array(totalPixels),
      width,
      height,
    };
  }

  // Use scanline algorithm to efficiently fill the convex hull interior
  const hullInterior = fillConvexHullScanline(hull, width, height);

  // Create hole mask: holes are transparent pixels INSIDE the convex hull
  const holeMask = new Uint8Array(totalPixels);
  let holeCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    // Pixel is a hole if: transparent AND inside convex hull
    if (isTransparent(i) && hullInterior[i] === 255) {
      holeMask[i] = 255;
      holeCount++;
    }
  }

  return { holeCount, totalPixels, opaquePixels, holeMask, width, height };
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

    // Use metadata.frames as primary source, fall back to legacy fields
    const inputFrames = data.metadata?.frames || data.recommendedFrames || data.frames;
    if (!inputFrames || inputFrames.length === 0) {
      return { success: false, error: 'No frames to process for hole filling' };
    }

    // Configurable options
    const alphaThreshold = (options?.alphaThreshold as number) ?? 10;
    // Minimum hole percentage relative to product area (default 0.01% = very sensitive)
    const minHolePercentage = (options?.minHolePercentage as number) ?? 0.01;
    // Minimum absolute hole pixel count to trigger inpainting (default 100 pixels)
    // This catches significant holes even in very large images where percentage is tiny
    const minHolePixels = (options?.minHolePixels as number) ?? 100;
    // Target number of boundary points for convex hull computation (higher = more accurate, slower)
    const boundarySampleTarget = (options?.boundarySampleTarget as number) ?? DEFAULT_BOUNDARY_SAMPLE_TARGET;

    logger.info({ jobId, frameCount: inputFrames.length, alphaThreshold, minHolePercentage, minHolePixels }, 'Detecting and filling product holes');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 66,
      message: 'Detecting product holes',
    });

    const updatedFrames: FrameMetadata[] = [];
    let totalHolesFilled = 0;

    for (let i = 0; i < inputFrames.length; i++) {
      const frame = inputFrames[i];
      const progress = 66 + Math.round(((i + 1) / inputFrames.length) * 4);

      await onProgress?.({
        status: JobStatus.EXTRACTING_PRODUCT,
        percentage: progress,
        message: `Checking holes ${i + 1}/${inputFrames.length}`,
      });

      try {
        // Detect holes using convex hull algorithm
        const { holeCount, opaquePixels, holeMask, width, height } = await timer.timeOperation(
          'detect_holes',
          () => detectHoles(frame.path, alphaThreshold, boundarySampleTarget),
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
          }, 'Filling product holes with Stability AI inpainting');

          // Create mask image (white = inpaint, black = preserve)
          // Stability AI expects: white pixels = areas to fill, black = preserve
          const maskPath = path.join(workDirs.extracted, `${frame.frameId}_mask.png`);
          await sharp(Buffer.from(holeMask), {
            raw: { width, height, channels: 1 },
          })
            .png()
            .toFile(maskPath);

          logger.debug({ frameId: frame.frameId, maskPath }, 'Hole mask created for inpainting');

          const outputPath = path.join(workDirs.extracted, `${frame.frameId}_filled.png`);
          const inpaintPrompt = (options?.inpaintPrompt as string) ??
            'Seamlessly fill in the missing parts of this product. Reconstruct the product to look complete, natural, and photorealistic. Match the exact texture, color, material, and style of the surrounding product areas.';
          const debugMode = (options?.debug as boolean) ?? false;

          try {
            const inpaintResult = await timer.timeOperation(
              'inpaint_holes',
              () => stabilityService.inpaintHoles(frame.path, maskPath, outputPath, {
                prompt: inpaintPrompt,
                debug: debugMode,
                cleanup: !debugMode,
              }),
              { frameId: frame.frameId }
            );

            if (inpaintResult.success) {
              logger.info({ frameId: frame.frameId, outputPath }, 'Holes filled successfully');
              updatedFrames.push({ ...frame, path: outputPath });
              totalHolesFilled++;

              // Clean up the mask file (unless in debug mode)
              if (!debugMode) {
                await safeUnlink(maskPath);
              }
            } else {
              logger.warn({ frameId: frame.frameId, error: inpaintResult.error }, 'Hole filling failed, keeping original');
              updatedFrames.push(frame);

              // Clean up mask on failure too
              if (!debugMode) {
                await safeUnlink(maskPath);
              }
            }
          } catch (inpaintError) {
            logger.warn({ frameId: frame.frameId, error: (inpaintError as Error).message }, 'Hole filling failed, keeping original');
            updatedFrames.push(frame);

            // Clean up mask on error
            if (!debugMode) {
              await safeUnlink(maskPath);
            }
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

    logger.info({ jobId, totalHolesFilled, totalFrames: inputFrames.length }, 'Product hole filling complete');

    return {
      success: true,
      data: {
        images: updatedFrames.map((f) => f.path),
        // Legacy field for backwards compatibility
        recommendedFrames: updatedFrames,
        // New unified metadata
        metadata: {
          ...data.metadata,
          frames: updatedFrames,
        },
      },
    };
  },
};

/**
 * Detect Holes Debug Processor
 *
 * Debug processor that detects holes using CONVEX HULL approach
 * and outputs the mask as a separate image for visualization.
 */

import path from 'path';
import sharp from 'sharp';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:detect-holes-debug' });

/**
 * Point type for convex hull computation
 */
interface Point {
  x: number;
  y: number;
}

/**
 * Compute cross product of vectors OA and OB where O is origin
 */
function crossProduct(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Compute convex hull using Andrew's monotone chain algorithm
 */
function computeConvexHull(points: Point[]): Point[] {
  if (points.length < 3) return points;

  points.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);

  const lower: Point[] = [];
  for (const p of points) {
    while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

/**
 * Check if a point is inside a convex polygon
 */
function isPointInConvexHull(point: Point, hull: Point[]): boolean {
  if (hull.length < 3) return false;

  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const cross = crossProduct(a, b, point);

    if (cross !== 0) {
      if (sign === 0) {
        sign = cross > 0 ? 1 : -1;
      } else if ((cross > 0 ? 1 : -1) !== sign) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Detect holes using convex hull approach
 */
async function detectHolesDebug(
  imagePath: string,
  alphaThreshold: number
): Promise<{
  holeCount: number;
  backgroundCount: number;
  opaqueCount: number;
  totalPixels: number;
  holeMask: Uint8Array;
  backgroundMask: Uint8Array;
  hullMask: Uint8Array;
  hull: Point[];
  width: number;
  height: number;
}> {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error('Could not get image dimensions');
  }

  const totalPixels = width * height;

  // Extract alpha channel
  const { data: rawData } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaData = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaData[i] = rawData[i * 4 + 3];
  }

  const isTransparent = (idx: number): boolean => alphaData[idx] <= alphaThreshold;
  const getIdx = (y: number, x: number): number => y * width + x;

  // Collect boundary points (opaque pixels adjacent to transparent)
  const boundaryPoints: Point[] = [];
  let opaqueCount = 0;

  // Sample every Nth pixel for hull computation
  const sampleRate = Math.max(1, Math.floor(Math.min(width, height) / 500));

  for (let y = 0; y < height; y += sampleRate) {
    for (let x = 0; x < width; x += sampleRate) {
      const idx = getIdx(y, x);
      if (!isTransparent(idx)) {
        // Check if boundary pixel
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

  // Count all opaque pixels
  for (let i = 0; i < totalPixels; i++) {
    if (!isTransparent(i)) {
      opaqueCount++;
    }
  }

  logger.info({ boundaryPoints: boundaryPoints.length, sampleRate }, 'Collected boundary points');

  // Compute convex hull
  const hull = computeConvexHull(boundaryPoints);
  logger.info({ hullPoints: hull.length }, 'Computed convex hull');

  // Create hull visualization mask
  const hullMask = new Uint8Array(totalPixels);

  // Find bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of hull) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  // Fill hull mask - mark all pixels inside hull
  if (hull.length >= 3) {
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(height - 1, Math.ceil(maxY)); y++) {
      for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(width - 1, Math.ceil(maxX)); x++) {
        if (isPointInConvexHull({ x, y }, hull)) {
          hullMask[getIdx(y, x)] = 255;
        }
      }
    }
  }

  // Create hole and background masks
  const holeMask = new Uint8Array(totalPixels);
  const backgroundMask = new Uint8Array(totalPixels);
  let holeCount = 0;
  let backgroundCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    if (isTransparent(i)) {
      if (hullMask[i] === 255) {
        // Inside hull = hole
        holeMask[i] = 255;
        holeCount++;
      } else {
        // Outside hull = background
        backgroundMask[i] = 255;
        backgroundCount++;
      }
    }
  }

  return {
    holeCount,
    backgroundCount,
    opaqueCount,
    totalPixels,
    holeMask,
    backgroundMask,
    hullMask,
    hull,
    width,
    height,
  };
}

export const detectHolesDebugProcessor: Processor = {
  id: 'detect-holes-debug',
  displayName: 'Detect Holes (Debug)',
  statusKey: JobStatus.EXTRACTING_PRODUCT,
  io: {
    requires: ['images'],
    produces: ['images'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress } = context;

    // Accept either frames or just image paths
    const images = data.images || [];
    if (images.length === 0) {
      return { success: false, error: 'No images to process' };
    }

    // Build frames from images if not provided
    const frames = data.frames || images.map((imgPath, idx) => ({
      frameId: `frame-${String(idx + 1).padStart(3, '0')}`,
      filename: imgPath.split('/').pop() || `image-${idx}.png`,
      path: imgPath,
      timestamp: 0,
      index: idx,
    }));

    const alphaThreshold = (options?.alphaThreshold as number) ?? 10;

    logger.info({ jobId, frameCount: frames.length, alphaThreshold }, 'Debug: Detecting holes (convex hull method)');

    await onProgress?.({
      status: JobStatus.EXTRACTING_PRODUCT,
      percentage: 50,
      message: 'Debug: Detecting holes (convex hull)',
    });

    for (const frame of frames) {
      const result = await detectHolesDebug(frame.path, alphaThreshold);

      logger.info({
        frameId: frame.frameId,
        holeCount: result.holeCount,
        backgroundCount: result.backgroundCount,
        opaqueCount: result.opaqueCount,
        totalPixels: result.totalPixels,
        hullPoints: result.hull.length,
        holePercentage: ((result.holeCount / result.opaqueCount) * 100).toFixed(4) + '%',
      }, 'Hole detection results (convex hull)');

      // Save hole mask (white = hole)
      const holeMaskPath = path.join(workDirs.extracted, `${frame.frameId}_holes.png`);
      await sharp(Buffer.from(result.holeMask), {
        raw: { width: result.width, height: result.height, channels: 1 },
      })
        .png()
        .toFile(holeMaskPath);

      // Save background mask (white = background)
      const bgMaskPath = path.join(workDirs.extracted, `${frame.frameId}_background.png`);
      await sharp(Buffer.from(result.backgroundMask), {
        raw: { width: result.width, height: result.height, channels: 1 },
      })
        .png()
        .toFile(bgMaskPath);

      // Save hull mask (white = inside convex hull)
      const hullMaskPath = path.join(workDirs.extracted, `${frame.frameId}_hull.png`);
      await sharp(Buffer.from(result.hullMask), {
        raw: { width: result.width, height: result.height, channels: 1 },
      })
        .png()
        .toFile(hullMaskPath);

      // Create composite visualization: Red=holes, Green=product, Blue=background
      const visualRgb = Buffer.alloc(result.totalPixels * 3);
      for (let i = 0; i < result.totalPixels; i++) {
        if (result.holeMask[i] === 255) {
          // Holes = Red
          visualRgb[i * 3] = 255;
          visualRgb[i * 3 + 1] = 0;
          visualRgb[i * 3 + 2] = 0;
        } else if (result.backgroundMask[i] === 255) {
          // Background = Blue
          visualRgb[i * 3] = 0;
          visualRgb[i * 3 + 1] = 0;
          visualRgb[i * 3 + 2] = 255;
        } else {
          // Product (opaque) = Green
          visualRgb[i * 3] = 0;
          visualRgb[i * 3 + 1] = 255;
          visualRgb[i * 3 + 2] = 0;
        }
      }

      const visualPath = path.join(workDirs.extracted, `${frame.frameId}_visual.png`);
      await sharp(visualRgb, {
        raw: { width: result.width, height: result.height, channels: 3 },
      })
        .png()
        .toFile(visualPath);

      logger.info({
        frameId: frame.frameId,
        holeMaskPath,
        bgMaskPath,
        hullMaskPath,
        visualPath,
      }, 'Debug masks saved');
    }

    return {
      success: true,
      data: {
        images: frames.map((f) => f.path),
        recommendedFrames: frames,
      },
    };
  },
};

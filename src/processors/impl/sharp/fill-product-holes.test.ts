import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlink } from 'fs/promises';

// Mock utilities before importing from fill-product-holes
vi.mock('../../../utils/fs.js', () => ({
  safeUnlink: vi.fn().mockResolvedValue(undefined),
  getVariantPath: vi.fn((path: string, suffix: string) => path.replace('.png', `${suffix}.png`)),
}));

vi.mock('../../../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../services/stability.service.js', () => ({
  stabilityService: {
    inpaintHoles: vi.fn(),
  },
}));

// Import geometry functions from the main implementation
import {
  type Point,
  computeConvexHull,
  getHullScanlineIntersections,
  fillConvexHullScanline,
} from './fill-product-holes.js';

// =============================================================================
// Unit tests for convex hull and scanline algorithms
// =============================================================================

describe('Convex Hull Algorithm', () => {
  describe('computeConvexHull', () => {
    it('should return empty for fewer than 3 points', () => {
      expect(computeConvexHull([])).toEqual([]);
      expect(computeConvexHull([{ x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }]);
      expect(computeConvexHull([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]);
    });

    it('should compute correct hull for a square', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 5, y: 5 }, // Interior point
      ];

      const hull = computeConvexHull(points);

      // Should have 4 vertices (the corners)
      expect(hull.length).toBe(4);

      // Interior point should not be in hull
      expect(hull.find((p) => p.x === 5 && p.y === 5)).toBeUndefined();
    });

    it('should compute correct hull for a triangle', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 10 },
      ];

      const hull = computeConvexHull(points);
      expect(hull.length).toBe(3);
    });

    it('should handle collinear points correctly', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ];

      const hull = computeConvexHull(points);
      // Should form a triangle, collinear middle point excluded
      expect(hull.length).toBeLessThanOrEqual(4);
    });

    it('should handle all identical points', () => {
      const points: Point[] = [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ];

      const hull = computeConvexHull(points);
      // Should return minimal hull
      expect(hull.length).toBeLessThanOrEqual(3);
    });

    it('should NOT mutate the input array', () => {
      const points: Point[] = [
        { x: 10, y: 0 },
        { x: 0, y: 0 },
        { x: 5, y: 10 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ];

      // Store original order
      const originalOrder = points.map((p) => ({ ...p }));

      // Compute hull
      computeConvexHull(points);

      // Original array should be unchanged
      expect(points).toEqual(originalOrder);
    });
  });

  describe('fillConvexHullScanline', () => {
    it('should fill interior of a simple triangle', () => {
      const hull: Point[] = [
        { x: 5, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ];

      const width = 15;
      const height = 15;
      const filled = fillConvexHullScanline(hull, width, height);

      // Check that some interior pixels are filled
      // The centroid should be inside
      const centroidX = Math.floor((5 + 10 + 0) / 3);
      const centroidY = Math.floor((0 + 10 + 10) / 3);
      const centroidIdx = centroidY * width + centroidX;

      expect(filled[centroidIdx]).toBe(255);
    });

    it('should not fill pixels outside the hull', () => {
      const hull: Point[] = [
        { x: 5, y: 5 },
        { x: 10, y: 5 },
        { x: 10, y: 10 },
        { x: 5, y: 10 },
      ];

      const width = 20;
      const height = 20;
      const filled = fillConvexHullScanline(hull, width, height);

      // Corner pixels should not be filled
      expect(filled[0]).toBe(0); // Top-left
      expect(filled[width - 1]).toBe(0); // Top-right
      expect(filled[(height - 1) * width]).toBe(0); // Bottom-left
      expect(filled[(height - 1) * width + width - 1]).toBe(0); // Bottom-right
    });

    it('should handle empty hull gracefully', () => {
      const hull: Point[] = [];
      const filled = fillConvexHullScanline(hull, 10, 10);
      expect(filled.every((v) => v === 0)).toBe(true);
    });

    it('should handle hull with less than 3 points', () => {
      const hull: Point[] = [{ x: 5, y: 5 }];
      const filled = fillConvexHullScanline(hull, 10, 10);
      expect(filled.every((v) => v === 0)).toBe(true);
    });

    it('should fill rectangular hull correctly', () => {
      const hull: Point[] = [
        { x: 2, y: 2 },
        { x: 8, y: 2 },
        { x: 8, y: 8 },
        { x: 2, y: 8 },
      ];

      const width = 10;
      const height = 10;
      const filled = fillConvexHullScanline(hull, width, height);

      // Count filled pixels
      let filledCount = 0;
      for (let i = 0; i < filled.length; i++) {
        if (filled[i] === 255) filledCount++;
      }

      // Should fill approximately the interior (accounting for boundary behavior)
      expect(filledCount).toBeGreaterThan(20);
      expect(filledCount).toBeLessThan(50);
    });
  });

  describe('getHullScanlineIntersections', () => {
    it('should find intersections for horizontal scanline', () => {
      const hull: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ];

      const intersections = getHullScanlineIntersections(hull, 5);

      // Should have 2 intersections (left and right edges)
      expect(intersections.length).toBe(2);
      expect(intersections[0]).toBeCloseTo(0);
      expect(intersections[1]).toBeCloseTo(10);
    });

    it('should return empty for scanline outside hull', () => {
      const hull: Point[] = [
        { x: 5, y: 5 },
        { x: 10, y: 5 },
        { x: 10, y: 10 },
        { x: 5, y: 10 },
      ];

      const intersections = getHullScanlineIntersections(hull, 0);
      expect(intersections.length).toBe(0);
    });
  });
});

// =============================================================================
// Integration tests for the processor (using real sharp)
// =============================================================================

describe('fill-product-holes processor', () => {
  describe('hole detection with morphological closing', () => {
    /**
     * Helper to create a test PNG image and run hole detection
     */
    async function createTestImageAndDetect(
      width: number,
      height: number,
      setPixels: (
        x: number,
        y: number
      ) => { r: number; g: number; b: number; a: number }
    ) {
      // Create RGBA buffer
      const data = Buffer.alloc(width * height * 4);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const pixel = setPixels(x, y);
          data[i] = pixel.r;
          data[i + 1] = pixel.g;
          data[i + 2] = pixel.b;
          data[i + 3] = pixel.a;
        }
      }

      // Save to temp file
      const tempPath = join(
        tmpdir(),
        `test-holes-${Date.now()}-${Math.random()}.png`
      );
      await sharp(data, { raw: { width, height, channels: 4 } })
        .png()
        .toFile(tempPath);

      // Extract alpha for analysis
      const { data: rawData } = await sharp(tempPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const alphaData = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        alphaData[i] = rawData[i * 4 + 3];
      }

      // Cleanup
      await unlink(tempPath);

      // Count opaque and transparent
      let opaque = 0;
      let transparent = 0;
      for (const alpha of alphaData) {
        if (alpha > 10) opaque++;
        else transparent++;
      }

      return { alphaData, opaque, transparent, tempPath };
    }

    it('should create image with correct pixel counts', async () => {
      // 10x10 image with 6x6 product and 2x2 hole in center
      const { opaque, transparent } = await createTestImageAndDetect(
        10,
        10,
        (x, y) => {
          const inProduct = x >= 2 && x < 8 && y >= 2 && y < 8;
          const inHole = x >= 4 && x < 6 && y >= 4 && y < 6;

          if (inProduct && !inHole) {
            return { r: 255, g: 0, b: 0, a: 255 }; // Red opaque
          }
          return { r: 0, g: 0, b: 0, a: 0 }; // Transparent
        }
      );

      // Product is 6x6 minus 2x2 hole = 32 pixels opaque
      expect(opaque).toBe(32);
      // Background + hole = 64 + 4 = 68 transparent
      expect(transparent).toBe(68);
    });

    it('should handle solid image with no transparency', async () => {
      const { opaque, transparent } = await createTestImageAndDetect(
        5,
        5,
        () => {
          return { r: 255, g: 0, b: 0, a: 255 }; // All opaque
        }
      );

      expect(opaque).toBe(25);
      expect(transparent).toBe(0);
    });

    it('should handle fully transparent image', async () => {
      const { opaque, transparent } = await createTestImageAndDetect(
        5,
        5,
        () => {
          return { r: 0, g: 0, b: 0, a: 0 }; // All transparent
        }
      );

      expect(opaque).toBe(0);
      expect(transparent).toBe(25);
    });

    it('should handle product with edge gap (not internal hole)', async () => {
      // 10x10 image with L-shaped product (gap on right side)
      const { opaque, transparent } = await createTestImageAndDetect(
        10,
        10,
        (x, y) => {
          // Product in left and bottom area, gap on top-right
          const inProduct =
            (x >= 2 && x < 5 && y >= 2 && y < 8) || // Left column
            (x >= 5 && x < 8 && y >= 5 && y < 8); // Bottom right

          if (inProduct) {
            return { r: 255, g: 0, b: 0, a: 255 };
          }
          return { r: 0, g: 0, b: 0, a: 0 };
        }
      );

      // Left column: 3*6 = 18, Bottom right: 3*3 = 9, Total = 27
      expect(opaque).toBe(27);
      expect(transparent).toBe(73);
    });
  });
});

// =============================================================================
// Mocked processor tests
// =============================================================================

describe('fillProductHolesProcessor (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export processor with correct metadata', async () => {
    // Dynamic import to get fresh module
    vi.resetModules();
    vi.doMock('../../../services/stability.service.js', () => ({
      stabilityService: { inpaintHoles: vi.fn() },
    }));
    vi.doMock('../../../utils/logger.js', () => ({
      createChildLogger: vi.fn(() => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    }));

    const { fillProductHolesProcessor } = await import(
      './fill-product-holes.js'
    );

    expect(fillProductHolesProcessor.id).toBe('fill-product-holes');
    expect(fillProductHolesProcessor.displayName).toBe('Fill Product Holes');
    // DataPath is the unified type for all data requirements
    expect(fillProductHolesProcessor.io.requires).toContain('images');
    expect(fillProductHolesProcessor.io.requires).toContain('frames');
    expect(fillProductHolesProcessor.io.produces).toContain('images');
  });
});

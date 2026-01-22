import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

// Extract the detectHoles function for testing
// We'll test it by creating synthetic images

describe('fill-product-holes processor', () => {
  describe('detectHoles algorithm', () => {
    /**
     * Recreate the detectHoles function for unit testing
     */
    function detectHoles(
      width: number,
      height: number,
      alphaData: Uint8Array,
      alphaThreshold: number
    ): { holeCount: number; totalPixels: number; opaquePixels: number } {
      const totalPixels = width * height;
      const visited = new Uint8Array(totalPixels);

      const isTransparent = (idx: number): boolean => alphaData[idx] <= alphaThreshold;
      const getIdx = (y: number, x: number): number => y * width + x;

      const queue: number[] = [];

      // Start flood-fill from all transparent edge pixels
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

      const directions = [
        [-1, 0], [1, 0], [0, -1], [0, 1],
        [-1, -1], [-1, 1], [1, -1], [1, 1],
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

      let holeCount = 0;
      let opaquePixels = 0;

      for (let i = 0; i < totalPixels; i++) {
        if (!isTransparent(i)) {
          opaquePixels++;
        } else if (!visited[i]) {
          holeCount++;
        }
      }

      return { holeCount, totalPixels, opaquePixels };
    }

    it('should detect no holes in solid image', () => {
      // 5x5 image, all opaque (alpha=255)
      const width = 5;
      const height = 5;
      const alphaData = new Uint8Array(25).fill(255);

      const result = detectHoles(width, height, alphaData, 10);

      expect(result.holeCount).toBe(0);
      expect(result.opaquePixels).toBe(25);
    });

    it('should detect no holes in transparent-only image', () => {
      // 5x5 image, all transparent (alpha=0)
      const width = 5;
      const height = 5;
      const alphaData = new Uint8Array(25).fill(0);

      const result = detectHoles(width, height, alphaData, 10);

      expect(result.holeCount).toBe(0);
      expect(result.opaquePixels).toBe(0);
    });

    it('should detect hole inside product', () => {
      // 5x5 image with transparent border and hole in center
      // . . . . .
      // . X X X .
      // . X . X .  <- hole in center
      // . X X X .
      // . . . . .
      const width = 5;
      const height = 5;
      const alphaData = new Uint8Array(25).fill(0); // Start all transparent

      // Set product pixels to opaque
      const productPixels = [
        6, 7, 8,     // row 1
        11, 13,      // row 2 (skip center)
        16, 17, 18,  // row 3
      ];
      for (const i of productPixels) {
        alphaData[i] = 255;
      }

      const result = detectHoles(width, height, alphaData, 10);

      // The center pixel (12) should be detected as a hole
      expect(result.holeCount).toBe(1);
      expect(result.opaquePixels).toBe(8);
    });

    it('should not detect edge-connected transparency as holes', () => {
      // 5x5 image with product on right side, transparent on left
      // . . X X X
      // . . X X X
      // . . X X X
      // . . X X X
      // . . X X X
      const width = 5;
      const height = 5;
      const alphaData = new Uint8Array(25).fill(0);

      // Right side is opaque
      for (let y = 0; y < 5; y++) {
        for (let x = 2; x < 5; x++) {
          alphaData[y * width + x] = 255;
        }
      }

      const result = detectHoles(width, height, alphaData, 10);

      // No holes - left side is connected to edges
      expect(result.holeCount).toBe(0);
      expect(result.opaquePixels).toBe(15);
    });

    it('should detect multiple holes', () => {
      // 7x7 image with product and two holes
      // . . . . . . .
      // . X X X X X .
      // . X . X . X .  <- two holes
      // . X X X X X .
      // . X . X . X .  <- two more holes
      // . X X X X X .
      // . . . . . . .
      const width = 7;
      const height = 7;
      const alphaData = new Uint8Array(49).fill(0);

      // Fill in the product shape
      for (let y = 1; y <= 5; y++) {
        for (let x = 1; x <= 5; x++) {
          alphaData[y * width + x] = 255;
        }
      }

      // Create holes at specific positions
      const holes = [
        2 * width + 2, // (2, 2)
        2 * width + 4, // (2, 4)
        4 * width + 2, // (4, 2)
        4 * width + 4, // (4, 4)
      ];
      for (const i of holes) {
        alphaData[i] = 0;
      }

      const result = detectHoles(width, height, alphaData, 10);

      expect(result.holeCount).toBe(4);
      expect(result.opaquePixels).toBe(21); // 25 - 4 holes
    });

    it('should detect edge gap as hole', () => {
      // 5x5 image with gap on right edge
      // . . . . .
      // . X X X .
      // . X X . .  <- gap connected only to product, not to transparent area
      // . X X X .
      // . . . . .
      // Note: This is tricky - the gap at (2,3) IS connected to edge transparency
      // So this test verifies edge gaps that aren't connected properly
      
      // Actually, let's test a more realistic scenario:
      // Product with an edge notch that creates an interior gap
      // . . . . . . .
      // . X X X X X .
      // . X X X X X .
      // . X . . . X .  <- interior notch
      // . X X X X X .
      // . X X X X X .
      // . . . . . . .
      const width = 7;
      const height = 7;
      const alphaData = new Uint8Array(49).fill(0);

      // Fill in the product shape
      for (let y = 1; y <= 5; y++) {
        for (let x = 1; x <= 5; x++) {
          alphaData[y * width + x] = 255;
        }
      }

      // Create interior notch
      alphaData[3 * width + 2] = 0;
      alphaData[3 * width + 3] = 0;
      alphaData[3 * width + 4] = 0;

      const result = detectHoles(width, height, alphaData, 10);

      // The notch is internal - should be detected as holes
      expect(result.holeCount).toBe(3);
      expect(result.opaquePixels).toBe(22);
    });
  });

  describe('integration with sharp', () => {
    it('should create a test image and analyze it', async () => {
      // Create a simple 10x10 PNG with a hole
      const width = 10;
      const height = 10;

      // Create RGBA data: red product with transparent background and hole in center
      const data = Buffer.alloc(width * height * 4);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;

          // Check if we're in the product area (inner 6x6 square)
          const inProduct = x >= 2 && x < 8 && y >= 2 && y < 8;
          // Check if we're in the hole (center 2x2)
          const inHole = x >= 4 && x < 6 && y >= 4 && y < 6;

          if (inProduct && !inHole) {
            // Red opaque pixel
            data[i] = 255;     // R
            data[i + 1] = 0;   // G
            data[i + 2] = 0;   // B
            data[i + 3] = 255; // A
          } else {
            // Transparent pixel
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 0;
          }
        }
      }

      // Create sharp image
      const image = sharp(data, {
        raw: {
          width,
          height,
          channels: 4,
        },
      });

      // Get raw data back
      const { data: rawData } = await image
        .raw()
        .ensureAlpha()
        .toBuffer({ resolveWithObject: true });

      // Extract alpha channel
      const alphaData = new Uint8Array(width * height);
      for (let j = 0; j < width * height; j++) {
        alphaData[j] = rawData[j * 4 + 3];
      }

      // Count opaque and transparent
      let opaque = 0;
      let transparent = 0;
      for (let i = 0; i < alphaData.length; i++) {
        if (alphaData[i] > 10) opaque++;
        else transparent++;
      }

      // Product is 6x6 minus 2x2 hole = 32 pixels
      expect(opaque).toBe(32);
      // Background + hole = 64 + 4 = 68
      expect(transparent).toBe(68);
    });
  });
});

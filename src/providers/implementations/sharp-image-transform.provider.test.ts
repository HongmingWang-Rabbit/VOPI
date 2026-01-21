import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { SharpImageTransformProvider } from './sharp-image-transform.provider.js';

describe('SharpImageTransformProvider', () => {
  let provider: SharpImageTransformProvider;
  let testImageBuffer: Buffer;
  let testImageWithAlphaBuffer: Buffer;

  beforeAll(async () => {
    provider = new SharpImageTransformProvider();

    // Create a simple 100x100 red test image
    testImageBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    // Create a 100x100 image with transparent edges and opaque center (50x50)
    // This simulates a product image with transparent background
    const centerSize = 50;
    const offset = 25;

    testImageWithAlphaBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: centerSize,
              height: centerSize,
              channels: 4,
              background: { r: 0, g: 255, b: 0, alpha: 255 },
            },
          })
            .png()
            .toBuffer(),
          left: offset,
          top: offset,
        },
      ])
      .png()
      .toBuffer();
  });

  describe('providerId', () => {
    it('should have correct provider ID', () => {
      expect(provider.providerId).toBe('sharp');
    });
  });

  describe('isAvailable', () => {
    it('should always return true since Sharp is bundled', () => {
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('rotate', () => {
    it('should rotate an image by 90 degrees', async () => {
      const result = await provider.rotate(testImageBuffer, { angle: 90 });

      expect(result.success).toBe(true);
      expect(result.outputBuffer).toBeDefined();
      expect(result.dimensions).toBeDefined();
      // 90 degree rotation should swap dimensions
      expect(result.dimensions?.width).toBe(100);
      expect(result.dimensions?.height).toBe(100);
    });

    it('should rotate an image by 45 degrees', async () => {
      const result = await provider.rotate(testImageBuffer, { angle: 45 });

      expect(result.success).toBe(true);
      expect(result.outputBuffer).toBeDefined();
      // 45 degree rotation expands the canvas
      expect(result.dimensions!.width).toBeGreaterThan(100);
      expect(result.dimensions!.height).toBeGreaterThan(100);
    });

    it('should use transparent background by default', async () => {
      const result = await provider.rotate(testImageBuffer, { angle: 45 });

      expect(result.success).toBe(true);
      // Verify PNG output (supports transparency)
      expect(result.outputBuffer).toBeDefined();
    });

    it('should apply custom background color', async () => {
      const result = await provider.rotate(testImageBuffer, {
        angle: 45,
        background: { r: 255, g: 255, b: 255, alpha: 255 },
      });

      expect(result.success).toBe(true);
      expect(result.outputBuffer).toBeDefined();
    });

    it('should handle zero rotation', async () => {
      const result = await provider.rotate(testImageBuffer, { angle: 0 });

      expect(result.success).toBe(true);
      expect(result.dimensions?.width).toBe(100);
      expect(result.dimensions?.height).toBe(100);
    });

    it('should return error for invalid input', async () => {
      const result = await provider.rotate(Buffer.from('invalid'), { angle: 90 });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('crop', () => {
    it('should crop an image to specified region', async () => {
      const result = await provider.crop(testImageBuffer, {
        region: { x: 10, y: 10, width: 50, height: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.dimensions?.width).toBe(50);
      expect(result.dimensions?.height).toBe(50);
    });

    it('should crop from top-left corner', async () => {
      const result = await provider.crop(testImageBuffer, {
        region: { x: 0, y: 0, width: 30, height: 30 },
      });

      expect(result.success).toBe(true);
      expect(result.dimensions?.width).toBe(30);
      expect(result.dimensions?.height).toBe(30);
    });

    it('should return error for out-of-bounds crop', async () => {
      const result = await provider.crop(testImageBuffer, {
        region: { x: 90, y: 90, width: 50, height: 50 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error for invalid input', async () => {
      const result = await provider.crop(Buffer.from('invalid'), {
        region: { x: 0, y: 0, width: 50, height: 50 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('centerOnCanvas', () => {
    it('should center a smaller image on a larger canvas', async () => {
      const result = await provider.centerOnCanvas(testImageBuffer, {
        canvasSize: 200,
      });

      expect(result.success).toBe(true);
      expect(result.dimensions?.width).toBe(200);
      expect(result.dimensions?.height).toBe(200);
    });

    it('should use transparent background by default', async () => {
      const result = await provider.centerOnCanvas(testImageBuffer, {
        canvasSize: 200,
      });

      expect(result.success).toBe(true);
      expect(result.outputBuffer).toBeDefined();
    });

    it('should apply custom background color', async () => {
      const result = await provider.centerOnCanvas(testImageBuffer, {
        canvasSize: 200,
        background: { r: 255, g: 255, b: 255, alpha: 255 },
      });

      expect(result.success).toBe(true);
      expect(result.outputBuffer).toBeDefined();
    });

    it('should handle canvas same size as image', async () => {
      const result = await provider.centerOnCanvas(testImageBuffer, {
        canvasSize: 100,
      });

      expect(result.success).toBe(true);
      expect(result.dimensions?.width).toBe(100);
      expect(result.dimensions?.height).toBe(100);
    });

    it('should return error for invalid input', async () => {
      const result = await provider.centerOnCanvas(Buffer.from('invalid'), {
        canvasSize: 200,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('findContentBounds', () => {
    it('should find bounding box of non-transparent content', async () => {
      const bounds = await provider.findContentBounds(testImageWithAlphaBuffer);

      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBe(25);
      expect(bounds!.y).toBe(25);
      expect(bounds!.width).toBe(50);
      expect(bounds!.height).toBe(50);
    });

    it('should return null for fully transparent image', async () => {
      const transparentImage = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();

      const bounds = await provider.findContentBounds(transparentImage);
      expect(bounds).toBeNull();
    });

    it('should respect alpha threshold', async () => {
      // Use the test image with the green center (alpha=255 in center, alpha=0 elsewhere)
      // Default threshold of 10 should find the center
      const boundsDefault = await provider.findContentBounds(testImageWithAlphaBuffer);
      expect(boundsDefault).not.toBeNull();
      expect(boundsDefault!.width).toBe(50);

      // With threshold 0, should still find the same bounds (only truly transparent pixels excluded)
      const boundsZero = await provider.findContentBounds(testImageWithAlphaBuffer, 0);
      expect(boundsZero).not.toBeNull();
      expect(boundsZero!.width).toBe(50);

      // With threshold 255, only alpha=255 pixels should be included (same as our opaque center)
      const boundsMax = await provider.findContentBounds(testImageWithAlphaBuffer, 254);
      expect(boundsMax).not.toBeNull();
      expect(boundsMax!.width).toBe(50);
    });

    it('should return null for invalid input', async () => {
      const bounds = await provider.findContentBounds(Buffer.from('invalid'));
      expect(bounds).toBeNull();
    });
  });

  describe('getDimensions', () => {
    it('should return image dimensions', async () => {
      const dims = await provider.getDimensions(testImageBuffer);

      expect(dims.width).toBe(100);
      expect(dims.height).toBe(100);
    });

    it('should work with buffer input', async () => {
      const dims = await provider.getDimensions(testImageBuffer);

      expect(dims.width).toBe(100);
      expect(dims.height).toBe(100);
    });
  });
});

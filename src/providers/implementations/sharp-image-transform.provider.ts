import sharp from 'sharp';
import type {
  ImageTransformProvider,
  ImageTransformResult,
  RotationOptions,
  CropOptions,
  CenterOptions,
  BoundingBox,
  ImageDimensions,
} from '../interfaces/image-transform.provider.js';

/**
 * Sharp Image Transform Provider
 *
 * Uses Sharp (libvips) for high-performance image manipulation.
 */
export class SharpImageTransformProvider implements ImageTransformProvider {
  readonly providerId = 'sharp';

  async rotate(
    input: string | Buffer,
    options: RotationOptions
  ): Promise<ImageTransformResult> {
    try {
      const { angle, background = { r: 0, g: 0, b: 0, alpha: 0 } } = options;

      const result = await sharp(input)
        .rotate(angle, { background })
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        success: true,
        outputBuffer: result.data,
        dimensions: {
          width: result.info.width,
          height: result.info.height,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async crop(
    input: string | Buffer,
    options: CropOptions
  ): Promise<ImageTransformResult> {
    try {
      const { region } = options;

      const result = await sharp(input)
        .extract({
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height,
        })
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        success: true,
        outputBuffer: result.data,
        dimensions: {
          width: result.info.width,
          height: result.info.height,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async centerOnCanvas(
    input: string | Buffer,
    options: CenterOptions
  ): Promise<ImageTransformResult> {
    try {
      const { canvasSize, background = { r: 0, g: 0, b: 0, alpha: 0 } } = options;

      // Get input dimensions
      const inputMeta = await sharp(input).metadata();
      const inputWidth = inputMeta.width || 0;
      const inputHeight = inputMeta.height || 0;

      // Calculate offset to center
      const offsetX = Math.round((canvasSize - inputWidth) / 2);
      const offsetY = Math.round((canvasSize - inputHeight) / 2);

      // Get input buffer
      const inputBuffer = Buffer.isBuffer(input) ? input : await sharp(input).toBuffer();

      // Create canvas and composite
      const result = await sharp({
        create: {
          width: canvasSize,
          height: canvasSize,
          channels: 4,
          background,
        },
      })
        .composite([
          {
            input: inputBuffer,
            left: Math.max(0, offsetX),
            top: Math.max(0, offsetY),
          },
        ])
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        success: true,
        outputBuffer: result.data,
        dimensions: {
          width: canvasSize,
          height: canvasSize,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async findContentBounds(
    input: string | Buffer,
    alphaThreshold = 10
  ): Promise<BoundingBox | null> {
    try {
      const image = sharp(input);
      const { width, height } = await image.metadata();

      if (!width || !height) {
        return null;
      }

      // Extract raw pixel data (RGBA)
      const { data } = await image
        .raw()
        .ensureAlpha()
        .toBuffer({ resolveWithObject: true });

      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;

      // Scan for non-transparent pixels
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const alpha = data[idx + 3];
          if (alpha > alphaThreshold) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }

      if (maxX <= minX || maxY <= minY) {
        return null;
      }

      return {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      };
    } catch {
      return null;
    }
  }

  async getDimensions(input: string | Buffer): Promise<ImageDimensions> {
    const metadata = await sharp(input).metadata();
    return {
      width: metadata.width || 0,
      height: metadata.height || 0,
    };
  }

  isAvailable(): boolean {
    // Sharp is bundled, always available
    return true;
  }
}

export const sharpImageTransformProvider = new SharpImageTransformProvider();

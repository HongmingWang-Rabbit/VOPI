import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import { createChildLogger } from '../../utils/logger.js';
import type {
  ProductExtractionProvider,
  ExtractionFrame,
  ProductExtractionResult,
  ProductExtractionOptions,
} from '../interfaces/product-extraction.provider.js';
import type { BackgroundRemovalProvider } from '../interfaces/background-removal.provider.js';
import type { ImageTransformProvider } from '../interfaces/image-transform.provider.js';

const logger = createChildLogger({ service: 'default-product-extraction' });

/**
 * Default Product Extraction Provider
 *
 * Composable provider that combines:
 * - Background removal (any BackgroundRemovalProvider)
 * - Image transformation (any ImageTransformProvider)
 *
 * This allows mixing and matching different providers for each step.
 */
export class DefaultProductExtractionProvider implements ProductExtractionProvider {
  readonly providerId = 'default';

  /** Default padding ratio around the product */
  private static readonly DEFAULT_PADDING = 0.05;
  /** Minimum output image size in pixels */
  private static readonly MIN_OUTPUT_SIZE = 512;
  /** Rotation threshold in degrees - angles below this are ignored */
  private static readonly ROTATION_THRESHOLD_DEG = 0.5;
  /** Alpha threshold for detecting non-transparent pixels (0-255) */
  private static readonly DEFAULT_ALPHA_THRESHOLD = 10;

  constructor(
    private backgroundRemovalProvider: BackgroundRemovalProvider,
    private imageTransformProvider: ImageTransformProvider
  ) {}

  async extractProduct(
    frame: ExtractionFrame,
    outputDir: string,
    options: ProductExtractionOptions = {}
  ): Promise<ProductExtractionResult> {
    const {
      useAIEdit = false,
      padding = DefaultProductExtractionProvider.DEFAULT_PADDING,
      minOutputSize = DefaultProductExtractionProvider.MIN_OUTPUT_SIZE,
      alphaThreshold = DefaultProductExtractionProvider.DEFAULT_ALPHA_THRESHOLD,
    } = options;

    const baseName = `${frame.recommendedType}_${frame.frameId}`;
    const outputPath = path.join(outputDir, `${baseName}_extracted.png`);
    const tempTransparentPath = path.join(outputDir, `${baseName}_temp_transparent.png`);

    try {
      logger.info(
        {
          frameId: frame.frameId,
          rotationAngle: frame.rotationAngleDeg,
          hasObstruction: frame.obstructions?.has_obstruction,
          providerId: this.providerId,
        },
        'Starting product extraction'
      );

      // Step 1: Remove background
      const bgRemovalResult = await this.backgroundRemovalProvider.removeBackground(
        frame.path,
        tempTransparentPath,
        {
          useAIEdit: useAIEdit && frame.obstructions?.has_obstruction,
          obstructions: frame.obstructions,
        }
      );

      if (!bgRemovalResult.success || !bgRemovalResult.outputPath) {
        return {
          success: false,
          rotationApplied: 0,
          error: bgRemovalResult.error || 'Background removal failed',
        };
      }

      // Step 2: Get original dimensions
      const originalSize = await this.imageTransformProvider.getDimensions(tempTransparentPath);

      // Step 3: Apply rotation if needed
      let imageBuffer: Buffer;
      const rotationAngle = frame.rotationAngleDeg || 0;

      if (Math.abs(rotationAngle) > DefaultProductExtractionProvider.ROTATION_THRESHOLD_DEG) {
        logger.info({ rotationAngle }, 'Applying rotation');
        const rotateResult = await this.imageTransformProvider.rotate(tempTransparentPath, {
          angle: rotationAngle,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        });

        if (!rotateResult.success || !rotateResult.outputBuffer) {
          return {
            success: false,
            rotationApplied: 0,
            error: rotateResult.error || 'Rotation failed',
          };
        }

        imageBuffer = rotateResult.outputBuffer;
      } else {
        const { default: sharp } = await import('sharp');
        imageBuffer = await sharp(tempTransparentPath).toBuffer();
      }

      // Step 4: Find bounding box of non-transparent pixels
      const boundingBox = await this.imageTransformProvider.findContentBounds(
        imageBuffer,
        alphaThreshold
      );

      if (!boundingBox) {
        logger.warn({ frameId: frame.frameId }, 'Could not find product bounding box, using full image');
        await writeFile(outputPath, imageBuffer);
        return {
          success: true,
          outputPath,
          rotationApplied: rotationAngle,
          originalSize,
        };
      }

      // Step 5: Crop to bounding box
      const cropResult = await this.imageTransformProvider.crop(imageBuffer, {
        region: boundingBox,
      });

      if (!cropResult.success || !cropResult.outputBuffer) {
        return {
          success: false,
          rotationApplied: rotationAngle,
          error: cropResult.error || 'Crop failed',
        };
      }

      // Step 6: Center on square canvas with padding
      const maxDim = Math.max(boundingBox.width, boundingBox.height);
      const paddingPixels = Math.round(maxDim * padding);
      const targetSize = Math.max(maxDim + paddingPixels * 2, minOutputSize);

      const centerResult = await this.imageTransformProvider.centerOnCanvas(cropResult.outputBuffer, {
        canvasSize: targetSize,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });

      if (!centerResult.success || !centerResult.outputBuffer) {
        return {
          success: false,
          rotationApplied: rotationAngle,
          error: centerResult.error || 'Centering failed',
        };
      }

      // Step 7: Write final output
      await writeFile(outputPath, centerResult.outputBuffer);

      logger.info(
        {
          frameId: frame.frameId,
          outputPath: path.basename(outputPath),
          rotationApplied: rotationAngle,
          boundingBox,
          finalSize: centerResult.dimensions,
        },
        'Product extraction complete'
      );

      return {
        success: true,
        outputPath,
        rotationApplied: rotationAngle,
        boundingBox,
        originalSize,
        finalSize: centerResult.dimensions,
      };
    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error({ error, frameId: frame.frameId }, 'Product extraction failed');
      return {
        success: false,
        rotationApplied: 0,
        error: errorMessage,
      };
    } finally {
      // Cleanup temp files
      await unlink(tempTransparentPath).catch(() => {});
    }
  }

  async extractProducts(
    frames: ExtractionFrame[],
    outputDir: string,
    options: ProductExtractionOptions = {}
  ): Promise<Map<string, ProductExtractionResult>> {
    const results = new Map<string, ProductExtractionResult>();
    const { onProgress, ...extractionOptions } = options;

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const result = await this.extractProduct(frame, outputDir, extractionOptions);
      results.set(frame.frameId, result);

      if (onProgress) {
        await onProgress(i + 1, frames.length);
      }
    }

    return results;
  }

  isAvailable(): boolean {
    return this.backgroundRemovalProvider.isAvailable() && this.imageTransformProvider.isAvailable();
  }
}

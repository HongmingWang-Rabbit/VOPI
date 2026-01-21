/**
 * Bounding box coordinates
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Image dimensions
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Result of image transformation
 */
export interface ImageTransformResult {
  success: boolean;
  outputPath?: string;
  outputBuffer?: Buffer;
  dimensions?: ImageDimensions;
  error?: string;
}

/**
 * Rotation options
 */
export interface RotationOptions {
  /** Angle in degrees (positive = clockwise) */
  angle: number;
  /** Background color for exposed areas */
  background?: { r: number; g: number; b: number; alpha: number };
}

/**
 * Crop options
 */
export interface CropOptions {
  /** Region to extract */
  region: BoundingBox;
}

/**
 * Center options
 */
export interface CenterOptions {
  /** Target canvas size */
  canvasSize: number;
  /** Padding percentage (0-1) */
  padding?: number;
  /** Background color */
  background?: { r: number; g: number; b: number; alpha: number };
}

/**
 * ImageTransformProvider Interface
 *
 * Implementations: SharpProvider, ImageMagickProvider, etc.
 *
 * This provider handles image manipulation operations
 * like rotation, cropping, and centering.
 */
export interface ImageTransformProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Rotate an image
   * @param input - Input image path or buffer
   * @param options - Rotation options
   */
  rotate(
    input: string | Buffer,
    options: RotationOptions
  ): Promise<ImageTransformResult>;

  /**
   * Crop an image
   * @param input - Input image path or buffer
   * @param options - Crop options
   */
  crop(
    input: string | Buffer,
    options: CropOptions
  ): Promise<ImageTransformResult>;

  /**
   * Center an image on a square canvas
   * @param input - Input image path or buffer
   * @param options - Center options
   */
  centerOnCanvas(
    input: string | Buffer,
    options: CenterOptions
  ): Promise<ImageTransformResult>;

  /**
   * Find bounding box of non-transparent pixels
   * @param input - Input image path or buffer
   * @param alphaThreshold - Minimum alpha to consider opaque (0-255)
   */
  findContentBounds(
    input: string | Buffer,
    alphaThreshold?: number
  ): Promise<BoundingBox | null>;

  /**
   * Get image dimensions
   * @param input - Input image path or buffer
   */
  getDimensions(input: string | Buffer): Promise<ImageDimensions>;

  /**
   * Check if provider is available
   */
  isAvailable(): boolean;
}

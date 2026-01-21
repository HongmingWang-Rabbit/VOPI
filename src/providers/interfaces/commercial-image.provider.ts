import type { BackgroundRecommendations } from '../../types/job.types.js';

/**
 * Commercial image version types
 */
export type CommercialVersionType = 'transparent' | 'solid' | 'real' | 'creative';

/**
 * Result of commercial image generation
 */
export interface CommercialImageResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  method?: string;
  backgroundColor?: string;
  backgroundPrompt?: string;
  error?: string;
}

/**
 * Commercial image generation options
 */
export interface CommercialImageOptions {
  /** Background color for solid version */
  solidColor?: string;
  /** Prompt for real-life setting */
  realLifePrompt?: string;
  /** Prompt for creative shot */
  creativePrompt?: string;
  /** Padding ratio (0-1) */
  padding?: number;
}

/**
 * All versions result
 */
export interface AllVersionsResult {
  frameId: string;
  recommendedType: string;
  versions: Record<CommercialVersionType, CommercialImageResult>;
}

/**
 * Generate all versions options
 */
export interface GenerateAllVersionsOptions {
  /** Which versions to generate */
  versions?: CommercialVersionType[];
  /** Pre-extracted transparent image path (skip transparent generation) */
  transparentSource?: string;
  /** Skip generating transparent version */
  skipTransparent?: boolean;
  /** Background recommendations from classification */
  backgroundRecommendations?: BackgroundRecommendations;
}

/**
 * CommercialImageProvider Interface
 *
 * Implementations: PhotoroomCommercialProvider, CustomBackgroundProvider, etc.
 *
 * This provider handles generating commercial-ready images
 * with various backgrounds (solid color, AI-generated, etc.)
 */
export interface CommercialImageProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Generate image with solid color background
   * @param imagePath - Path to input image (should have transparent background)
   * @param outputPath - Path for output image
   * @param backgroundColor - Hex color code
   * @param options - Additional options
   */
  generateWithSolidBackground(
    imagePath: string,
    outputPath: string,
    backgroundColor: string,
    options?: CommercialImageOptions
  ): Promise<CommercialImageResult>;

  /**
   * Generate image with AI-generated background
   * @param imagePath - Path to input image (should have transparent background)
   * @param outputPath - Path for output image
   * @param prompt - Background generation prompt
   * @param options - Additional options
   */
  generateWithAIBackground(
    imagePath: string,
    outputPath: string,
    prompt: string,
    options?: CommercialImageOptions
  ): Promise<CommercialImageResult>;

  /**
   * Generate all commercial versions for a frame
   * @param imagePath - Path to original frame
   * @param outputDir - Directory for output files
   * @param baseName - Base name for output files
   * @param options - Generation options
   */
  generateAllVersions(
    imagePath: string,
    outputDir: string,
    baseName: string,
    options?: GenerateAllVersionsOptions
  ): Promise<AllVersionsResult>;

  /**
   * Check if provider is available/configured
   */
  isAvailable(): boolean;
}

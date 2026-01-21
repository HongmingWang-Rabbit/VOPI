import type { FrameObstructions } from '../../types/job.types.js';

/**
 * Result of background removal operation
 */
export interface BackgroundRemovalResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  method?: string;
  error?: string;
}

/**
 * Options for background removal
 */
export interface BackgroundRemovalOptions {
  /** Use AI to remove obstructions (hands, etc.) */
  useAIEdit?: boolean;
  /** Obstruction information for AI removal */
  obstructions?: FrameObstructions | null;
  /** Custom prompt for AI removal */
  customPrompt?: string;
}

/**
 * BackgroundRemovalProvider Interface
 *
 * Implementations: PhotoroomProvider, RemoveBgProvider, etc.
 *
 * This provider handles removing backgrounds from images,
 * optionally using AI to remove obstructions.
 */
export interface BackgroundRemovalProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Remove background from an image
   * @param imagePath - Path to input image
   * @param outputPath - Path for output image
   * @param options - Removal options
   */
  removeBackground(
    imagePath: string,
    outputPath: string,
    options?: BackgroundRemovalOptions
  ): Promise<BackgroundRemovalResult>;

  /**
   * Check if provider is available/configured
   */
  isAvailable(): boolean;
}

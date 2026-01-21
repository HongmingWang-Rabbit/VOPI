import { photoroomService } from '../../services/photoroom.service.js';
import { getConfig } from '../../config/index.js';
import type {
  CommercialImageProvider,
  CommercialImageResult,
  CommercialImageOptions,
  AllVersionsResult,
  GenerateAllVersionsOptions,
  CommercialVersionType,
} from '../interfaces/commercial-image.provider.js';

/**
 * Photoroom Commercial Image Provider
 *
 * Uses Photoroom API for generating commercial-ready images
 * with various backgrounds.
 */
export class PhotoroomCommercialImageProvider implements CommercialImageProvider {
  readonly providerId = 'photoroom';

  async generateWithSolidBackground(
    imagePath: string,
    outputPath: string,
    backgroundColor: string,
    _options?: CommercialImageOptions
  ): Promise<CommercialImageResult> {
    return photoroomService.generateWithSolidBackground(imagePath, outputPath, backgroundColor);
  }

  async generateWithAIBackground(
    imagePath: string,
    outputPath: string,
    prompt: string,
    _options?: CommercialImageOptions
  ): Promise<CommercialImageResult> {
    return photoroomService.generateWithAIBackground(imagePath, outputPath, prompt);
  }

  async generateAllVersions(
    imagePath: string,
    outputDir: string,
    baseName: string,
    options: GenerateAllVersionsOptions = {}
  ): Promise<AllVersionsResult> {
    const {
      versions = ['transparent', 'solid', 'real', 'creative'],
      transparentSource,
      skipTransparent,
      backgroundRecommendations,
    } = options;

    // Create a mock frame object for the existing photoroom service
    const mockFrame = {
      filename: '',
      path: imagePath,
      index: 0,
      timestamp: 0,
      frameId: baseName,
      sharpness: 0,
      motion: 0,
      score: 0,
      productId: '',
      variantId: '',
      angleEstimate: '',
      recommendedType: baseName,
      geminiScore: 0,
      rotationAngleDeg: 0,
      allFrameIds: [],
      obstructions: {
        has_obstruction: false,
        obstruction_types: [],
        obstruction_description: null,
        removable_by_ai: true,
      },
      backgroundRecommendations: backgroundRecommendations || {
        solid_color: '#FFFFFF',
        solid_color_name: 'white',
        real_life_setting: 'on a clean white surface with soft lighting',
        creative_shot: 'floating with soft shadow on gradient background',
      },
    };

    const result = await photoroomService.generateAllVersions(mockFrame, outputDir, {
      versions,
      transparentSource,
      skipTransparent,
    });

    // Convert to provider interface format
    const convertedVersions: Record<CommercialVersionType, CommercialImageResult> = {} as Record<CommercialVersionType, CommercialImageResult>;

    for (const [version, versionResult] of Object.entries(result.versions)) {
      convertedVersions[version as CommercialVersionType] = {
        success: versionResult.success,
        outputPath: versionResult.outputPath,
        size: versionResult.size,
        method: versionResult.method,
        backgroundColor: versionResult.bgColor,
        backgroundPrompt: versionResult.bgPrompt,
        error: versionResult.error,
      };
    }

    return {
      frameId: baseName,
      recommendedType: baseName,
      versions: convertedVersions,
    };
  }

  isAvailable(): boolean {
    try {
      const config = getConfig();
      return !!config.apis.photoroom;
    } catch {
      return false;
    }
  }
}

export const photoroomCommercialImageProvider = new PhotoroomCommercialImageProvider();

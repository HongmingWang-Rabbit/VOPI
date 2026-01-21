import { photoroomService } from '../../services/photoroom.service.js';
import { getConfig } from '../../config/index.js';
import type {
  BackgroundRemovalProvider,
  BackgroundRemovalResult,
  BackgroundRemovalOptions,
} from '../interfaces/background-removal.provider.js';

/**
 * Photoroom Background Removal Provider
 *
 * Uses Photoroom API for background removal and AI-based obstruction cleanup.
 */
export class PhotoroomBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly providerId = 'photoroom';

  async removeBackground(
    imagePath: string,
    outputPath: string,
    options: BackgroundRemovalOptions = {}
  ): Promise<BackgroundRemovalResult> {
    const { useAIEdit, obstructions, customPrompt } = options;

    if (useAIEdit && (obstructions?.has_obstruction || customPrompt)) {
      return photoroomService.editImageWithAI(imagePath, outputPath, {
        obstructions,
        customPrompt,
      });
    }

    return photoroomService.removeBackground(imagePath, outputPath);
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

export const photoroomBackgroundRemovalProvider = new PhotoroomBackgroundRemovalProvider();

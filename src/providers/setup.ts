/**
 * Provider Setup
 *
 * Registers all default provider implementations with the provider registry.
 * Call this during application initialization.
 */

import { providerRegistry } from './provider-registry.js';
import {
  photoroomBackgroundRemovalProvider,
  claidBackgroundRemovalProvider,
  geminiClassificationProvider,
  sharpImageTransformProvider,
  photoroomCommercialImageProvider,
  DefaultProductExtractionProvider,
  ffmpegVideoExtractionProvider,
} from './implementations/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ service: 'provider-setup' });

/**
 * Register all default providers
 */
export function setupDefaultProviders(): void {
  logger.info('Registering default providers');

  // Register background removal providers
  providerRegistry.register('backgroundRemoval', photoroomBackgroundRemovalProvider, true);

  // Register Claid provider if available (can be enabled via A/B test or config)
  if (claidBackgroundRemovalProvider.isAvailable()) {
    providerRegistry.register('backgroundRemoval', claidBackgroundRemovalProvider);
    logger.info('Claid background removal provider registered');
  }

  // Register classification providers
  providerRegistry.register('classification', geminiClassificationProvider, true);

  // Register image transform providers
  providerRegistry.register('imageTransform', sharpImageTransformProvider, true);

  // Register commercial image providers
  providerRegistry.register('commercialImage', photoroomCommercialImageProvider, true);

  // Register video extraction providers
  providerRegistry.register('videoExtraction', ffmpegVideoExtractionProvider, true);

  // Create and register default product extraction provider
  // This is a composite provider using the registered background removal and image transform providers
  const defaultProductExtractionProvider = new DefaultProductExtractionProvider(
    photoroomBackgroundRemovalProvider,
    sharpImageTransformProvider
  );
  providerRegistry.register('productExtraction', defaultProductExtractionProvider, true);

  logger.info('Default providers registered');
}

/**
 * Configure A/B test for a provider type
 *
 * Example usage:
 * ```ts
 * configureABTest('classification', {
 *   testId: 'gemini-vs-openai',
 *   providerA: 'gemini',
 *   providerB: 'openai-vision',
 *   trafficPercentA: 50,
 *   active: true,
 * });
 * ```
 */
export { providerRegistry } from './provider-registry.js';

import { createChildLogger } from '../utils/logger.js';
import type {
  BackgroundRemovalProvider,
  ClassificationProvider,
  ImageTransformProvider,
  CommercialImageProvider,
  ProductExtractionProvider,
  VideoExtractionProvider,
} from './interfaces/index.js';

const logger = createChildLogger({ service: 'provider-registry' });

/**
 * Provider types supported by the registry
 */
export type ProviderType =
  | 'backgroundRemoval'
  | 'classification'
  | 'imageTransform'
  | 'commercialImage'
  | 'productExtraction'
  | 'videoExtraction';

/**
 * Provider map type
 */
type ProviderMap = {
  backgroundRemoval: BackgroundRemovalProvider;
  classification: ClassificationProvider;
  imageTransform: ImageTransformProvider;
  commercialImage: CommercialImageProvider;
  productExtraction: ProductExtractionProvider;
  videoExtraction: VideoExtractionProvider;
};

/**
 * A/B test configuration
 */
export interface ABTestConfig {
  /** Test identifier */
  testId: string;
  /** Provider A identifier */
  providerA: string;
  /** Provider B identifier */
  providerB: string;
  /** Traffic percentage for provider A (0-100) */
  trafficPercentA: number;
  /** Whether test is active */
  active: boolean;
}

/**
 * Provider selection result
 */
export interface ProviderSelection<T> {
  provider: T;
  providerId: string;
  abTestId?: string;
  variant?: 'A' | 'B';
}

/**
 * ProviderRegistry
 *
 * Central registry for all provider implementations.
 * Supports:
 * - Multiple implementations per provider type
 * - A/B testing between providers
 * - Default provider selection
 * - Provider availability checking
 */
export class ProviderRegistry {
  private providers: Map<ProviderType, Map<string, unknown>> = new Map();
  private defaults: Map<ProviderType, string> = new Map();
  private abTests: Map<ProviderType, ABTestConfig> = new Map();

  constructor() {
    // Initialize provider maps for each type
    const types: ProviderType[] = [
      'backgroundRemoval',
      'classification',
      'imageTransform',
      'commercialImage',
      'productExtraction',
      'videoExtraction',
    ];
    for (const type of types) {
      this.providers.set(type, new Map());
    }
  }

  /**
   * Register a provider
   * @param type - Provider type
   * @param provider - Provider instance
   * @param setAsDefault - Whether to set as default for this type
   */
  register<T extends ProviderType>(
    type: T,
    provider: ProviderMap[T],
    setAsDefault = false
  ): void {
    const typeProviders = this.providers.get(type);
    if (!typeProviders) {
      throw new Error(`Unknown provider type: ${type}`);
    }

    const providerId = provider.providerId;
    typeProviders.set(providerId, provider);

    if (setAsDefault || !this.defaults.has(type)) {
      this.defaults.set(type, providerId);
    }

    logger.info({ type, providerId, isDefault: setAsDefault }, 'Provider registered');
  }

  /**
   * Set the default provider for a type
   * @param type - Provider type
   * @param providerId - Provider identifier
   */
  setDefault<T extends ProviderType>(type: T, providerId: string): void {
    const typeProviders = this.providers.get(type);
    if (!typeProviders?.has(providerId)) {
      throw new Error(`Provider not found: ${type}/${providerId}`);
    }
    this.defaults.set(type, providerId);
    logger.info({ type, providerId }, 'Default provider set');
  }

  /**
   * Configure A/B test for a provider type
   * @param type - Provider type
   * @param config - A/B test configuration
   */
  configureABTest<T extends ProviderType>(type: T, config: ABTestConfig): void {
    const typeProviders = this.providers.get(type);
    if (!typeProviders?.has(config.providerA)) {
      throw new Error(`Provider A not found: ${type}/${config.providerA}`);
    }
    if (!typeProviders?.has(config.providerB)) {
      throw new Error(`Provider B not found: ${type}/${config.providerB}`);
    }

    this.abTests.set(type, config);
    logger.info(
      { type, testId: config.testId, providerA: config.providerA, providerB: config.providerB },
      'A/B test configured'
    );
  }

  /**
   * Disable A/B test for a provider type
   * @param type - Provider type
   */
  disableABTest<T extends ProviderType>(type: T): void {
    this.abTests.delete(type);
    logger.info({ type }, 'A/B test disabled');
  }

  /**
   * Get a provider by type and optional ID
   * @param type - Provider type
   * @param providerId - Optional specific provider ID
   * @param seed - Optional seed for A/B test selection (e.g., job ID)
   */
  get<T extends ProviderType>(
    type: T,
    providerId?: string,
    seed?: string
  ): ProviderSelection<ProviderMap[T]> {
    const typeProviders = this.providers.get(type);
    if (!typeProviders || typeProviders.size === 0) {
      throw new Error(`No providers registered for type: ${type}`);
    }

    // If specific provider requested, return it
    if (providerId) {
      const provider = typeProviders.get(providerId) as ProviderMap[T];
      if (!provider) {
        throw new Error(`Provider not found: ${type}/${providerId}`);
      }
      return { provider, providerId };
    }

    // Check for active A/B test
    const abTest = this.abTests.get(type);
    if (abTest?.active && seed) {
      const variant = this.selectABVariant(seed, abTest.trafficPercentA);
      const selectedId = variant === 'A' ? abTest.providerA : abTest.providerB;
      const provider = typeProviders.get(selectedId) as ProviderMap[T];

      return {
        provider,
        providerId: selectedId,
        abTestId: abTest.testId,
        variant,
      };
    }

    // Return default provider
    const defaultId = this.defaults.get(type);
    if (!defaultId) {
      throw new Error(`No default provider for type: ${type}`);
    }

    const provider = typeProviders.get(defaultId) as ProviderMap[T];
    return { provider, providerId: defaultId };
  }

  /**
   * Get all registered providers for a type
   * @param type - Provider type
   */
  getAll<T extends ProviderType>(type: T): Map<string, ProviderMap[T]> {
    const typeProviders = this.providers.get(type);
    return new Map(typeProviders as Map<string, ProviderMap[T]>);
  }

  /**
   * Check if a provider type has any registered providers
   * @param type - Provider type
   */
  hasProviders(type: ProviderType): boolean {
    const typeProviders = this.providers.get(type);
    return !!typeProviders && typeProviders.size > 0;
  }

  /**
   * Get available (properly configured) providers for a type
   * @param type - Provider type
   */
  getAvailable<T extends ProviderType>(type: T): ProviderMap[T][] {
    const typeProviders = this.providers.get(type);
    if (!typeProviders) return [];

    return [...typeProviders.values()]
      .filter((p) => (p as ProviderMap[T]).isAvailable())
      .map((p) => p as ProviderMap[T]);
  }

  /**
   * Select A/B variant based on seed
   * Uses consistent hashing for deterministic selection
   */
  private selectABVariant(seed: string, trafficPercentA: number): 'A' | 'B' {
    // Simple hash function for consistent selection
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      const char = seed.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Normalize to 0-100 range
    const normalized = Math.abs(hash % 100);
    return normalized < trafficPercentA ? 'A' : 'B';
  }
}

// Global singleton instance
export const providerRegistry = new ProviderRegistry();

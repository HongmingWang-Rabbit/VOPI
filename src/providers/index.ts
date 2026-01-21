/**
 * Providers Module
 *
 * This module provides a modular architecture for swappable service implementations.
 * It supports:
 * - Multiple implementations per provider type
 * - A/B testing between providers
 * - Dependency injection via the provider registry
 *
 * Usage:
 *
 * 1. Initialize providers (call once at app startup):
 *    ```ts
 *    import { setupDefaultProviders } from './providers/setup.js';
 *    setupDefaultProviders();
 *    ```
 *
 * 2. Get a provider:
 *    ```ts
 *    import { providerRegistry } from './providers/index.js';
 *    const { provider } = providerRegistry.get('classification');
 *    const result = await provider.classifyFrames(...);
 *    ```
 *
 * 3. Get provider with A/B test selection:
 *    ```ts
 *    const { provider, abTestId, variant } = providerRegistry.get('classification', undefined, jobId);
 *    // Log which variant was used for analytics
 *    ```
 *
 * 4. Configure A/B test:
 *    ```ts
 *    providerRegistry.configureABTest('classification', {
 *      testId: 'gemini-vs-openai',
 *      providerA: 'gemini',
 *      providerB: 'openai-vision',
 *      trafficPercentA: 50,
 *      active: true,
 *    });
 *    ```
 */

// Export interfaces
export * from './interfaces/index.js';

// Export registry
export { providerRegistry, type ProviderType, type ABTestConfig, type ProviderSelection } from './provider-registry.js';

// Export setup
export { setupDefaultProviders } from './setup.js';

// Export implementations for direct use or custom composition
export * from './implementations/index.js';

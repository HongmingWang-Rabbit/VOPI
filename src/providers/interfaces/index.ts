/**
 * Provider Interfaces
 *
 * These interfaces define contracts for different pipeline components,
 * allowing easy swapping of implementations for A/B testing or provider changes.
 */

export * from './background-removal.provider.js';
export * from './classification.provider.js';
export * from './image-transform.provider.js';
export * from './commercial-image.provider.js';
export * from './product-extraction.provider.js';
export * from './video-extraction.provider.js';
export * from './video-analysis.provider.js';
export * from './audio-analysis.provider.js';

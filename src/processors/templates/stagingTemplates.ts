/**
 * Staging/Test Stack Templates
 *
 * Simplified processor stacks for development, testing, and staging environments.
 * These stacks skip expensive operations or focus on specific pipeline segments.
 *
 * Note: requiredInputs and producedOutputs are computed dynamically from
 * processor IO declarations using stackRunner.getRequiredInputs(stack) and
 * stackRunner.getProducedOutputs(stack).
 *
 * ## Usage Examples
 *
 * ### Quick Testing (skip AI and commercial generation)
 * ```typescript
 * import { quickTestStack } from './stagingTemplates.js';
 * import { stackRunner } from '../runner.js';
 *
 * await stackRunner.execute(quickTestStack, context, undefined, {
 *   video: { sourceUrl: 'https://example.com/video.mp4' },
 * });
 * ```
 *
 * ### Process Local Video File
 * ```typescript
 * import { localFileStack } from './stagingTemplates.js';
 *
 * await stackRunner.execute(localFileStack, context, undefined, {
 *   video: { path: '/path/to/local/video.mp4' },
 * });
 * ```
 *
 * ### Test Gemini Classification in Isolation
 * ```typescript
 * import { classificationTestStack } from './stagingTemplates.js';
 *
 * await stackRunner.execute(classificationTestStack, context, undefined, {
 *   images: ['/tmp/frame1.jpg', '/tmp/frame2.jpg', '/tmp/frame3.jpg'],
 *   frames: [
 *     { frameId: 'f1', filename: 'frame1.jpg', path: '/tmp/frame1.jpg', timestamp: 1.0, index: 0 },
 *     { frameId: 'f2', filename: 'frame2.jpg', path: '/tmp/frame2.jpg', timestamp: 2.0, index: 1 },
 *     { frameId: 'f3', filename: 'frame3.jpg', path: '/tmp/frame3.jpg', timestamp: 3.0, index: 2 },
 *   ],
 * });
 * ```
 *
 * ### Test Background Removal Provider
 * ```typescript
 * import { bgRemovalTestStack, claidBgRemovalTestStack } from './stagingTemplates.js';
 *
 * // Test default provider (Photoroom)
 * await stackRunner.execute(bgRemovalTestStack, context, undefined, {
 *   images: ['/tmp/product-frame.jpg'],
 *   frames: [{ frameId: 'f1', filename: 'product-frame.jpg', path: '/tmp/product-frame.jpg', timestamp: 1.0, index: 0 }],
 * });
 *
 * // Test Claid provider
 * await stackRunner.execute(claidBgRemovalTestStack, context, undefined, {
 *   images: ['/tmp/product-frame.jpg'],
 * });
 * ```
 *
 * ### Test Commercial Image Generation
 * ```typescript
 * import { commercialTestStack } from './stagingTemplates.js';
 *
 * await stackRunner.execute(commercialTestStack, context, undefined, {
 *   images: ['/tmp/extracted-product.png'],
 *   frames: [{ frameId: 'f1', filename: 'extracted.png', path: '/tmp/extracted-product.png', timestamp: 1.0, index: 0 }],
 * });
 * ```
 *
 * ### Upload Pre-processed Images
 * ```typescript
 * import { uploadOnlyStack } from './stagingTemplates.js';
 *
 * await stackRunner.execute(uploadOnlyStack, context, undefined, {
 *   images: ['/tmp/final1.jpg', '/tmp/final2.jpg'],
 *   frames: [
 *     { frameId: 'f1', filename: 'final1.jpg', path: '/tmp/final1.jpg', timestamp: 1.0, index: 0 },
 *     { frameId: 'f2', filename: 'final2.jpg', path: '/tmp/final2.jpg', timestamp: 2.0, index: 1 },
 *   ],
 * });
 * ```
 *
 * ### With Processor Options
 * ```typescript
 * import { fullStagingStack } from './stagingTemplates.js';
 *
 * await stackRunner.execute(fullStagingStack, context, {
 *   processorOptions: {
 *     'extract-frames': { fps: 5 },          // Lower FPS for faster testing
 *     'score-frames': { motionAlpha: 0.3 },  // Custom scoring parameters
 *   },
 *   strictIOValidation: true,  // Fail fast on IO mismatches
 * }, {
 *   video: { sourceUrl: 'https://example.com/video.mp4' },
 * });
 * ```
 *
 * ### Swap Background Removal Provider
 * ```typescript
 * import { fullStagingStack } from './stagingTemplates.js';
 *
 * await stackRunner.execute(fullStagingStack, context, {
 *   processorSwaps: {
 *     'photoroom-bg-remove': 'claid-bg-remove',
 *   },
 * }, {
 *   video: { sourceUrl: 'https://example.com/video.mp4' },
 * });
 * ```
 */

import type { StackTemplate } from '../types.js';

/**
 * Quick test stack - minimal processing for fast iteration
 *
 * Skips commercial generation and uses score-based filtering instead of AI classification.
 * Good for testing frame extraction and scoring logic.
 */
export const quickTestStack: StackTemplate = {
  id: 'quick_test',
  name: 'Quick Test Pipeline',
  description: 'Fast pipeline for testing - no AI classification or commercial generation',
  steps: [
    { processor: 'download' },
    { processor: 'extract-frames' },
    { processor: 'score-frames' },
    { processor: 'filter-by-score' },
    { processor: 'complete-job' },
  ],
};

/**
 * Local file stack - skip download, start from local video
 *
 * Use with initialData: { video: { path: '/path/to/local/video.mp4' } }
 */
export const localFileStack: StackTemplate = {
  id: 'local_file',
  name: 'Local File Pipeline',
  description: 'Process a local video file - skip download step',
  steps: [
    { processor: 'extract-frames' },
    { processor: 'score-frames' },
    { processor: 'filter-by-score' },
    { processor: 'save-frame-records' },
    { processor: 'upload-frames' },
    { processor: 'complete-job' },
  ],
};

/**
 * Classification test stack - test Gemini classification in isolation
 *
 * Use with initialData: { images: ['/path/to/frame1.jpg', '/path/to/frame2.jpg'] }
 */
export const classificationTestStack: StackTemplate = {
  id: 'classification_test',
  name: 'Classification Test Pipeline',
  description: 'Test Gemini classification with pre-extracted frames',
  steps: [
    { processor: 'gemini-classify' },
    { processor: 'complete-job' },
  ],
};

/**
 * Background removal test stack - test product extraction
 *
 * Use with initialData: { images: ['/path/to/frame1.jpg'] }
 */
export const bgRemovalTestStack: StackTemplate = {
  id: 'bg_removal_test',
  name: 'Background Removal Test Pipeline',
  description: 'Test background removal and product extraction',
  steps: [
    { processor: 'extract-products' },
    { processor: 'complete-job' },
  ],
};

/**
 * Commercial generation test stack - test Photoroom commercial image generation
 *
 * Use with initialData: { images: ['/path/to/extracted-product.png'] }
 */
export const commercialTestStack: StackTemplate = {
  id: 'commercial_test',
  name: 'Commercial Generation Test Pipeline',
  description: 'Test commercial image generation with pre-extracted products',
  steps: [
    { processor: 'generate-commercial' },
    { processor: 'complete-job' },
  ],
};

/**
 * Upload only stack - just upload existing images to S3
 *
 * Use with initialData: { images: ['/path/to/image1.jpg', '/path/to/image2.jpg'] }
 */
export const uploadOnlyStack: StackTemplate = {
  id: 'upload_only',
  name: 'Upload Only Pipeline',
  description: 'Upload pre-processed images to S3',
  steps: [
    { processor: 'upload-frames' },
    { processor: 'complete-job' },
  ],
};

/**
 * Gemini video test stack - test video analysis without commercial generation
 */
export const geminiVideoTestStack: StackTemplate = {
  id: 'gemini_video_test',
  name: 'Gemini Video Test Pipeline',
  description: 'Test Gemini video analysis without commercial generation',
  steps: [
    { processor: 'download' },
    { processor: 'gemini-video-analysis' },
    { processor: 'save-frame-records' },
    { processor: 'complete-job' },
  ],
};

/**
 * Full staging stack - complete pipeline but with smaller batch sizes
 *
 * Same as classic but intended for staging environment testing
 */
export const fullStagingStack: StackTemplate = {
  id: 'full_staging',
  name: 'Full Staging Pipeline',
  description: 'Complete classic pipeline for staging environment testing',
  steps: [
    { processor: 'download' },
    { processor: 'extract-frames' },
    { processor: 'score-frames' },
    { processor: 'gemini-classify' },
    { processor: 'save-frame-records' },
    { processor: 'extract-products' },
    { processor: 'upload-frames' },
    { processor: 'generate-commercial' },
    { processor: 'complete-job' },
  ],
};

/**
 * No-upload stack - full processing but skip S3 upload (for local testing)
 */
export const noUploadStack: StackTemplate = {
  id: 'no_upload',
  name: 'No Upload Pipeline',
  description: 'Full processing without S3 upload - keeps results local',
  steps: [
    { processor: 'download' },
    { processor: 'extract-frames' },
    { processor: 'score-frames' },
    { processor: 'filter-by-score' },
    { processor: 'extract-products' },
    { processor: 'complete-job' },
  ],
};

/**
 * Claid background removal test stack
 *
 * Use with initialData: { images: ['/path/to/frame1.jpg'] }
 */
export const claidBgRemovalTestStack: StackTemplate = {
  id: 'claid_bg_removal_test',
  name: 'Claid Background Removal Test Pipeline',
  description: 'Test Claid background removal with hole filling',
  steps: [
    { processor: 'claid-bg-remove' },
    { processor: 'fill-product-holes' },
    { processor: 'center-product' },
    { processor: 'complete-job' },
  ],
};

/**
 * Hole detection debug stack - visualize detected holes
 *
 * Outputs multiple mask images for debugging:
 * - {frameId}_holes.png: White = detected holes
 * - {frameId}_background.png: White = background (reachable from edges)
 * - {frameId}_dilated.png: White = dilated product region
 * - {frameId}_visual.png: Red=holes, Green=product, Blue=background
 *
 * Use with initialData: { images: ['/path/to/transparent.png'] }
 */
export const holeDetectionDebugStack: StackTemplate = {
  id: 'hole_detection_debug',
  name: 'Hole Detection Debug Pipeline',
  description: 'Debug hole detection - outputs mask visualizations',
  steps: [
    { processor: 'detect-holes-debug' },
    { processor: 'complete-job' },
  ],
};

/**
 * All staging/test stack templates
 */
export const stagingStackTemplates: Record<string, StackTemplate> = {
  quick_test: quickTestStack,
  local_file: localFileStack,
  classification_test: classificationTestStack,
  bg_removal_test: bgRemovalTestStack,
  commercial_test: commercialTestStack,
  upload_only: uploadOnlyStack,
  gemini_video_test: geminiVideoTestStack,
  full_staging: fullStagingStack,
  no_upload: noUploadStack,
  claid_bg_removal_test: claidBgRemovalTestStack,
  hole_detection_debug: holeDetectionDebugStack,
};

/**
 * Get a staging stack template by ID
 */
export function getStagingStackTemplate(id: string): StackTemplate | undefined {
  return stagingStackTemplates[id];
}

/**
 * Get all staging stack template IDs
 */
export function getStagingStackTemplateIds(): string[] {
  return Object.keys(stagingStackTemplates);
}

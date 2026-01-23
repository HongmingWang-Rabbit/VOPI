/**
 * Stack Templates
 *
 * Pre-defined processor stacks for common workflows.
 * These can be customized via StackConfig at job creation time.
 *
 * Note: requiredInputs and producedOutputs are computed dynamically from
 * processor IO declarations using stackRunner.getRequiredInputs(stack) and
 * stackRunner.getProducedOutputs(stack).
 */

import type { StackTemplate } from '../types.js';
import { PipelineStrategy } from '../../types/config.types.js';

// Re-export staging templates
export * from './stagingTemplates.js';

/**
 * Classic strategy stack
 *
 * Flow: Download → Extract Frames → Score → Classify → Claid BG Remove → Fill Holes → Center → Generate Commercial → Complete
 *
 * Uses Claid.ai for background removal with selective object retention,
 * followed by hole filling (for obstruction removal artifacts) and centering.
 */
export const classicStack: StackTemplate = {
  id: 'classic',
  name: 'Classic Pipeline',
  description: 'Extract all frames, score them, classify with Gemini, extract products with Claid, generate commercial images',
  steps: [
    { processor: 'download' },
    { processor: 'extract-frames' },
    { processor: 'score-frames' },
    { processor: 'gemini-classify' },
    { processor: 'save-frame-records' },
    { processor: 'claid-bg-remove' },
    { processor: 'fill-product-holes' },
    { processor: 'center-product' },
    { processor: 'upload-frames' },
    { processor: 'generate-commercial' },
    { processor: 'complete-job' },
  ],
};

/**
 * Gemini Video strategy stack
 *
 * Flow: Download → Gemini Video Analysis → Claid BG Remove → Fill Holes → Center → Generate Commercial → Complete
 *
 * Uses Gemini for video analysis and frame selection, then Claid.ai for
 * background removal with hole filling and centering.
 */
export const geminiVideoStack: StackTemplate = {
  id: 'gemini_video',
  name: 'Gemini Video Pipeline',
  description: 'Upload video to Gemini for AI analysis, extract products with Claid',
  steps: [
    { processor: 'download' },
    { processor: 'gemini-video-analysis' },
    { processor: 'save-frame-records' },
    { processor: 'claid-bg-remove' },
    { processor: 'fill-product-holes' },
    { processor: 'center-product' },
    { processor: 'upload-frames' },
    { processor: 'generate-commercial' },
    { processor: 'complete-job' },
  ],
};

/**
 * Minimal stack - just extract frames without commercial generation
 */
export const minimalStack: StackTemplate = {
  id: 'minimal',
  name: 'Minimal Pipeline',
  description: 'Extract and upload frames without commercial image generation',
  steps: [
    { processor: 'download' },
    { processor: 'extract-frames' },
    { processor: 'score-frames' },
    { processor: 'save-frame-records' },
    { processor: 'upload-frames' },
    { processor: 'complete-job' },
  ],
};

/**
 * Frames only stack - just extract frames, no classification
 */
export const framesOnlyStack: StackTemplate = {
  id: 'frames_only',
  name: 'Frames Only Pipeline',
  description: 'Extract frames with scoring, skip AI classification',
  steps: [
    { processor: 'download' },
    { processor: 'extract-frames' },
    { processor: 'score-frames' },
    { processor: 'filter-by-score' },
    { processor: 'save-frame-records' },
    { processor: 'upload-frames' },
    { processor: 'complete-job' },
  ],
};

/**
 * Custom background removal stack
 * Can swap between photoroom and claid providers
 */
export const customBgRemovalStack: StackTemplate = {
  id: 'custom_bg_removal',
  name: 'Custom Background Removal',
  description: 'Pipeline with configurable background removal provider',
  steps: [
    { processor: 'download' },
    { processor: 'gemini-video-analysis' },
    { processor: 'photoroom-bg-remove' },  // Can be swapped with claid-bg-remove
    { processor: 'center-product' },
    { processor: 'save-frame-records' },
    { processor: 'upload-frames' },
    { processor: 'complete-job' },
  ],
};

/**
 * All available stack templates
 */
export const stackTemplates: Record<string, StackTemplate> = {
  classic: classicStack,
  gemini_video: geminiVideoStack,
  minimal: minimalStack,
  frames_only: framesOnlyStack,
  custom_bg_removal: customBgRemovalStack,
};

/**
 * Get a stack template by ID
 * @param id - Stack template ID
 * @returns Stack template or undefined
 */
export function getStackTemplate(id: string): StackTemplate | undefined {
  return stackTemplates[id];
}

/**
 * Get all stack template IDs
 */
export function getStackTemplateIds(): string[] {
  return Object.keys(stackTemplates);
}

/**
 * Default stack ID based on strategy
 */
export function getDefaultStackId(strategy: PipelineStrategy): string {
  return strategy === PipelineStrategy.GEMINI_VIDEO ? 'gemini_video' : 'classic';
}

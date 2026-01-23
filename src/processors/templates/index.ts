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
    { processor: 'stability-commercial' },           // Generate commercial images first (at original resolution)
    { processor: 'stability-upscale' },              // Upscale product images to higher resolution
    { processor: 'upload-frames' },
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
    { processor: 'stability-commercial' },           // Generate commercial images first (at original resolution)
    { processor: 'stability-upscale' },              // Upscale product images to higher resolution
    { processor: 'upload-frames' },
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
 * Full Product Analysis stack
 *
 * Audio-first approach: extracts audio FIRST, transcribes it, and uses the
 * transcript context to enhance frame classification.
 *
 * Flow: Download → Extract Audio → Analyze Audio → Extract Frames → Score →
 *       Classify (with audio context) → Claid BG Remove → Fill Holes →
 *       Center → Upload → Generate Commercial → Complete (uploads metadata.json)
 *
 * Produces:
 * - Product images (enhanced selection using audio context)
 * - metadata.json file with e-commerce data (visual + audio)
 */
export const fullProductAnalysisStack: StackTemplate = {
  id: 'full_product_analysis',
  name: 'Full Product Analysis Pipeline',
  description: 'Extract audio first for context, then analyze video with enhanced AI classification',
  steps: [
    { processor: 'download' },
    { processor: 'extract-audio' },           // Extract audio track
    { processor: 'gemini-audio-analysis' },   // Transcribe + extract metadata
    { processor: 'extract-frames' },          // Dense frame extraction
    { processor: 'score-frames' },            // Sharpness + motion scoring
    { processor: 'gemini-classify' },         // ENHANCED: Uses audio context
    { processor: 'save-frame-records' },
    { processor: 'claid-bg-remove' },
    { processor: 'fill-product-holes' },
    { processor: 'center-product' },
    { processor: 'stability-commercial' },    // Generate commercial images first (at original resolution)
    { processor: 'stability-upscale' },       // Upscale product images to higher resolution
    { processor: 'upload-frames' },
    { processor: 'complete-job' },            // Also uploads metadata.json
  ],
};

/**
 * Audio Metadata Only stack
 *
 * Minimal pipeline that only extracts and analyzes audio for metadata.
 * Does not process video frames. Useful for quickly extracting product
 * information from seller narration.
 *
 * Produces:
 * - metadata.json with product information from audio
 */
export const audioMetadataOnlyStack: StackTemplate = {
  id: 'audio_metadata_only',
  name: 'Audio Metadata Only Pipeline',
  description: 'Extract audio and generate product metadata without video processing',
  steps: [
    { processor: 'download' },
    { processor: 'extract-audio' },
    { processor: 'gemini-audio-analysis' },
    { processor: 'complete-job' },
  ],
};

/**
 * Stability AI Background Removal Test Stack
 *
 * Uses Stability AI's remove-background API instead of Claid.
 * Good for testing Stability AI integration and comparing results.
 *
 * Flow: Download → Gemini Video Analysis → Stability BG Remove → Center → Upload → Complete
 */
export const stabilityBgRemovalStack: StackTemplate = {
  id: 'stability_bg_removal',
  name: 'Stability AI Background Removal',
  description: 'Test pipeline using Stability AI for background removal',
  steps: [
    { processor: 'download' },
    { processor: 'gemini-video-analysis' },
    { processor: 'save-frame-records' },
    { processor: 'stability-bg-remove' },
    { processor: 'center-product' },
    { processor: 'upload-frames' },
    { processor: 'complete-job' },
  ],
};

/**
 * Unified Video Analyzer Stack
 *
 * Most efficient pipeline: combines audio + video analysis in a SINGLE Gemini API call.
 * This replaces: extract-audio, gemini-audio-analysis, extract-frames, score-frames,
 * gemini-classify, and save-frame-records with a single unified processor.
 *
 * Flow: Download → Unified Video Analyzer → Claid BG Remove → Fill Holes → Center → Upload → Generate Commercial → Complete
 *
 * Benefits:
 * - Single API call for both audio transcription and frame selection
 * - Cross-modal context (audio informs frame selection)
 * - Only extracts selected frames (not all frames)
 * - More cost-efficient (fewer API calls)
 *
 * Produces:
 * - Product images (selected using audio + visual context)
 * - metadata.json with e-commerce data (from audio transcription)
 */
export const unifiedVideoAnalyzerStack: StackTemplate = {
  id: 'unified_video_analyzer',
  name: 'Unified Video Analyzer Pipeline',
  description: 'Single Gemini call for audio + video analysis, most efficient pipeline',
  steps: [
    { processor: 'download' },
    { processor: 'gemini-unified-video-analyzer' },  // Combines 6 processors into 1
    { processor: 'claid-bg-remove' },
    { processor: 'fill-product-holes' },
    { processor: 'center-product' },
    { processor: 'stability-commercial' },           // Generate commercial images first (at original resolution)
    { processor: 'stability-upscale' },              // Upscale product images to higher resolution
    { processor: 'upload-frames' },
    { processor: 'complete-job' },
  ],
};

/**
 * Unified Video Analyzer (Minimal) Stack
 *
 * Minimal version of unified pipeline - no commercial image generation.
 *
 * Flow: Download → Unified Video Analyzer → Claid BG Remove → Center → Upload → Complete
 */
export const unifiedVideoAnalyzerMinimalStack: StackTemplate = {
  id: 'unified_video_analyzer_minimal',
  name: 'Unified Video Analyzer (Minimal)',
  description: 'Unified analysis without commercial image generation',
  steps: [
    { processor: 'download' },
    { processor: 'gemini-unified-video-analyzer' },
    { processor: 'claid-bg-remove' },
    { processor: 'center-product' },
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
  full_product_analysis: fullProductAnalysisStack,
  audio_metadata_only: audioMetadataOnlyStack,
  stability_bg_removal: stabilityBgRemovalStack,
  unified_video_analyzer: unifiedVideoAnalyzerStack,
  unified_video_analyzer_minimal: unifiedVideoAnalyzerMinimalStack,
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

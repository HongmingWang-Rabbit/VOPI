/**
 * Processor Implementations
 *
 * Exports all processor implementations for registration.
 * Organized by category:
 * - storage/  - IO operations (download, upload)
 * - ffmpeg/   - Video processing
 * - sharp/    - Image processing (CPU)
 * - gemini/   - Google Gemini AI
 * - photoroom/ - Photoroom API
 * - claid/    - Claid API
 * - db/       - Database operations
 * - util/     - Pure logic utilities
 */

// Storage processors
export { downloadProcessor } from './storage/download.js';
export { uploadFramesProcessor } from './storage/upload-frames.js';

// FFmpeg processors
export { extractFramesProcessor } from './ffmpeg/extract-frames.js';
export { extractAudioProcessor } from './ffmpeg/extract-audio.js';

// Sharp (image processing) processors
export { centerProductProcessor } from './sharp/center-product.js';
export { detectHolesDebugProcessor } from './sharp/detect-holes-debug.js';
export { fillProductHolesProcessor } from './sharp/fill-product-holes.js';
export { rotateImageProcessor } from './sharp/rotate-image.js';
export { scoreFramesProcessor } from './sharp/score-frames.js';

// Gemini AI processors
export { geminiClassifyProcessor } from './gemini/gemini-classify.js';
export { geminiVideoAnalysisProcessor } from './gemini/gemini-video-analysis.js';
export { geminiAudioAnalysisProcessor } from './gemini/gemini-audio-analysis.js';
export { geminiUnifiedVideoAnalyzerProcessor } from './gemini/gemini-unified-video-analyzer.js';
export { geminiImageGenerateProcessor } from './gemini/gemini-image-generate.js';
export { geminiQualityFilterProcessor } from './gemini/gemini-quality-filter.js';

// Photoroom API processors
export { photoroomBgRemoveProcessor } from './photoroom/photoroom-bg-remove.js';
export { extractProductsProcessor } from './photoroom/extract-products.js';
export { generateCommercialProcessor } from './photoroom/generate-commercial.js';

// Claid API processors
export { claidBgRemoveProcessor } from './claid/claid-bg-remove.js';

// Stability AI processors
export { stabilityBgRemoveProcessor } from './stability/stability-bg-remove.js';
export { stabilityUpscaleProcessor } from './stability/stability-upscale.js';
export { stabilityCommercialProcessor } from './stability/stability-commercial.js';

// Database processors
export { saveFrameRecordsProcessor } from './db/save-frame-records.js';
export { completeJobProcessor } from './db/complete-job.js';

// Utility processors
export { filterByScoreProcessor } from './util/filter-by-score.js';

// Import all for registration
import type { Processor } from '../types.js';
import { downloadProcessor } from './storage/download.js';
import { uploadFramesProcessor } from './storage/upload-frames.js';
import { extractFramesProcessor } from './ffmpeg/extract-frames.js';
import { extractAudioProcessor } from './ffmpeg/extract-audio.js';
import { centerProductProcessor } from './sharp/center-product.js';
import { detectHolesDebugProcessor } from './sharp/detect-holes-debug.js';
import { fillProductHolesProcessor } from './sharp/fill-product-holes.js';
import { rotateImageProcessor } from './sharp/rotate-image.js';
import { scoreFramesProcessor } from './sharp/score-frames.js';
import { geminiClassifyProcessor } from './gemini/gemini-classify.js';
import { geminiVideoAnalysisProcessor } from './gemini/gemini-video-analysis.js';
import { geminiAudioAnalysisProcessor } from './gemini/gemini-audio-analysis.js';
import { geminiUnifiedVideoAnalyzerProcessor } from './gemini/gemini-unified-video-analyzer.js';
import { geminiImageGenerateProcessor } from './gemini/gemini-image-generate.js';
import { geminiQualityFilterProcessor } from './gemini/gemini-quality-filter.js';
import { photoroomBgRemoveProcessor } from './photoroom/photoroom-bg-remove.js';
import { extractProductsProcessor } from './photoroom/extract-products.js';
import { generateCommercialProcessor } from './photoroom/generate-commercial.js';
import { claidBgRemoveProcessor } from './claid/claid-bg-remove.js';
import { stabilityBgRemoveProcessor } from './stability/stability-bg-remove.js';
import { stabilityUpscaleProcessor } from './stability/stability-upscale.js';
import { stabilityCommercialProcessor } from './stability/stability-commercial.js';
import { saveFrameRecordsProcessor } from './db/save-frame-records.js';
import { completeJobProcessor } from './db/complete-job.js';
import { filterByScoreProcessor } from './util/filter-by-score.js';

/**
 * All processor implementations
 */
export const allProcessors: Processor[] = [
  // Storage
  downloadProcessor,
  uploadFramesProcessor,
  // FFmpeg
  extractFramesProcessor,
  extractAudioProcessor,
  // Sharp
  centerProductProcessor,
  detectHolesDebugProcessor,
  fillProductHolesProcessor,
  rotateImageProcessor,
  scoreFramesProcessor,
  // Gemini
  geminiClassifyProcessor,
  geminiVideoAnalysisProcessor,
  geminiAudioAnalysisProcessor,
  geminiUnifiedVideoAnalyzerProcessor,
  geminiImageGenerateProcessor,
  geminiQualityFilterProcessor,
  // Photoroom
  photoroomBgRemoveProcessor,
  extractProductsProcessor,
  generateCommercialProcessor,
  // Claid
  claidBgRemoveProcessor,
  // Stability AI
  stabilityBgRemoveProcessor,
  stabilityUpscaleProcessor,
  stabilityCommercialProcessor,
  // Database
  saveFrameRecordsProcessor,
  completeJobProcessor,
  // Utility
  filterByScoreProcessor,
];

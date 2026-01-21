import type { VideoMetadata } from '../../types/job.types.js';

/**
 * Extracted frame data
 */
export interface ExtractedFrame {
  filename: string;
  path: string;
  index: number;
  timestamp: number;
  frameId: string;
}

/**
 * Frame extraction options
 */
export interface FrameExtractionOptions {
  /** Frames per second to extract */
  fps?: number;
  /** Output format (png, jpg) */
  format?: 'png' | 'jpg';
  /** Quality for jpg output (1-100) */
  quality?: number;
}

/**
 * VideoExtractionProvider Interface
 *
 * Implementations: FFmpegProvider, etc.
 *
 * This provider handles video analysis and frame extraction.
 */
export interface VideoExtractionProvider {
  /** Provider identifier for logging/metrics */
  readonly providerId: string;

  /**
   * Get video metadata
   * @param videoPath - Path to video file
   */
  getMetadata(videoPath: string): Promise<VideoMetadata>;

  /**
   * Extract frames from video at specified FPS
   * @param videoPath - Path to video file
   * @param outputDir - Directory for extracted frames
   * @param options - Extraction options
   */
  extractFrames(
    videoPath: string,
    outputDir: string,
    options?: FrameExtractionOptions
  ): Promise<ExtractedFrame[]>;

  /**
   * Extract a single frame at a specific timestamp
   * @param videoPath - Path to video file
   * @param outputPath - Path for output frame
   * @param timestamp - Timestamp in seconds
   */
  extractFrameAt(
    videoPath: string,
    outputPath: string,
    timestamp: number
  ): Promise<ExtractedFrame>;

  /**
   * Check if provider is available (e.g., FFmpeg installed)
   */
  isAvailable(): boolean;
}

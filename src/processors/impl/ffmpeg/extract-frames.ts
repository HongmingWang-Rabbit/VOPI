/**
 * Extract Frames Processor
 *
 * Extracts frames from video using FFmpeg at configured FPS.
 */

import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { videoService } from '../../../services/video.service.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { PROGRESS } from '../../constants.js';
import { saveVideoRecord } from '../../utils/index.js';

const logger = createChildLogger({ service: 'processor:extract-frames' });

export const extractFramesProcessor: Processor = {
  id: 'extract-frames',
  displayName: 'Extract Frames',
  statusKey: JobStatus.EXTRACTING,
  io: {
    requires: ['video'],
    produces: ['images', 'frames'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, config, workDirs, onProgress, job } = context;

    if (!data.video?.path) {
      return { success: false, error: 'No video path provided' };
    }

    const videoPath = data.video.path;
    const fps = (options?.fps as number) ?? config.fps;

    logger.info({ jobId, videoPath, fps }, 'Extracting frames');

    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: PROGRESS.EXTRACT_FRAMES.ANALYZING,
      message: 'Analyzing video',
    });

    // Get video metadata
    const metadata = await videoService.getMetadata(videoPath);

    // Save video record to database
    const video = await saveVideoRecord({
      jobId,
      sourceUrl: job.videoUrl,
      localPath: videoPath,
      metadata,
    });

    await onProgress?.({
      status: JobStatus.EXTRACTING,
      percentage: PROGRESS.EXTRACT_FRAMES.EXTRACTING,
      message: 'Extracting frames',
    });

    // Extract frames
    const extractedFrames = await videoService.extractFramesDense(videoPath, workDirs.frames, {
      fps,
    });

    // Convert to FrameMetadata format
    const frames: FrameMetadata[] = extractedFrames.map((frame, index) => ({
      frameId: frame.frameId,
      filename: frame.filename,
      path: frame.path,
      timestamp: frame.timestamp,
      index,
    }));

    const imagePaths = frames.map((f) => f.path);

    logger.info({ jobId, frameCount: frames.length }, 'Frames extracted');

    return {
      success: true,
      data: {
        video: {
          ...data.video,
          metadata,
          dbId: video.id,
        },
        images: imagePaths,
        frames,
        metadata: { videoMetadata: metadata },
      },
    };
  },
};

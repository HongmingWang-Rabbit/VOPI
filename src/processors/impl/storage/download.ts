/**
 * Download Processor
 *
 * Downloads video from URL to local storage.
 */

import path from 'path';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { storageService } from '../../../services/storage.service.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { PROGRESS, DEFAULT_VIDEO_FILENAME } from '../../constants.js';

const logger = createChildLogger({ service: 'processor:download' });

export const downloadProcessor: Processor = {
  id: 'download',
  displayName: 'Download Video',
  statusKey: JobStatus.DOWNLOADING,
  io: {
    requires: ['video'],  // Needs video.sourceUrl to know where to download from
    produces: ['video'],  // Outputs video.path after downloading
    // No metadata requirements or productions
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { job, jobId, workDirs, onProgress } = context;

    // Get video URL from pipeline data first, fall back to job.videoUrl for backwards compatibility
    const videoUrl = data.video?.sourceUrl || job.videoUrl;

    if (!videoUrl) {
      return { success: false, error: 'No video URL provided in data.video.sourceUrl or job.videoUrl' };
    }

    logger.info({ jobId, videoUrl }, 'Downloading video');

    await onProgress?.({
      status: JobStatus.DOWNLOADING,
      percentage: PROGRESS.DOWNLOAD.START,
      message: 'Downloading video',
    });

    const videoPath = path.join(workDirs.video, DEFAULT_VIDEO_FILENAME);
    await storageService.downloadFromUrl(videoUrl, videoPath);

    logger.info({ jobId, videoPath }, 'Video downloaded');

    return {
      success: true,
      data: {
        video: {
          path: videoPath,
          sourceUrl: videoUrl,
        },
      },
    };
  },
};

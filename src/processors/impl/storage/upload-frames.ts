/**
 * Upload Frames Processor
 *
 * Uploads final frames to S3 and updates database records.
 */

import { copyFile } from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult } from '../../types.js';
import { storageService } from '../../../services/storage.service.js';
import { getDatabase, schema } from '../../../db/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';

const logger = createChildLogger({ service: 'processor:upload-frames' });

export const uploadFramesProcessor: Processor = {
  id: 'upload-frames',
  displayName: 'Upload Frames',
  statusKey: JobStatus.GENERATING,
  io: {
    requires: ['images', 'frames'],
    produces: ['text'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress, timer } = context;
    const db = getDatabase();

    const frames = data.recommendedFrames || data.frames;
    if (!frames || frames.length === 0) {
      return { success: false, error: 'No frames to upload' };
    }

    const frameRecords = data.frameRecords || new Map();

    logger.info({ jobId, frameCount: frames.length }, 'Uploading frames');

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: 70,
      message: 'Preparing final frames',
    });

    const finalFrameUrls: string[] = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const progress = 70 + Math.round(((i + 1) / frames.length) * 5);

      await onProgress?.({
        status: JobStatus.GENERATING,
        percentage: progress,
        message: `Uploading frame ${i + 1}/${frames.length}`,
      });

      // Create final filename
      const outputFilename = frame.recommendedType
        ? `${frame.recommendedType}_${frame.frameId}_t${frame.timestamp.toFixed(2)}.png`
        : `${frame.frameId}_t${frame.timestamp.toFixed(2)}.png`;

      // Copy to final directory
      const localPath = path.join(workDirs.final, outputFilename);
      await copyFile(frame.path, localPath);

      // Upload to S3
      const s3Key = storageService.getJobKey(jobId, 'frames', outputFilename);
      const { url } = await timer.timeOperation(
        's3_upload_frame',
        () => storageService.uploadFile(localPath, s3Key),
        { frameId: frame.frameId }
      );

      finalFrameUrls.push(url);

      // Update frame record with S3 URL
      const frameDbId = frameRecords.get(frame.frameId);
      if (frameDbId) {
        await db
          .update(schema.frames)
          .set({ s3Url: url })
          .where(eq(schema.frames.id, frameDbId));
      }
    }

    logger.info({ jobId, uploadedCount: finalFrameUrls.length }, 'Frames uploaded');

    return {
      success: true,
      data: {
        uploadedUrls: finalFrameUrls,
        text: JSON.stringify(finalFrameUrls),
      },
    };
  },
};

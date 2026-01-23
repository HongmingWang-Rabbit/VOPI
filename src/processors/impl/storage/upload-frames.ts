/**
 * Upload Frames Processor
 *
 * Uploads final frames to S3 and updates database records.
 */

import { copyFile } from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import type { Processor, ProcessorContext, PipelineData, ProcessorResult, FrameMetadata } from '../../types.js';
import { getInputFrames, getFrameDbIdMap } from '../../types.js';
import { storageService } from '../../../services/storage.service.js';
import { getDatabase, schema } from '../../../db/index.js';
import { JobStatus } from '../../../types/job.types.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parallelMap, isParallelError } from '../../../utils/parallel.js';
import { getConcurrency } from '../../concurrency.js';

const logger = createChildLogger({ service: 'processor:upload-frames' });

export const uploadFramesProcessor: Processor = {
  id: 'upload-frames',
  displayName: 'Upload Frames',
  statusKey: JobStatus.GENERATING,
  io: {
    requires: ['images', 'frames'],
    produces: ['text', 'frames.s3Url'],
  },

  async execute(
    context: ProcessorContext,
    data: PipelineData,
    _options?: Record<string, unknown>
  ): Promise<ProcessorResult> {
    const { jobId, workDirs, onProgress, timer } = context;
    const db = getDatabase();

    // Get input frames with fallback to legacy fields
    const inputFrames = getInputFrames(data);
    if (inputFrames.length === 0) {
      return { success: false, error: 'No frames to upload' };
    }

    // Get frameId -> dbId mapping (handles both legacy and new formats)
    const frameRecords = getFrameDbIdMap(data);

    logger.info({ jobId, frameCount: inputFrames.length }, 'Uploading frames');

    await onProgress?.({
      status: JobStatus.GENERATING,
      percentage: 70,
      message: 'Preparing final frames',
    });

    // Upload frames in parallel for better throughput
    const concurrency = getConcurrency('S3_UPLOAD', _options);
    let uploadedCount = 0;

    interface UploadResult {
      frame: FrameMetadata;
      url: string;
      frameDbId?: string;
    }

    const uploadResults = await parallelMap(
      inputFrames,
      async (frame): Promise<UploadResult> => {
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

        // Update progress
        uploadedCount++;
        await onProgress?.({
          status: JobStatus.GENERATING,
          percentage: 70 + Math.round((uploadedCount / inputFrames.length) * 5),
          message: `Uploading frame ${uploadedCount}/${inputFrames.length}`,
        });

        const frameDbId = frameRecords.get(frame.frameId) || frame.dbId;
        return { frame: { ...frame, s3Url: url }, url, frameDbId };
      },
      { concurrency }
    );

    // Collect results maintaining order
    const finalFrameUrls: string[] = [];
    const updatedFrames: FrameMetadata[] = [];
    const dbUpdates: Array<{ frameDbId: string; url: string }> = [];

    for (let i = 0; i < inputFrames.length; i++) {
      const result = uploadResults.results[i];

      if (isParallelError(result)) {
        logger.error({ frameId: inputFrames[i].frameId, error: result.message }, 'Frame upload failed');
        // Keep original frame without s3Url
        updatedFrames.push(inputFrames[i]);
        continue;
      }

      finalFrameUrls.push(result.url);
      updatedFrames.push(result.frame);

      // Collect DB updates for batching
      if (result.frameDbId) {
        dbUpdates.push({ frameDbId: result.frameDbId, url: result.url });
      }
    }

    // Batch DB updates in parallel for better performance
    if (dbUpdates.length > 0) {
      await Promise.all(
        dbUpdates.map(({ frameDbId, url }) =>
          db
            .update(schema.frames)
            .set({ s3Url: url })
            .where(eq(schema.frames.id, frameDbId))
        )
      );
    }

    logger.info({ jobId, uploadedCount: finalFrameUrls.length }, 'Frames uploaded');

    return {
      success: true,
      data: {
        uploadedUrls: finalFrameUrls,
        text: JSON.stringify(finalFrameUrls),
        // New unified metadata
        metadata: {
          ...data.metadata,
          frames: updatedFrames,
        },
      },
    };
  },
};

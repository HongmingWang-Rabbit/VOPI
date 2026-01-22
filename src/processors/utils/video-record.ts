/**
 * Video Record Utility
 *
 * Shared utility for saving video records to the database.
 */

import { getDatabase, schema } from '../../db/index.js';
import type { NewVideo, Video } from '../../db/schema.js';
import type { VideoMetadata } from '../../types/job.types.js';

export interface SaveVideoRecordParams {
  jobId: string;
  sourceUrl: string;
  localPath: string;
  metadata: VideoMetadata;
}

/**
 * Save video record to database
 * @param params - Video record parameters
 * @returns Created video record
 */
export async function saveVideoRecord(params: SaveVideoRecordParams): Promise<Video> {
  const { jobId, sourceUrl, localPath, metadata } = params;
  const db = getDatabase();

  const [video] = await db
    .insert(schema.videos)
    .values({
      jobId,
      sourceUrl,
      localPath,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      codec: metadata.codec,
      metadata,
    } satisfies NewVideo)
    .returning();

  return video;
}

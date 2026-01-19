import { getDatabase, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { NotFoundError } from '../utils/errors.js';
import type { Video, Frame, CommercialImage } from '../db/schema.js';

/**
 * FramesController - handles frame and commercial image retrieval
 */
export class FramesController {
  /**
   * Get video metadata for a job
   */
  async getVideo(jobId: string): Promise<Video> {
    const db = getDatabase();

    const [video] = await db
      .select()
      .from(schema.videos)
      .where(eq(schema.videos.jobId, jobId))
      .limit(1);

    if (!video) {
      throw new NotFoundError(`Video not found for job ${jobId}`);
    }

    return video;
  }

  /**
   * Get all frames for a job
   */
  async getFrames(jobId: string): Promise<Frame[]> {
    const db = getDatabase();

    const frames = await db
      .select()
      .from(schema.frames)
      .where(eq(schema.frames.jobId, jobId))
      .orderBy(schema.frames.timestamp);

    return frames;
  }

  /**
   * Get final selected frames for a job
   */
  async getFinalFrames(jobId: string): Promise<Frame[]> {
    const db = getDatabase();

    const frames = await db
      .select()
      .from(schema.frames)
      .where(
        and(
          eq(schema.frames.jobId, jobId),
          eq(schema.frames.isFinalSelection, true)
        )
      )
      .orderBy(schema.frames.timestamp);

    return frames;
  }

  /**
   * Get a specific frame by ID
   */
  async getFrame(frameId: string): Promise<Frame> {
    const db = getDatabase();

    const [frame] = await db
      .select()
      .from(schema.frames)
      .where(eq(schema.frames.id, frameId))
      .limit(1);

    if (!frame) {
      throw new NotFoundError(`Frame ${frameId} not found`);
    }

    return frame;
  }

  /**
   * Get all commercial images for a job
   */
  async getCommercialImages(jobId: string): Promise<CommercialImage[]> {
    const db = getDatabase();

    const images = await db
      .select()
      .from(schema.commercialImages)
      .where(eq(schema.commercialImages.jobId, jobId));

    return images;
  }

  /**
   * Get commercial images for a specific frame
   */
  async getCommercialImagesForFrame(frameId: string): Promise<CommercialImage[]> {
    const db = getDatabase();

    const images = await db
      .select()
      .from(schema.commercialImages)
      .where(eq(schema.commercialImages.frameId, frameId));

    return images;
  }

  /**
   * Get commercial images grouped by variant
   */
  async getCommercialImagesByVariant(
    jobId: string
  ): Promise<Record<string, Record<string, string>>> {
    const db = getDatabase();

    // Get final frames with their commercial images
    const frames = await db
      .select()
      .from(schema.frames)
      .where(
        and(
          eq(schema.frames.jobId, jobId),
          eq(schema.frames.isFinalSelection, true)
        )
      );

    const result: Record<string, Record<string, string>> = {};

    for (const frame of frames) {
      const images = await db
        .select()
        .from(schema.commercialImages)
        .where(
          and(
            eq(schema.commercialImages.frameId, frame.id),
            eq(schema.commercialImages.success, true)
          )
        );

      const variantKey = `${frame.productId}_${frame.variantId}`;
      result[variantKey] = {};

      for (const image of images) {
        if (image.s3Url) {
          result[variantKey][image.version] = image.s3Url;
        }
      }
    }

    return result;
  }
}

export const framesController = new FramesController();

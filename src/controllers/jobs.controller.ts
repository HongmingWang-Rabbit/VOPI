import { getDatabase, schema } from '../db/index.js';
import { eq, desc, and, SQL, sql, lt } from 'drizzle-orm';
import { createChildLogger } from '../utils/logger.js';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors.js';
import { addPipelineJob } from '../queues/pipeline.queue.js';
import { validateCallbackUrlComprehensive } from '../utils/url-validator.js';
import { creditsService } from '../services/credits.service.js';
import {
  jobConfigSchema,
  type CreateJobRequest,
  type JobListQuery,
  type JobConfig,
  type JobProgress,
} from '../types/job.types.js';
import type { Job, NewJob, ApiKey, User } from '../db/schema.js';
import type { MetadataFileOutput, ProductMetadata } from '../types/product-metadata.types.js';

const logger = createChildLogger({ service: 'jobs-controller' });

/**
 * Buffer multiplier for affordability pre-check.
 * Adds 20% to estimated duration to account for estimation inaccuracies.
 */
const AFFORDABILITY_BUFFER_MULTIPLIER = 1.2;

/**
 * JobsController - handles job CRUD operations
 */
export class JobsController {
  /**
   * Create a new job
   * @param data - Job creation request data
   * @param user - Authenticated user who owns this job
   * @param apiKey - Optional API key record for usage tracking
   */
  async createJob(data: CreateJobRequest, user: User, apiKey?: ApiKey): Promise<Job> {
    const db = getDatabase();

    // Validate callback URL for SSRF protection before starting transaction
    if (data.callbackUrl) {
      const validation = validateCallbackUrlComprehensive(data.callbackUrl);
      if (!validation.valid) {
        throw new BadRequestError(validation.error || 'Invalid callback URL');
      }
    }

    // Data is already validated by route, just parse config defaults
    const config = jobConfigSchema.parse(data.config || {});

    // Check affordability if estimated duration is provided
    // This is a PRE-CHECK only - actual charge happens during processing when we know real duration.
    //
    // IMPORTANT: This pre-check may pass but actual spend may fail if:
    // 1. Actual video duration exceeds estimated duration
    // 2. User spends credits on other jobs between pre-check and processing
    // 3. Multiple concurrent job submissions
    //
    // The actual credit spend happens in the spend-credits processor which will fail the job
    // gracefully if insufficient credits. This pre-check is a UX improvement to catch obvious
    // insufficient balance cases early.
    if (data.estimatedDurationSeconds) {
      // Add buffer to estimate for safety margin
      const bufferedDuration = data.estimatedDurationSeconds * AFFORDABILITY_BUFFER_MULTIPLIER;
      const costEstimate = await creditsService.calculateJobCostWithAffordability(user.id, {
        videoDurationSeconds: bufferedDuration,
      });

      if (!costEstimate.canAfford) {
        throw new ForbiddenError(
          `Insufficient credits. Estimated cost: ${Math.ceil(costEstimate.totalCredits)}, available: ${costEstimate.currentBalance}. Please purchase more credits.`,
          'INSUFFICIENT_CREDITS'
        );
      }

      logger.info(
        {
          userId: user.id,
          estimatedDuration: data.estimatedDurationSeconds,
          bufferedDuration,
          estimatedCost: costEstimate.totalCredits,
          currentBalance: costEstimate.currentBalance,
        },
        'Job affordability pre-check passed'
      );
    }

    // Use transaction to ensure API key increment and job creation are atomic
    const job = await db.transaction(async (tx) => {
      // Atomically increment API key usage count if provided
      if (apiKey) {
        // Single atomic update with optimistic locking - no separate check needed
        const [updated] = await tx
          .update(schema.apiKeys)
          .set({
            usedCount: sql`${schema.apiKeys.usedCount} + 1`,
          })
          .where(
            and(
              eq(schema.apiKeys.id, apiKey.id),
              lt(schema.apiKeys.usedCount, apiKey.maxUses)
            )
          )
          .returning();

        if (!updated) {
          // Usage limit reached (either already at limit or race condition)
          // Transaction will be rolled back automatically
          throw new ForbiddenError(
            `API key usage limit exceeded (limit: ${apiKey.maxUses}). Please contact support.`,
            'USAGE_LIMIT_EXCEEDED'
          );
        }

        logger.info(
          { apiKeyId: apiKey.id, usedCount: updated.usedCount, maxUses: apiKey.maxUses },
          'API key usage incremented'
        );
      }

      // Create the job within the same transaction
      const [createdJob] = await tx
        .insert(schema.jobs)
        .values({
          videoUrl: data.videoUrl,
          config: config as JobConfig,
          callbackUrl: data.callbackUrl,
          status: 'pending',
          userId: user.id,
          apiKeyId: apiKey?.id,
        } satisfies NewJob)
        .returning();

      return createdJob;
    });

    logger.info({ jobId: job.id, videoUrl: job.videoUrl, userId: user.id, apiKeyId: apiKey?.id }, 'Job created');

    // Add to queue (outside transaction - queue operations shouldn't be rolled back)
    await addPipelineJob(job.id);

    return job;
  }

  /**
   * List jobs for a specific user with optional filtering
   * @param userId - The user ID to filter jobs by
   * @param query - Query parameters for filtering and pagination
   */
  async listJobs(userId: string, query: JobListQuery): Promise<{ jobs: Job[]; total: number }> {
    const db = getDatabase();
    // Data is already validated by route
    // Always filter by userId to ensure users only see their own jobs
    const conditions: SQL[] = [eq(schema.jobs.userId, userId)];

    if (query.status) {
      conditions.push(eq(schema.jobs.status, query.status));
    }

    const whereClause = and(...conditions);

    const [jobs, countResult] = await Promise.all([
      db
        .select()
        .from(schema.jobs)
        .where(whereClause)
        .orderBy(desc(schema.jobs.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.jobs)
        .where(whereClause),
    ]);

    return {
      jobs,
      total: Number(countResult[0]?.count || 0),
    };
  }

  /**
   * Get job by ID
   * @param jobId - The job ID to retrieve
   * @param userId - The user ID to verify ownership
   */
  async getJob(jobId: string, userId: string): Promise<Job> {
    const db = getDatabase();

    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId)))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    return job;
  }

  /**
   * Get job status (lightweight)
   * @param jobId - The job ID to retrieve status for
   * @param userId - The user ID to verify ownership
   */
  async getJobStatus(jobId: string, userId: string): Promise<{
    id: string;
    status: string;
    progress: JobProgress | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const db = getDatabase();

    const [job] = await db
      .select({
        id: schema.jobs.id,
        status: schema.jobs.status,
        progress: schema.jobs.progress,
        createdAt: schema.jobs.createdAt,
        updatedAt: schema.jobs.updatedAt,
      })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId)))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    return job;
  }

  /**
   * Cancel a job
   * Uses atomic update with status check to prevent race conditions
   * @param jobId - The job ID to cancel
   * @param userId - The user ID to verify ownership
   */
  async cancelJob(jobId: string, userId: string): Promise<Job> {
    const db = getDatabase();

    // Atomic update: only cancel if status is 'pending' and belongs to user
    const [updated] = await db
      .update(schema.jobs)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId), eq(schema.jobs.status, 'pending')))
      .returning();

    if (!updated) {
      // Check if job exists and belongs to user to provide appropriate error
      const [job] = await db
        .select({ id: schema.jobs.id, status: schema.jobs.status, userId: schema.jobs.userId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, jobId))
        .limit(1);

      if (!job || job.userId !== userId) {
        throw new NotFoundError(`Job ${jobId} not found`);
      }

      throw new BadRequestError(
        `Cannot cancel job in ${job.status} status. Only pending jobs can be cancelled.`
      );
    }

    logger.info({ jobId, userId }, 'Job cancelled');

    return updated;
  }

  /**
   * Delete a job and its associated data
   * @param jobId - The job ID to delete
   * @param userId - The user ID to verify ownership
   */
  async deleteJob(jobId: string, userId: string): Promise<void> {
    const db = getDatabase();

    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId)))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    // Delete job (cascades to related records)
    await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));

    logger.info({ jobId, userId }, 'Job deleted');
  }

  /**
   * Update product metadata for a completed job
   * Allows users to edit AI-extracted metadata before e-commerce upload
   * @param jobId - The job ID to update
   * @param userId - The user ID to verify ownership
   * @param updates - The metadata fields to update
   */
  async updateProductMetadata(
    jobId: string,
    userId: string,
    updates: Partial<ProductMetadata>
  ): Promise<MetadataFileOutput> {
    const db = getDatabase();

    // Get existing job (filtered by userId for ownership verification)
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId)))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    if (!job.productMetadata) {
      throw new BadRequestError(
        'Job has no product metadata. Metadata is only available for jobs processed with audio analysis.'
      );
    }

    // Merge updates into existing product metadata
    const existingMetadata = job.productMetadata as MetadataFileOutput;
    const updatedProduct: ProductMetadata = {
      ...existingMetadata.product,
      ...updates,
      // Preserve confidence but mark as user-edited
      confidence: {
        ...existingMetadata.product.confidence,
        // If user edited, we can assume high confidence
        overall: 100,
        title: updates.title ? 100 : existingMetadata.product.confidence.title,
        description: updates.description ? 100 : existingMetadata.product.confidence.description,
      },
    };

    // Re-format for platforms with updated data
    const { formatForShopify, formatForAmazon, formatForEbay } = await import('../types/product-metadata.types.js');

    const updatedMetadata: MetadataFileOutput = {
      ...existingMetadata,
      product: updatedProduct,
      platforms: {
        shopify: formatForShopify(updatedProduct),
        amazon: formatForAmazon(updatedProduct),
        ebay: formatForEbay(updatedProduct),
      },
    };

    // Update in database
    await db
      .update(schema.jobs)
      .set({
        productMetadata: updatedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, jobId));

    logger.info({ jobId, updatedFields: Object.keys(updates) }, 'Product metadata updated');

    return updatedMetadata;
  }

  /**
   * Get product metadata for a job
   * @param jobId - The job ID to retrieve metadata for
   * @param userId - The user ID to verify ownership
   */
  async getProductMetadata(jobId: string, userId: string): Promise<MetadataFileOutput | null> {
    const db = getDatabase();

    const [job] = await db
      .select({ productMetadata: schema.jobs.productMetadata })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId)))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    return job.productMetadata;
  }
}

export const jobsController = new JobsController();

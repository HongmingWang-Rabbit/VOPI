import { getDatabase, schema } from '../db/index.js';
import { eq, desc, and, SQL, sql, lt } from 'drizzle-orm';
import { createChildLogger } from '../utils/logger.js';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors.js';
import { addPipelineJob } from '../queues/pipeline.queue.js';
import { validateCallbackUrlComprehensive } from '../utils/url-validator.js';
import {
  jobConfigSchema,
  type CreateJobRequest,
  type JobListQuery,
  type JobConfig,
  type JobProgress,
} from '../types/job.types.js';
import type { Job, NewJob, ApiKey } from '../db/schema.js';
import type { MetadataFileOutput, ProductMetadata } from '../types/product-metadata.types.js';

const logger = createChildLogger({ service: 'jobs-controller' });

/**
 * JobsController - handles job CRUD operations
 */
export class JobsController {
  /**
   * Create a new job
   * @param data - Job creation request data
   * @param apiKey - Optional API key record for usage tracking
   */
  async createJob(data: CreateJobRequest, apiKey?: ApiKey): Promise<Job> {
    const db = getDatabase();

    // Atomically increment API key usage count if provided
    if (apiKey) {
      // Single atomic update with optimistic locking - no separate check needed
      const [updated] = await db
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

    // Validate callback URL for SSRF protection
    if (data.callbackUrl) {
      const validation = validateCallbackUrlComprehensive(data.callbackUrl);
      if (!validation.valid) {
        throw new BadRequestError(validation.error || 'Invalid callback URL');
      }
    }

    // Data is already validated by route, just parse config defaults
    const config = jobConfigSchema.parse(data.config || {});

    const [job] = await db
      .insert(schema.jobs)
      .values({
        videoUrl: data.videoUrl,
        config: config as JobConfig,
        callbackUrl: data.callbackUrl,
        status: 'pending',
        apiKeyId: apiKey?.id,
      } satisfies NewJob)
      .returning();

    logger.info({ jobId: job.id, videoUrl: job.videoUrl, apiKeyId: apiKey?.id }, 'Job created');

    // Add to queue
    await addPipelineJob(job.id);

    return job;
  }

  /**
   * List jobs with optional filtering
   */
  async listJobs(query: JobListQuery): Promise<{ jobs: Job[]; total: number }> {
    const db = getDatabase();
    // Data is already validated by route
    const conditions: SQL[] = [];

    if (query.status) {
      conditions.push(eq(schema.jobs.status, query.status));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

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
   */
  async getJob(jobId: string): Promise<Job> {
    const db = getDatabase();

    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    return job;
  }

  /**
   * Get job status (lightweight)
   */
  async getJobStatus(jobId: string): Promise<{
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
      .where(eq(schema.jobs.id, jobId))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    return job;
  }

  /**
   * Cancel a job
   * Uses atomic update with status check to prevent race conditions
   */
  async cancelJob(jobId: string): Promise<Job> {
    const db = getDatabase();

    // Atomic update: only cancel if status is 'pending'
    const [updated] = await db
      .update(schema.jobs)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, 'pending')))
      .returning();

    if (!updated) {
      // Check if job exists to provide appropriate error
      const [job] = await db
        .select({ id: schema.jobs.id, status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, jobId))
        .limit(1);

      if (!job) {
        throw new NotFoundError(`Job ${jobId} not found`);
      }

      throw new BadRequestError(
        `Cannot cancel job in ${job.status} status. Only pending jobs can be cancelled.`
      );
    }

    logger.info({ jobId }, 'Job cancelled');

    return updated;
  }

  /**
   * Delete a job and its associated data
   */
  async deleteJob(jobId: string): Promise<void> {
    const db = getDatabase();

    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    // Delete job (cascades to related records)
    await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));

    logger.info({ jobId }, 'Job deleted');
  }

  /**
   * Update product metadata for a completed job
   * Allows users to edit AI-extracted metadata before e-commerce upload
   */
  async updateProductMetadata(
    jobId: string,
    updates: Partial<ProductMetadata>
  ): Promise<MetadataFileOutput> {
    const db = getDatabase();

    // Get existing job
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
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
   */
  async getProductMetadata(jobId: string): Promise<MetadataFileOutput | null> {
    const db = getDatabase();

    const [job] = await db
      .select({ productMetadata: schema.jobs.productMetadata })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);

    if (!job) {
      throw new NotFoundError(`Job ${jobId} not found`);
    }

    return job.productMetadata;
  }
}

export const jobsController = new JobsController();

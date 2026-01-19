import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, real, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type {
  JobConfig,
  JobProgress,
  JobResult,
  VideoMetadata,
  FrameScores,
  FrameObstructions,
  BackgroundRecommendations,
} from '../types/job.types.js';

/**
 * Jobs table - tracks extraction/commercial jobs
 */
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  videoUrl: text('video_url').notNull(),
  config: jsonb('config').$type<JobConfig>().notNull(),
  progress: jsonb('progress').$type<JobProgress>(),
  result: jsonb('result').$type<JobResult>(),
  error: text('error'),
  callbackUrl: text('callback_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/**
 * Videos table - video metadata
 */
export const videos = pgTable('videos', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  sourceUrl: text('source_url').notNull(),
  localPath: text('local_path'),
  duration: real('duration'),
  width: integer('width'),
  height: integer('height'),
  fps: real('fps'),
  codec: varchar('codec', { length: 50 }),
  metadata: jsonb('metadata').$type<VideoMetadata>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;

/**
 * Frames table - extracted frames
 */
export const frames = pgTable('frames', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  videoId: uuid('video_id')
    .notNull()
    .references(() => videos.id, { onDelete: 'cascade' }),
  frameId: varchar('frame_id', { length: 50 }).notNull(), // e.g., frame_00001
  timestamp: real('timestamp').notNull(), // Timestamp in seconds
  localPath: text('local_path'),
  s3Url: text('s3_url'),
  scores: jsonb('scores').$type<FrameScores>(),
  // Gemini classification
  productId: varchar('product_id', { length: 50 }),
  variantId: varchar('variant_id', { length: 50 }),
  angleEstimate: varchar('angle_estimate', { length: 50 }),
  variantDescription: text('variant_description'),
  obstructions: jsonb('obstructions').$type<FrameObstructions>(),
  backgroundRecommendations: jsonb('background_recommendations').$type<BackgroundRecommendations>(),
  isBestPerSecond: boolean('is_best_per_second').default(false),
  isFinalSelection: boolean('is_final_selection').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Frame = typeof frames.$inferSelect;
export type NewFrame = typeof frames.$inferInsert;

/**
 * Commercial images table - generated commercial images
 */
export const commercialImages = pgTable('commercial_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  frameId: uuid('frame_id')
    .notNull()
    .references(() => frames.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 20 }).notNull(), // transparent, solid, real, creative
  localPath: text('local_path'),
  s3Url: text('s3_url'),
  backgroundColor: varchar('background_color', { length: 20 }),
  backgroundPrompt: text('background_prompt'),
  success: boolean('success').default(true),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type CommercialImage = typeof commercialImages.$inferSelect;
export type NewCommercialImage = typeof commercialImages.$inferInsert;

/**
 * Relations
 */
export const jobsRelations = relations(jobs, ({ one, many }) => ({
  video: one(videos, {
    fields: [jobs.id],
    references: [videos.jobId],
  }),
  frames: many(frames),
  commercialImages: many(commercialImages),
}));

export const videosRelations = relations(videos, ({ one, many }) => ({
  job: one(jobs, {
    fields: [videos.jobId],
    references: [jobs.id],
  }),
  frames: many(frames),
}));

export const framesRelations = relations(frames, ({ one, many }) => ({
  job: one(jobs, {
    fields: [frames.jobId],
    references: [jobs.id],
  }),
  video: one(videos, {
    fields: [frames.videoId],
    references: [videos.id],
  }),
  commercialImages: many(commercialImages),
}));

export const commercialImagesRelations = relations(commercialImages, ({ one }) => ({
  job: one(jobs, {
    fields: [commercialImages.jobId],
    references: [jobs.id],
  }),
  frame: one(frames, {
    fields: [commercialImages.frameId],
    references: [frames.id],
  }),
}));

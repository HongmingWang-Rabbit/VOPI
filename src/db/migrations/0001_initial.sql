-- VOPI Initial Migration
-- Creates all tables for the video processing pipeline

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  video_url TEXT NOT NULL,
  config JSONB NOT NULL,
  progress JSONB,
  result JSONB,
  error TEXT,
  callback_url TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- Videos table
CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  local_path TEXT,
  duration REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  codec VARCHAR(50),
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Frames table
CREATE TABLE IF NOT EXISTS frames (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  frame_id VARCHAR(50) NOT NULL,
  timestamp REAL NOT NULL,
  local_path TEXT,
  s3_url TEXT,
  scores JSONB,
  product_id VARCHAR(50),
  variant_id VARCHAR(50),
  angle_estimate VARCHAR(50),
  variant_description TEXT,
  obstructions JSONB,
  background_recommendations JSONB,
  is_best_per_second BOOLEAN DEFAULT FALSE,
  is_final_selection BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Commercial images table
CREATE TABLE IF NOT EXISTS commercial_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  frame_id UUID NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  local_path TEXT,
  s3_url TEXT,
  background_color VARCHAR(20),
  background_prompt TEXT,
  success BOOLEAN DEFAULT TRUE,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_job_id ON videos(job_id);
CREATE INDEX IF NOT EXISTS idx_frames_job_id ON frames(job_id);
CREATE INDEX IF NOT EXISTS idx_frames_video_id ON frames(video_id);
CREATE INDEX IF NOT EXISTS idx_frames_is_final ON frames(is_final_selection) WHERE is_final_selection = TRUE;
CREATE INDEX IF NOT EXISTS idx_commercial_images_job_id ON commercial_images(job_id);
CREATE INDEX IF NOT EXISTS idx_commercial_images_frame_id ON commercial_images(frame_id);

-- Updated at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

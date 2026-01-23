-- Migration: Replace metadata_s3_url with product_metadata JSONB
-- This migration removes the metadata_s3_url column and adds a product_metadata JSONB column

-- Drop the old metadata_s3_url column (if it exists)
ALTER TABLE jobs DROP COLUMN IF EXISTS metadata_s3_url;

-- Add the new product_metadata JSONB column
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS product_metadata JSONB;

-- Add comment for documentation
COMMENT ON COLUMN jobs.product_metadata IS 'Product metadata extracted from audio analysis (transcript, e-commerce data)';

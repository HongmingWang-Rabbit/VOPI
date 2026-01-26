-- Migration: Add performance indexes for common query patterns
-- Created: 2026-01-26

-- Index on jobs.user_id for user job listings
-- Used by: jobsController.listJobs, jobsController.getJob, etc.
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);

-- Index on jobs.status for status-based filtering
-- Used by: job listing filters, worker queries
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Composite index for user + status queries (most common pattern)
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);

-- Index on platform_connections.token_expires_at for token refresh queries
-- Used by: tokenRefreshService.refreshExpiringTokens
CREATE INDEX IF NOT EXISTS idx_platform_connections_token_expires
ON platform_connections(token_expires_at)
WHERE token_expires_at IS NOT NULL AND status = 'active';

-- Index on refresh_tokens for token lookup and cleanup
-- Used by: authService.refreshAccessToken
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- Index on oauth_accounts for user lookup
-- Used by: findOrCreateUserFromOAuth
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id);

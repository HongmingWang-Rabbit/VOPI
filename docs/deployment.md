# Deployment Guide

This guide covers local development setup, Docker deployment, and production considerations.

## Prerequisites

- **Docker & Docker Compose** (for containerized deployment)
- **Node.js 20+** (for local development)
- **pnpm** (package manager)
- **FFmpeg** (for local development without Docker)

## Quick Start with Docker

The fastest way to run VOPI is with Docker Compose:

```bash
# Clone and enter directory
git clone <repo-url>
cd vopi

# Copy environment file
cp .env.example .env

# Add your API keys to .env
# GOOGLE_AI_API_KEY=your_key
# CLAID_API_KEY=your_key
# STABILITY_API_KEY=your_key
# PHOTOROOM_API_KEY=your_key

# Start all services
docker compose up
```

Access:
- API: http://localhost:3000
- Swagger UI: http://localhost:3000/docs
- MinIO Console: http://localhost:9001 (minioadmin/minioadmin)

---

## Local Development Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Start Infrastructure

Start only the infrastructure services (database, Redis, MinIO):

```bash
docker compose up -d postgres redis minio minio-init
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```env
# Required for AI classification
GOOGLE_AI_API_KEY=your_google_ai_key

# Required for background removal
CLAID_API_KEY=your_claid_key

# Required for hole filling (inpainting)
STABILITY_API_KEY=your_stability_key

# Optional (for commercial image generation)
PHOTOROOM_API_KEY=your_photoroom_key
```

### 4. Initialize Database

```bash
pnpm db:migrate
```

### 5. Run Development Servers

Run API and worker in separate terminals:

```bash
# Terminal 1: API server
pnpm dev

# Terminal 2: Worker
pnpm dev:worker
```

Both servers support hot reload via tsx.

---

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@localhost:5432/vopi` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `API_KEYS` | Comma-separated valid API keys | `key1,key2,key3` |
| `S3_BUCKET` | S3 bucket name | `vopi-storage` |
| `S3_ENDPOINT` | S3-compatible storage endpoint | `http://localhost:9000` (MinIO) or `https://s3.us-east-1.amazonaws.com` (AWS) |
| `S3_ACCESS_KEY_ID` | S3 access key | `minioadmin` |
| `S3_SECRET_ACCESS_KEY` | S3 secret key | `minioadmin` |
| `GOOGLE_AI_API_KEY` | Google AI API key | `AIza...` |
| `CLAID_API_KEY` | Claid.ai API key | `ca_...` |
| `STABILITY_API_KEY` | Stability AI API key | `sk-...` |
| `PHOTOROOM_API_KEY` | Photoroom API key | `pk_...` |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment mode |
| `PORT` | `3000` | API server port |
| `HOST` | `0.0.0.0` | API server host |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_FORCE_PATH_STYLE` | `false` | Use path-style URLs (required for MinIO) |
| `WORKER_CONCURRENCY` | `2` | Concurrent jobs per worker |
| `JOB_TIMEOUT_MS` | `600000` | Job timeout (10 minutes) |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |

### Database Pool Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_MAX` | `20` | Maximum connections in pool |
| `DB_POOL_IDLE_TIMEOUT_MS` | `30000` | Idle connection timeout |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | `2000` | Connection acquisition timeout |

### Worker & Callback Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMP_DIR_NAME` | `vopi` | Temp directory name under system temp |
| `CALLBACK_TIMEOUT_MS` | `30000` | Webhook callback timeout |
| `CALLBACK_MAX_RETRIES` | `3` | Max callback retry attempts |
| `API_RETRY_DELAY_MS` | `2000` | Base delay for API retries |
| `API_RATE_LIMIT_DELAY_MS` | `500` | Delay between API calls |

### Upload Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PRESIGN_EXPIRATION_SECONDS` | `3600` | Presigned URL expiration (60-86400 seconds) |

### Queue Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QUEUE_JOB_ATTEMPTS` | `3` | Max job retry attempts |
| `QUEUE_BACKOFF_DELAY_MS` | `5000` | Base backoff delay |
| `QUEUE_COMPLETED_AGE_SECONDS` | `86400` | Keep completed jobs for 24h |
| `QUEUE_FAILED_AGE_SECONDS` | `604800` | Keep failed jobs for 7 days |
| `QUEUE_COMPLETED_COUNT` | `100` | Max completed jobs to keep |
| `QUEUE_FAILED_COUNT` | `1000` | Max failed jobs to keep |

### CORS & Security Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ALLOWED_DOMAINS` | `24rabbit\.com` | Comma-separated allowed CORS domains (regex) |
| `AUTH_SKIP_PATHS` | `/health,/ready,/docs` | Paths that skip authentication |
| `CALLBACK_ALLOWED_DOMAINS` | `` | Allowed callback domains (SSRF protection) |
| `ADMIN_API_KEYS` | `` | Comma-separated admin API keys (for config management) |

### OAuth & Platform Connection Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_SUCCESS_REDIRECT_URL` | `/api/v1/oauth/success` | Redirect URL after successful platform OAuth callback |
| `OAUTH_ALLOWED_REDIRECT_SCHEMES` | `` | Comma-separated allowed custom URL schemes for OAuth `successRedirect` param (e.g., `myapp,vopi`). Prevents open redirects; `https://` is never permitted |
| `SHOPIFY_API_KEY` | - | Shopify app API key |
| `SHOPIFY_API_SECRET` | - | Shopify app API secret (used for HMAC verification) |
| `SHOPIFY_SCOPES` | `write_products,read_products` | Shopify OAuth scopes |
| `AMAZON_CLIENT_ID` | - | Amazon SP-API client ID |
| `AMAZON_CLIENT_SECRET` | - | Amazon SP-API client secret |
| `EBAY_CLIENT_ID` | - | eBay API client ID |
| `EBAY_CLIENT_SECRET` | - | eBay API client secret |
| `EBAY_REDIRECT_URI` | - | eBay OAuth redirect URI |
| `EBAY_ENVIRONMENT` | `production` | eBay environment (`sandbox` or `production`) |
| `TOKEN_ENCRYPTION_KEY` | - | 32+ character key for encrypting stored OAuth tokens |
| `TOKEN_REFRESH_INTERVAL_MS` | `300000` | Background token refresh check interval (5 min) |
| `TOKEN_REFRESH_THRESHOLD_MS` | `900000` | Refresh tokens expiring within this window (15 min) |

### Runtime Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_CACHE_TTL_MS` | `60000` | Config cache time-to-live in milliseconds |

### External API Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model to use |
| `PHOTOROOM_BASIC_HOST` | `sdk.photoroom.com` | Photoroom basic API host |
| `PHOTOROOM_PLUS_HOST` | `image-api.photoroom.com` | Photoroom plus API host |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg binary |
| `FFPROBE_PATH` | `ffprobe` | Path to FFprobe binary |

---

## Docker Compose Services

### Full Stack

```bash
docker compose up
```

Starts all services:
- `api` - Fastify API server
- `worker` - BullMQ job processor
- `postgres` - PostgreSQL 16 database
- `redis` - Redis 7 for job queue
- `minio` - S3-compatible storage
- `minio-init` - Creates default bucket

### Infrastructure Only

For local development:

```bash
docker compose up -d postgres redis minio minio-init
```

### Individual Services

```bash
# Rebuild and start API only
docker compose up --build api

# View logs
docker compose logs -f worker

# Stop all
docker compose down

# Stop and remove volumes
docker compose down -v
```

---

## Docker Build

### Dockerfile Overview

The Dockerfile uses a multi-stage build:

1. **Builder stage**: Install dependencies with pnpm, compile TypeScript
2. **Production stage**: Minimal Node.js image with FFmpeg

### Build Arguments

```bash
docker build -t vopi-backend .
```

### Run Container

```bash
docker run -d \
  --name vopi-api \
  -p 3000:3000 \
  -e DATABASE_URL=postgres://... \
  -e REDIS_URL=redis://... \
  -e GOOGLE_AI_API_KEY=... \
  vopi-backend
```

---

## Database Management

### Migrations

```bash
# Run migrations
pnpm db:migrate

# Generate migration from schema changes
pnpm db:generate

# Push schema directly (dev only, may lose data)
pnpm db:push

# Open Drizzle Studio
pnpm db:studio
```

### Backup

```bash
# Backup database
docker compose exec postgres pg_dump -U postgres vopi > backup.sql

# Restore database
cat backup.sql | docker compose exec -T postgres psql -U postgres vopi
```

---

## Production Deployment

### Health Checks

The API provides health check endpoints:

- `GET /health` - Liveness probe (always returns 200 if server running)
- `GET /ready` - Readiness probe (checks database and Redis)

### Scaling

**API Servers**:
- Stateless, can run multiple replicas
- Use load balancer for distribution
- Configure `PORT` for different instances

**Workers**:
- Can run multiple replicas
- Each worker processes jobs independently
- Adjust `WORKER_CONCURRENCY` based on resources

### Resource Requirements

| Service | CPU | Memory | Storage |
|---------|-----|--------|---------|
| API | 0.5 cores | 256 MB | - |
| Worker | 2 cores | 1 GB | 10 GB temp |
| PostgreSQL | 1 core | 512 MB | 10 GB |
| Redis | 0.5 cores | 256 MB | 1 GB |

### Security Considerations

1. **API Keys**: Use strong, unique API keys in production
2. **Admin API Keys**: Configure separate `ADMIN_API_KEYS` for config management endpoints
3. **Network**: Keep database and Redis on private network
4. **S3**: Use IAM roles instead of access keys when possible
5. **Secrets**: Use secret management (Vault, AWS Secrets Manager)
6. **TLS**: Terminate TLS at load balancer
7. **CORS**: Configure `CORS_ALLOWED_DOMAINS` to restrict origins
8. **Callback SSRF Protection**: Set `CALLBACK_ALLOWED_DOMAINS` to whitelist webhook destinations
9. **Timing-Safe Auth**: API key validation uses constant-time comparison to prevent timing attacks
10. **Trust Proxy**: Fastify is configured with `trustProxy: 1` for correct `request.protocol` detection behind reverse proxy. Adjust this value if you have multiple proxy layers
11. **OAuth Open Redirect Prevention**: The `OAUTH_ALLOWED_REDIRECT_SCHEMES` env var controls which custom URL schemes are permitted in the `successRedirect` parameter. HTTPS is never allowed to prevent open redirects to arbitrary domains
12. **OAuth XSS Prevention**: The OAuth success page uses a whitelist lookup for platform names rather than rendering user-supplied query parameters

### Logging

VOPI uses Pino for JSON logging. Configure `LOG_LEVEL` for verbosity:

```bash
# Development
LOG_LEVEL=debug

# Production
LOG_LEVEL=info
```

### Monitoring

Recommended monitoring points:

- Job queue depth (Redis `LLEN pipeline:wait`)
- Job completion rate
- API response times
- External API error rates (Gemini, Photoroom)
- Storage usage

---

## AWS S3 Configuration

For production with AWS S3:

```env
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false
```

> **Note:** `S3_ENDPOINT` is required for all S3-compatible storage providers, including AWS S3.

### Bucket Policy

Ensure the bucket allows public read access for generated images:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    }
  ]
}
```

Or use presigned URLs for private access.

---

## Troubleshooting

### Common Issues

**FFmpeg not found**:
```bash
# Install on macOS
brew install ffmpeg

# Install on Ubuntu
apt-get install ffmpeg
```

**Database connection failed**:
- Check `DATABASE_URL` format
- Ensure PostgreSQL is running
- Verify network connectivity

**Redis connection failed**:
- Check `REDIS_URL` format
- Ensure Redis is running
- Verify network connectivity

**MinIO access denied**:
- Check `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`
- Ensure bucket exists
- Verify `S3_FORCE_PATH_STYLE=true` for MinIO

**Gemini API errors**:
- Verify `GOOGLE_AI_API_KEY` is valid
- Check API quota limits
- Ensure images are under size limits

**Photoroom API errors**:
- Verify `PHOTOROOM_API_KEY` is valid
- Check API quota limits
- Ensure images are valid formats

### Logs

```bash
# Docker Compose logs
docker compose logs -f api worker

# Local development logs are stdout
pnpm dev
```

### Reset Development Environment

```bash
# Stop all services
docker compose down -v

# Remove node_modules
rm -rf node_modules

# Fresh start
pnpm install
docker compose up -d postgres redis minio minio-init
pnpm db:migrate
pnpm dev
```

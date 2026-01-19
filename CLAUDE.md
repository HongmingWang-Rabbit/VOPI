# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VOPI (Video Object Processing Infrastructure) is a TypeScript backend service that extracts high-quality product photography frames from videos using frame scoring algorithms and AI classification (Gemini 2.0). It includes optional commercial image generation via Photoroom API.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript 5.3 (ESM modules)
- **Framework**: Fastify 4.25 with Zod schema validation
- **Database**: PostgreSQL 16 with Drizzle ORM
- **Queue**: Redis 7 + BullMQ for async job processing
- **Storage**: AWS S3 / MinIO (local dev)
- **AI Services**: Google Gemini 2.0 Flash, Photoroom API
- **Video Processing**: FFmpeg (external binary required)

## Common Commands

```bash
# Development (run both in separate terminals)
npm run dev              # API server with hot reload
npm run dev:worker       # Job queue worker with hot reload

# Database
npm run db:migrate       # Run migrations
npm run db:push          # Push schema changes directly
npm run db:studio        # Open Drizzle Studio GUI

# Build & Production
npm run build            # TypeScript compilation
npm run start            # Production API server
npm run start:worker     # Production worker

# Type checking & Linting
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint

# CLI tool (standalone frame extraction)
npm run extract [video.mp4] [options]
npm run extract -- --skip-gemini     # Scoring only, no AI
npm run commercial                    # Generate commercial images
```

## Architecture

### Async Job Processing
Jobs are processed asynchronously through a 6-step pipeline:
1. **Download** - Fetch video from URL
2. **Extract** - Dense frame extraction at configurable FPS via FFmpeg
3. **Score** - Calculate sharpness (Laplacian variance) + motion penalty
4. **Classify** - Send top-K candidates to Gemini for classification
5. **Generate** - Optional commercial image generation (Photoroom)
6. **Upload** - Store results to S3, persist to database

The API (`src/index.ts`) handles HTTP requests while workers (`src/workers/`) process queued jobs independently. This separation allows horizontal scaling of workers.

### Key Directories
- `src/services/` - Core business logic (one service per domain: video, scoring, gemini, photoroom, storage)
- `src/routes/` + `src/controllers/` - HTTP layer
- `src/workers/` - BullMQ job processors
- `src/db/schema.ts` - Drizzle ORM schema (jobs, videos, frames, commercialImages)
- `src/smartFrameExtractor/` - Standalone CLI tool (JavaScript)

### Database Relationships
```
jobs (1) → videos (1) → frames (N) → commercialImages (N)
```
All relationships use cascade delete.

## Local Development Setup

```bash
# Start infrastructure (Postgres, Redis, MinIO)
docker-compose up -d postgres redis minio minio-init

# Configure environment
cp .env.example .env
# Edit .env: add GOOGLE_AI_API_KEY and PHOTOROOM_API_KEY

# Initialize database
npm run db:migrate

# Run services
npm run dev          # Terminal 1
npm run dev:worker   # Terminal 2
```

API docs available at `http://localhost:3000/docs` (Swagger UI)

## API Authentication

All `/api/v1/*` endpoints require `x-api-key` header. Valid keys are configured via `API_KEYS` env var (comma-separated).

## Frame Scoring Algorithm

```
score = sharpness - (alpha × motion × 255)
```
- **Sharpness**: Laplacian variance (high = in-focus)
- **Motion**: Pixel difference with previous frame (low = still moment)
- Temporal diversity enforced via minimum gap between selections

## External Dependencies

- **FFmpeg** must be installed and in PATH
- **Gemini API** for frame classification (cost-optimized: only top-K candidates sent)
- **Photoroom API** for background removal and commercial image generation

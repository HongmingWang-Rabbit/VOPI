# VOPI Documentation

Welcome to the VOPI (Video Object Processing Infrastructure) documentation.

## Overview

VOPI is a TypeScript backend service that automatically extracts high-quality product photography frames from videos using frame scoring algorithms and AI classification. It provides a complete pipeline from video input to production-ready commercial images.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System design, component overview, and data flow |
| [API Reference](./api.md) | Complete REST API documentation |
| [Services](./services.md) | Core service modules and business logic |
| [Database](./database.md) | Schema design and relationships |
| [Deployment](./deployment.md) | Docker setup, configuration, and production deployment |
| [Mobile Integration](./front-end-integration/) | Front-end integration guides for mobile apps |

### Mobile Integration Guides

| Platform | Guide |
|----------|-------|
| iOS | [Swift/SwiftUI Integration](./front-end-integration/ios-integration.md) |
| Android | [Kotlin/Jetpack Compose Integration](./front-end-integration/android-integration.md) |
| React Native | [TypeScript/React Native Integration](./front-end-integration/react-native-integration.md) |
| Flutter | [Dart/Flutter Integration](./front-end-integration/flutter-integration.md) |

## Quick Links

- **API Docs (Swagger)**: `http://localhost:3000/docs` (when running)
- **Main README**: [../README.md](../README.md)
- **Postman Collection**: [../postman/](../postman/)

## CLI Testing Tool

VOPI includes an interactive CLI for manually testing individual pipeline steps:

```bash
pnpm test:cli
```

The menu provides options to test:
1. **Download** - Download video from URL (HTTP/S3)
2. **Extract** - Extract frames from video (FFmpeg)
3. **Score** - Score frames (sharpness/motion)
4. **Classify** - Classify frames with Gemini AI
5. **Generate** - Generate commercial images (Photoroom)
6. **Upload** - Upload to S3/MinIO
7. **S3 Operations** - List, download, delete files
8. **Photoroom Single** - Test individual Photoroom operations

Each test prompts for required inputs and uses real services.

## Key Concepts

### Processing Pipeline

VOPI processes videos through a 6-step asynchronous pipeline:

1. **Download** - Fetch video from URL (HTTP or S3)
2. **Extract** - Dense frame extraction at configurable FPS using FFmpeg
3. **Score** - Calculate quality scores (sharpness + motion analysis)
4. **Classify** - AI-powered variant discovery using Google Gemini 2.0
5. **Generate** - Commercial image generation via Photoroom API
6. **Upload** - Store results to S3 and persist to database

### Frame Selection Algorithm

Frames are scored using a combination of:
- **Sharpness**: Laplacian variance (higher = more in-focus)
- **Motion penalty**: Difference from previous frame (lower = still moment)
- **Temporal diversity**: Minimum gap between selections

### AI Classification

Google Gemini analyzes candidate frames to:
- Discover product variants (colors, sizes, etc.)
- Identify optimal angles (hero, front, back, detail)
- Detect obstructions and recommend cleanup
- Suggest background styles for commercial images

### Commercial Image Versions

Four background versions are generated for each selected frame:

| Version | Description |
|---------|-------------|
| `transparent` | PNG with transparent background |
| `solid` | AI-recommended solid color background |
| `real` | Realistic lifestyle setting |
| `creative` | Artistic/promotional style |

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript 5.3 (ESM modules)
- **Framework**: Fastify 4.25 with Zod schema validation
- **Database**: PostgreSQL 16 with Drizzle ORM
- **Queue**: Redis 7 + BullMQ for async job processing
- **Storage**: AWS S3 / MinIO (local development)
- **AI Services**: Google Gemini 2.0 Flash, Photoroom API
- **Video Processing**: FFmpeg (external binary)

## Getting Started

See [Deployment Guide](./deployment.md) for setup instructions.

# Smart Frame Extraction Pipeline

A robust pipeline for extracting usable, sharp product images from handheld or fast-moving videos.

## Overview

This pipeline behaves like a **junior product photographer**:
- Aggressively discards unusable frames
- Prefers still moments over motion
- Explains its decisions clearly

### Pipeline Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Dense Frame    │     │  Score Frames   │     │ Select Top K    │
│  Extraction     │────▶│  (Sharpness +   │────▶│ with Temporal   │
│  (5 fps)        │     │   Motion)       │     │ Diversity       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Final Frame    │     │  AI Classifies: │     │  Gemini Gets    │
│  Extraction     │◀────│  Hero/Side/     │◀────│  Only Best      │
│  (High Quality) │     │  Detail/Context │     │  Candidates     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Requirements

- **Node.js 18+** (ESM support required)
- **ffmpeg** (installed and in PATH)
- **Google AI API Key** (for Gemini classification)

## Installation

```bash
# Install dependencies
npm install sharp @google/generative-ai

# Set API key
export GOOGLE_AI_API_KEY=your_api_key_here
```

## Usage

### Basic Usage

```bash
node src/smartFrameExtractor/index.js ./product_video.mp4
```

### With Options

```bash
node src/smartFrameExtractor/index.js ./product_video.mp4 \
  --fps 8 \
  --top-k 20 \
  --output ./my_output
```

### Scoring Only (No AI)

```bash
node src/smartFrameExtractor/index.js ./product_video.mp4 --skip-gemini
```

## CLI Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--fps` | `-f` | 5 | Frames per second to extract |
| `--top-k` | `-k` | 12 | Number of candidate frames |
| `--alpha` | `-a` | 0.5 | Motion penalty weight |
| `--min-gap` | `-g` | 0.5 | Min seconds between selections |
| `--output` | `-o` | ./output | Output directory |
| `--skip-gemini` | | false | Skip AI classification |
| `--keep-temp` | | false | Keep temp extracted frames |
| `--search-window` | `-w` | 0.2 | ±seconds for final extraction |
| `--gemini-model` | `-m` | gemini-1.5-flash | Gemini model |
| `--verbose` | `-v` | false | Verbose output |
| `--help` | `-h` | | Show help |

## Output Structure

```
output/
└── video_name/
    ├── temp_frames/        # (deleted unless --keep-temp)
    ├── candidates/         # Selected candidate frames
    │   ├── frame_00012_t2.40.png
    │   └── ...
    ├── final_frames/       # AI-recommended frames
    │   ├── hero_frame_00012_t2.40.png
    │   ├── side_frame_00045_t9.00.png
    │   └── ...
    ├── quality_report.json # Video quality analysis
    └── gemini_result.json  # Full AI classification
```

## How It Works

### 1. Dense Frame Extraction

Extracts frames at a fixed FPS (default 5) using ffmpeg. This is intentionally
denser than uniform sampling to catch brief "pause moments" in fast-moving video.

**Why not uniform sampling?**
- Uniform sampling (e.g., 10 frames total) misses the 0.5s pause in a 30s video
- Dense extraction at 5 fps means 150 frames to analyze
- We then use cheap CPU scoring to find the good ones

### 2. Frame Scoring

Each frame is scored using:

```
score = sharpness - (alpha × motion × 255)
```

**Sharpness** (Laplacian variance):
- High variance = sharp edges = in-focus
- Low variance = smooth gradients = blurry

**Motion** (pixel difference with previous frame):
- Low motion = product was still = good candidate
- High motion = product was moving = likely blurry

### 3. Candidate Selection

Top K frames are selected with temporal diversity:
- Sort by score (descending)
- Skip frames within 0.5s of already-selected frames
- This ensures coverage across the video

### 4. AI Classification

Gemini receives ONLY the candidates (not the full video) with:
- Frame images (base64 PNG)
- Metadata (timestamp, sequence position)
- Instructions to classify as hero/side/detail/context

Gemini returns structured JSON with:
- Quality scores (0-100)
- Labels per frame
- Reasoning for each recommendation

### 5. Final Extraction

For each recommended frame:
- Re-extract at highest quality from original video
- Optionally search ±0.2s window for even sharper frame
- Save with descriptive filename

## Handling Unusable Videos

If no frame meets the minimum sharpness threshold:

1. Pipeline marks video as **unusable**
2. Generates a **quality report** with:
   - Average/max sharpness scores
   - Detected issues (blur, motion, etc.)
3. Provides **reshoot guidance**:
   - "Pause for 1-2 seconds at each angle"
   - "Ensure adequate lighting"
   - "Use tripod or stabilize camera"

## Gemini Output Schema

```json
{
  "video": {
    "filename": "product.mp4",
    "duration_sec": 15.5
  },
  "frame_evaluation": [
    {
      "frame_id": "frame_00012",
      "timestamp_sec": 2.4,
      "quality_score_0_100": 85,
      "labels": ["hero"],
      "reason": "Clear front view, sharp focus, clean background"
    }
  ],
  "recommended_shots": [
    {
      "type": "hero",
      "frame_id": "frame_00012",
      "timestamp_sec": 2.4,
      "reason": "Best overall composition with product centered"
    }
  ],
  "overall_quality": {
    "rating": "excellent",
    "issues": []
  }
}
```

## Configuration Tuning

### For Very Fast Motion

```bash
# Higher FPS to catch brief pauses
# Higher motion penalty
node index.js video.mp4 --fps 10 --alpha 0.8
```

### For Low-Light Video

```bash
# Lower sharpness expectations
# More candidates to compensate
node index.js video.mp4 --top-k 20
```

### For Long Videos

```bash
# Lower FPS to reduce frame count
# Wider temporal gap for diversity
node index.js video.mp4 --fps 3 --min-gap 1.0
```

## Programmatic Usage

```javascript
import { getVideoMetadata, extractFramesDense } from './video.js';
import { runSmartFramePipeline } from './smartFrames.js';
import { initGemini, classifyFramesWithGemini } from './gemini.js';

// Extract and score
const metadata = await getVideoMetadata('./video.mp4');
const frames = await extractFramesDense('./video.mp4', './temp');
const result = await runSmartFramePipeline('./video.mp4', metadata, frames);

// Classify with Gemini
const genAI = initGemini(process.env.GOOGLE_AI_API_KEY);
const geminiResult = await classifyFramesWithGemini(
  genAI,
  result.candidates,
  result.candidateMetadata,
  metadata
);
```

## Troubleshooting

### "ffmpeg not found"

Install ffmpeg:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
choco install ffmpeg
```

### "GOOGLE_AI_API_KEY not set"

```bash
export GOOGLE_AI_API_KEY=your_key_here
# Or use --skip-gemini for scoring-only mode
```

### All Frames Marked as Blurry

The video quality is likely too low. Check the quality report for guidance:
```bash
cat output/video_name/quality_report.json
```

### Gemini Returns Invalid JSON

Retry usually fixes this. The pipeline has built-in retry logic (3 attempts).

## Design Decisions

### Why Laplacian Variance for Sharpness?

It's the gold standard for blur detection:
- Fast to compute (single convolution)
- Works on any image content
- Correlates well with perceived sharpness

### Why Not Use Gemini for All Frames?

Cost and latency. A 30s video at 5 fps = 150 frames. Sending all to Gemini would:
- Cost ~$0.15 per video
- Take 30+ seconds

Pre-filtering to 12 candidates:
- Costs ~$0.01 per video
- Takes ~5 seconds

### Why the Search Window for Final Extraction?

The "best" frame might be ±0.2s from our candidate. Motion blur can change
rapidly, so this gives us a second chance at the optimal moment.

# Flutter Mobile App Build Prompt for Claude Code

Use this prompt to initialize a new Flutter project that integrates with the VOPI backend.

---

## Prompt

```
Build a Flutter mobile app that integrates with the VOPI (Video Object Processing Infrastructure) backend API. The app allows users to upload product videos and receive AI-generated commercial product images.

## Project Setup

Create a new Flutter project with the following:
- Name: vopi_mobile
- Min SDK: Flutter 3.16+, Dart 3.2+
- Platforms: iOS and Android
- State management: Riverpod
- Architecture: Feature-first folder structure

## Dependencies (pubspec.yaml)

dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^2.4.9
  dio: ^5.4.0
  image_picker: ^1.0.7
  cached_network_image: ^3.3.1
  freezed_annotation: ^2.4.1
  json_annotation: ^4.8.1
  go_router: ^13.0.0
  flutter_secure_storage: ^9.0.0
  share_plus: ^7.2.1
  path_provider: ^2.1.2
  permission_handler: ^11.1.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  build_runner: ^2.4.8
  freezed: ^2.4.6
  json_serializable: ^6.7.1
  flutter_lints: ^3.0.1

## API Configuration

Base URL: Configure via environment/flavor (dev, staging, prod)
Authentication: API key via x-api-key header
Store API key securely using flutter_secure_storage

## Core Features

### 1. Onboarding / API Key Setup
- First launch screen to enter API key
- Validate key with a test API call (GET /health)
- Store key securely
- Allow changing key in settings

### 2. Home Screen
- "Upload Video" primary action button
- Recent jobs list (last 10)
- Pull-to-refresh
- Empty state with instructions

### 3. Video Upload Flow
Screen: VideoUploadScreen
- Video picker (gallery only, no camera needed)
- Video preview with thumbnail
- Optional: Configure FPS (slider 1-30, default 10)
- Optional: Select commercial versions (checkboxes)
- "Start Processing" button
- Navigate to ProcessingScreen on submit

### 4. Processing Screen
Screen: ProcessingScreen
- Show current step (downloading, extracting, scoring, classifying, generating)
- Progress bar with percentage
- Step indicator (1/6, 2/6, etc.)
- Cancel button (with confirmation dialog)
- Auto-navigate to ResultsScreen on completion
- Show error state with retry option

### 5. Results Screen
Screen: ResultsScreen
- Grid display of generated images grouped by variant
- Each variant section shows 4 versions (transparent, solid, real, creative)
- Tap image for full-screen view with pinch-to-zoom
- Share button for each image
- Download button to save to gallery
- "Process Another Video" button

### 6. Job History Screen
Screen: JobHistoryScreen
- List all jobs with status badges
- Filter by status (tabs or dropdown)
- Tap to view results (if completed) or status (if processing)
- Pull-to-refresh

### 7. Settings Screen
Screen: SettingsScreen
- Change API key
- Clear cache
- About section with version info

## API Integration

### Endpoints to implement:

1. POST /api/v1/uploads/presign
   - Get presigned S3 URL for video upload

2. PUT {presignedUrl}
   - Upload video directly to S3 with progress tracking

3. POST /api/v1/jobs
   - Create processing job

4. GET /api/v1/jobs/:id/status
   - Poll job status (every 3 seconds)

5. GET /api/v1/jobs/:id
   - Get full job details

6. GET /api/v1/jobs/:id/images/grouped
   - Get commercial images grouped by variant

7. DELETE /api/v1/jobs/:id
   - Cancel pending job

8. GET /api/v1/jobs
   - List jobs with pagination

## Data Models (use Freezed)

- PresignResponse (uploadUrl, key, publicUrl, expiresIn)
- JobConfig (fps, batchSize, commercialVersions, aiCleanup)
- Job (id, status, videoUrl, config, progress, result, error, timestamps)
- JobStatus (id, status, progress, timestamps)
- JobProgress (step, percentage, message, totalSteps, currentStep)
- JobResult (variantsDiscovered, framesAnalyzed, finalFrames, commercialImages)
- Frame (id, frameId, timestamp, s3Url, variantId, angleEstimate)

## State Management (Riverpod)

Providers to create:
- apiKeyProvider: Manages secure API key storage
- vopiClientProvider: Dio client with auth interceptor
- uploadStateProvider: StateNotifier for upload flow
- jobsProvider: FutureProvider for job list
- jobDetailProvider: FutureProvider.family for single job

## Folder Structure

lib/
├── main.dart
├── app.dart
├── config/
│   └── api_config.dart
├── core/
│   ├── router/
│   │   └── app_router.dart
│   ├── theme/
│   │   └── app_theme.dart
│   └── utils/
│       └── extensions.dart
├── features/
│   ├── onboarding/
│   │   ├── screens/
│   │   └── providers/
│   ├── home/
│   │   ├── screens/
│   │   ├── widgets/
│   │   └── providers/
│   ├── upload/
│   │   ├── screens/
│   │   ├── widgets/
│   │   └── providers/
│   ├── processing/
│   │   ├── screens/
│   │   └── providers/
│   ├── results/
│   │   ├── screens/
│   │   └── widgets/
│   ├── history/
│   │   ├── screens/
│   │   └── providers/
│   └── settings/
│       └── screens/
├── models/
│   └── (freezed models)
├── services/
│   ├── vopi_client.dart
│   └── storage_service.dart
└── shared/
    └── widgets/
        ├── loading_indicator.dart
        ├── error_view.dart
        └── image_card.dart

## UI/UX Requirements

- Material 3 design
- Light and dark theme support
- Loading states for all async operations
- Error handling with user-friendly messages
- Haptic feedback on key actions
- Smooth transitions between screens

## Platform Configuration

iOS (Info.plist):
- NSPhotoLibraryUsageDescription
- NSPhotoLibraryAddUsageDescription

Android (AndroidManifest.xml):
- READ_EXTERNAL_STORAGE
- READ_MEDIA_VIDEO
- WRITE_EXTERNAL_STORAGE (for saving images)
- INTERNET

## Error Handling

- Network errors: Show retry option
- API errors: Parse error message from response
- Upload failures: Allow resume/retry
- Timeout: 5 min for uploads, 30s for other requests

## Testing Priority

1. API client unit tests
2. Provider unit tests
3. Widget tests for key screens
4. Integration test for full upload flow

## Implementation Order

1. Project setup and dependencies
2. API client and models
3. Onboarding flow (API key setup)
4. Home screen with empty state
5. Video upload flow
6. Processing screen with polling
7. Results screen with image grid
8. Job history screen
9. Settings screen
10. Polish (themes, animations, error states)

Start by setting up the project structure and implementing the API client with models. Then build screens in the order listed above.
```

---

## Usage

1. Create a new directory for your Flutter project
2. Open Claude Code in that directory
3. Paste the prompt above
4. Claude Code will scaffold the project and implement features incrementally

## Backend API Reference

The VOPI API documentation is available at:
- [API Reference](../api.md)
- [Architecture Overview](../architecture.md)

## Key Integration Points

### Upload Flow
```
1. POST /api/v1/uploads/presign → Get uploadUrl, publicUrl
2. PUT uploadUrl (S3 direct) → Upload video with progress
3. POST /api/v1/jobs { videoUrl: publicUrl } → Create job, get jobId
4. GET /api/v1/jobs/:id/status (poll) → Monitor progress
5. GET /api/v1/jobs/:id/images/grouped → Fetch results
```

### Authentication
All `/api/v1/*` endpoints require:
```
Header: x-api-key: <your-api-key>
```

### Job Status Values
```
pending → downloading → extracting → scoring → classifying → generating → completed
                                                                        ↘ failed
```

### Commercial Image Versions
- `transparent`: PNG with transparent background
- `solid`: AI-recommended solid color
- `real`: Realistic lifestyle setting
- `creative`: Artistic/promotional style

# Flutter/Dart Integration Guide

Complete guide for integrating VOPI into Flutter applications using Dart.

> **Important: Private S3 Bucket**
>
> The VOPI S3 bucket is private. Direct URLs in job results are not publicly accessible. You must use the `/jobs/:id/download-urls` endpoint to get presigned URLs with temporary access tokens. These URLs expire after a configurable time (default: 1 hour).

## Table of Contents

- [Setup](#setup)
- [Dependencies](#dependencies)
- [API Client](#api-client)
- [Models](#models)
- [State Management](#state-management)
- [Widgets](#widgets)
- [Complete Example](#complete-example)

## Setup

### Requirements

- Flutter 3.16+
- Dart 3.2+

### Dependencies

Add to `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter
  dio: ^5.4.0
  image_picker: ^1.0.7
  flutter_riverpod: ^2.4.9
  cached_network_image: ^3.3.1
  freezed_annotation: ^2.4.1
  json_annotation: ^4.8.1

dev_dependencies:
  flutter_test:
    sdk: flutter
  build_runner: ^2.4.8
  freezed: ^2.4.6
  json_serializable: ^6.7.1
```

Run code generation:
```bash
flutter pub get
dart run build_runner build --delete-conflicting-outputs
```

### Platform Configuration

**iOS** - Add to `ios/Runner/Info.plist`:
```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>We need access to your photo library to select videos</string>
```

**Android** - Add to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
```

## API Client

### Configuration

```dart
// lib/config/vopi_config.dart
class VOPIConfig {
  static const String baseUrl = 'https://api.your-domain.com';
  static const String apiKey = 'your-api-key';

  static const Duration uploadTimeout = Duration(minutes: 5);
  static const Duration requestTimeout = Duration(seconds: 30);
  static const Duration pollingInterval = Duration(seconds: 3);
}
```

### Dio Client Setup

```dart
// lib/services/vopi_client.dart
import 'dart:io';
import 'package:dio/dio.dart';
import '../config/vopi_config.dart';
import '../models/vopi_models.dart';

class VOPIClient {
  static final VOPIClient _instance = VOPIClient._internal();
  factory VOPIClient() => _instance;

  late final Dio _dio;
  late final Dio _s3Dio;

  VOPIClient._internal() {
    _dio = Dio(BaseOptions(
      baseUrl: VOPIConfig.baseUrl,
      connectTimeout: VOPIConfig.requestTimeout,
      receiveTimeout: VOPIConfig.requestTimeout,
      sendTimeout: VOPIConfig.uploadTimeout,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': VOPIConfig.apiKey,
      },
    ));

    _dio.interceptors.add(LogInterceptor(
      requestBody: true,
      responseBody: true,
    ));

    // Separate client for S3 uploads (no auth headers)
    _s3Dio = Dio(BaseOptions(
      connectTimeout: VOPIConfig.uploadTimeout,
      sendTimeout: VOPIConfig.uploadTimeout,
    ));
  }

  // Presign URL
  Future<PresignResponse> getPresignedUrl({
    String? filename,
    String contentType = 'video/mp4',
    int expiresIn = 3600,
  }) async {
    final response = await _dio.post(
      '/api/v1/uploads/presign',
      data: {
        if (filename != null) 'filename': filename,
        'contentType': contentType,
        'expiresIn': expiresIn,
      },
    );
    return PresignResponse.fromJson(response.data);
  }

  // Upload to S3
  Future<void> uploadToS3({
    required String uploadUrl,
    required File file,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  }) async {
    final fileLength = await file.length();

    await _s3Dio.put(
      uploadUrl,
      data: file.openRead(),
      options: Options(
        headers: {
          'Content-Type': contentType,
          'Content-Length': fileLength,
        },
      ),
      onSendProgress: onProgress,
    );
  }

  // Jobs
  Future<Job> createJob({
    required String videoUrl,
    JobConfig? config,
    String? callbackUrl,
  }) async {
    final response = await _dio.post(
      '/api/v1/jobs',
      data: {
        'videoUrl': videoUrl,
        if (config != null) 'config': config.toJson(),
        if (callbackUrl != null) 'callbackUrl': callbackUrl,
      },
    );
    return Job.fromJson(response.data);
  }

  Future<Job> getJob(String jobId) async {
    final response = await _dio.get('/api/v1/jobs/$jobId');
    return Job.fromJson(response.data);
  }

  Future<JobStatus> getJobStatus(String jobId) async {
    final response = await _dio.get('/api/v1/jobs/$jobId/status');
    return JobStatus.fromJson(response.data);
  }

  Future<CancelJobResponse> cancelJob(String jobId) async {
    final response = await _dio.delete('/api/v1/jobs/$jobId');
    return CancelJobResponse.fromJson(response.data);
  }

  Future<JobListResponse> listJobs({
    String? status,
    int limit = 20,
    int offset = 0,
  }) async {
    final response = await _dio.get(
      '/api/v1/jobs',
      queryParameters: {
        if (status != null) 'status': status,
        'limit': limit,
        'offset': offset,
      },
    );
    return JobListResponse.fromJson(response.data);
  }

  // Results
  Future<Map<String, Map<String, String>>> getGroupedImages(
    String jobId,
  ) async {
    final response = await _dio.get('/api/v1/jobs/$jobId/images/grouped');
    return (response.data as Map<String, dynamic>).map(
      (key, value) => MapEntry(
        key,
        (value as Map<String, dynamic>).map(
          (k, v) => MapEntry(k, v as String),
        ),
      ),
    );
  }

  Future<List<Frame>> getFinalFrames(String jobId) async {
    final response = await _dio.get('/api/v1/jobs/$jobId/frames/final');
    return (response.data as List)
        .map((e) => Frame.fromJson(e))
        .toList();
  }

  /// Get presigned download URLs (required for private S3 bucket)
  Future<DownloadUrlsResponse> getDownloadUrls(
    String jobId, {
    int expiresIn = 3600,
  }) async {
    final response = await _dio.get(
      '/api/v1/jobs/$jobId/download-urls',
      queryParameters: {'expiresIn': expiresIn},
    );
    return DownloadUrlsResponse.fromJson(response.data);
  }
}
```

## Models

### Data Models with Freezed

```dart
// lib/models/vopi_models.dart
import 'package:freezed_annotation/freezed_annotation.dart';

part 'vopi_models.freezed.dart';
part 'vopi_models.g.dart';

// Presign
@freezed
class PresignResponse with _$PresignResponse {
  const factory PresignResponse({
    required String uploadUrl,
    required String key,
    required String publicUrl,
    required int expiresIn,
  }) = _PresignResponse;

  factory PresignResponse.fromJson(Map<String, dynamic> json) =>
      _$PresignResponseFromJson(json);
}

// Job Config
@freezed
class JobConfig with _$JobConfig {
  const factory JobConfig({
    @Default(10) int fps,
    @Default(30) int batchSize,
    @Default([
      CommercialVersion.transparent,
      CommercialVersion.solid,
      CommercialVersion.real,
      CommercialVersion.creative,
    ])
    List<CommercialVersion> commercialVersions,
    @Default(true) bool aiCleanup,
    @Default('gemini-2.0-flash') String geminiModel,
  }) = _JobConfig;

  factory JobConfig.fromJson(Map<String, dynamic> json) =>
      _$JobConfigFromJson(json);
}

enum CommercialVersion {
  transparent,
  solid,
  real,
  creative,
}

// Job Status Type
enum JobStatusType {
  pending,
  downloading,
  extracting,
  scoring,
  classifying,
  @JsonValue('extracting_product')
  extractingProduct,
  generating,
  completed,
  failed,
  cancelled,
}

// Job Progress
@freezed
class JobProgress with _$JobProgress {
  const factory JobProgress({
    required String step,
    required int percentage,
    String? message,
    int? totalSteps,
    int? currentStep,
  }) = _JobProgress;

  factory JobProgress.fromJson(Map<String, dynamic> json) =>
      _$JobProgressFromJson(json);
}

// Job Result
@freezed
class JobResult with _$JobResult {
  const factory JobResult({
    int? variantsDiscovered,
    int? framesAnalyzed,
    List<String>? finalFrames,
    Map<String, Map<String, String>>? commercialImages,
  }) = _JobResult;

  factory JobResult.fromJson(Map<String, dynamic> json) =>
      _$JobResultFromJson(json);
}

// Job
@freezed
class Job with _$Job {
  const factory Job({
    required String id,
    required JobStatusType status,
    required String videoUrl,
    JobConfig? config,
    JobProgress? progress,
    JobResult? result,
    String? error,
    required String createdAt,
    String? updatedAt,
    String? startedAt,
    String? completedAt,
  }) = _Job;

  factory Job.fromJson(Map<String, dynamic> json) => _$JobFromJson(json);
}

// Job Status
@freezed
class JobStatus with _$JobStatus {
  const factory JobStatus({
    required String id,
    required JobStatusType status,
    JobProgress? progress,
    required String createdAt,
    String? updatedAt,
  }) = _JobStatus;

  factory JobStatus.fromJson(Map<String, dynamic> json) =>
      _$JobStatusFromJson(json);
}

// Cancel Job Response
@freezed
class CancelJobResponse with _$CancelJobResponse {
  const factory CancelJobResponse({
    required String id,
    required JobStatusType status,
    required String message,
  }) = _CancelJobResponse;

  factory CancelJobResponse.fromJson(Map<String, dynamic> json) =>
      _$CancelJobResponseFromJson(json);
}

// Job List Response
@freezed
class JobListResponse with _$JobListResponse {
  const factory JobListResponse({
    required List<Job> jobs,
    required int total,
  }) = _JobListResponse;

  factory JobListResponse.fromJson(Map<String, dynamic> json) =>
      _$JobListResponseFromJson(json);
}

// Download URLs Response (for private S3 bucket)
@freezed
class DownloadUrlsResponse with _$DownloadUrlsResponse {
  const factory DownloadUrlsResponse({
    required String jobId,
    required int expiresIn,
    required List<FrameDownload> frames,
    required Map<String, Map<String, String>> commercialImages,
  }) = _DownloadUrlsResponse;

  factory DownloadUrlsResponse.fromJson(Map<String, dynamic> json) =>
      _$DownloadUrlsResponseFromJson(json);
}

@freezed
class FrameDownload with _$FrameDownload {
  const factory FrameDownload({
    required String frameId,
    required String downloadUrl,
  }) = _FrameDownload;

  factory FrameDownload.fromJson(Map<String, dynamic> json) =>
      _$FrameDownloadFromJson(json);
}

// Frame
@freezed
class Frame with _$Frame {
  const factory Frame({
    required String id,
    required String jobId,
    required String frameId,
    required double timestamp,
    required String s3Url,
    String? productId,
    String? variantId,
    String? angleEstimate,
    String? variantDescription,
    FrameObstructions? obstructions,
    BackgroundRecommendations? backgroundRecommendations,
    required String createdAt,
  }) = _Frame;

  factory Frame.fromJson(Map<String, dynamic> json) => _$FrameFromJson(json);
}

@freezed
class FrameObstructions with _$FrameObstructions {
  const factory FrameObstructions({
    @JsonKey(name: 'has_obstruction') required bool hasObstruction,
    @JsonKey(name: 'obstruction_types') List<String>? obstructionTypes,
    @JsonKey(name: 'obstruction_description') String? obstructionDescription,
    @JsonKey(name: 'removable_by_ai') bool? removableByAi,
  }) = _FrameObstructions;

  factory FrameObstructions.fromJson(Map<String, dynamic> json) =>
      _$FrameObstructionsFromJson(json);
}

@freezed
class BackgroundRecommendations with _$BackgroundRecommendations {
  const factory BackgroundRecommendations({
    @JsonKey(name: 'solid_color') String? solidColor,
    @JsonKey(name: 'solid_color_name') String? solidColorName,
    @JsonKey(name: 'real_life_setting') String? realLifeSetting,
    @JsonKey(name: 'creative_shot') String? creativeShot,
  }) = _BackgroundRecommendations;

  factory BackgroundRecommendations.fromJson(Map<String, dynamic> json) =>
      _$BackgroundRecommendationsFromJson(json);
}
```

## State Management

### Upload State

```dart
// lib/models/upload_state.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import 'vopi_models.dart';

part 'upload_state.freezed.dart';

@freezed
class UploadState with _$UploadState {
  const factory UploadState.idle() = _Idle;
  const factory UploadState.uploading(double progress) = _Uploading;
  const factory UploadState.processing(int progress, String step) = _Processing;
  const factory UploadState.completed(
    Job job,
    Map<String, Map<String, String>> images,
  ) = _Completed;
  const factory UploadState.error(String message) = _Error;
  const factory UploadState.cancelled() = _Cancelled;
}
```

### Riverpod Provider

```dart
// lib/providers/vopi_provider.dart
import 'dart:async';
import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/vopi_config.dart';
import '../models/upload_state.dart';
import '../models/vopi_models.dart';
import '../services/vopi_client.dart';

final vopiClientProvider = Provider((ref) => VOPIClient());

final uploadStateProvider =
    StateNotifierProvider<UploadStateNotifier, UploadState>((ref) {
  return UploadStateNotifier(ref.watch(vopiClientProvider));
});

class UploadStateNotifier extends StateNotifier<UploadState> {
  final VOPIClient _client;
  Timer? _pollingTimer;
  String? _currentJobId;
  bool _isCancelled = false;

  UploadStateNotifier(this._client) : super(const UploadState.idle());

  Future<void> uploadAndProcess(File videoFile, {JobConfig? config}) async {
    _isCancelled = false;
    _cleanup();

    try {
      state = const UploadState.uploading(0);

      // Step 1: Get presigned URL
      final filename = videoFile.path.split('/').last;
      final presign = await _client.getPresignedUrl(
        filename: filename,
        contentType: 'video/mp4',
      );

      if (_isCancelled) return;

      // Step 2: Upload to S3
      await _client.uploadToS3(
        uploadUrl: presign.uploadUrl,
        file: videoFile,
        contentType: 'video/mp4',
        onProgress: (sent, total) {
          if (!_isCancelled) {
            state = UploadState.uploading(sent / total);
          }
        },
      );

      if (_isCancelled) return;

      // Step 3: Create job
      state = const UploadState.processing(0, 'Starting...');

      final job = await _client.createJob(
        videoUrl: presign.publicUrl,
        config: config,
      );

      _currentJobId = job.id;

      if (_isCancelled) {
        await _client.cancelJob(job.id);
        return;
      }

      // Step 4: Start polling
      _startPolling(job.id);

    } catch (e) {
      _cleanup();
      state = UploadState.error(e.toString());
    }
  }

  void _startPolling(String jobId) {
    _pollingTimer = Timer.periodic(
      VOPIConfig.pollingInterval,
      (_) => _pollStatus(jobId),
    );
    // Poll immediately
    _pollStatus(jobId);
  }

  Future<void> _pollStatus(String jobId) async {
    if (_isCancelled) {
      _cleanup();
      return;
    }

    try {
      final status = await _client.getJobStatus(jobId);

      state = UploadState.processing(
        status.progress?.percentage ?? 0,
        status.progress?.message ?? _capitalizeFirst(status.status.name),
      );

      switch (status.status) {
        case JobStatusType.completed:
          _cleanup();
          await _fetchResults(jobId);
          break;
        case JobStatusType.failed:
        case JobStatusType.cancelled:
          _cleanup();
          state = UploadState.error('Job ${status.status.name}');
          break;
        default:
          break;
      }
    } catch (e) {
      // Continue polling on transient errors
      print('Polling error: $e');
    }
  }

  Future<void> _fetchResults(String jobId) async {
    try {
      final results = await Future.wait([
        _client.getJob(jobId),
        // Use presigned download URLs (required for private S3 bucket)
        _client.getDownloadUrls(jobId),
      ]);

      final downloadUrls = results[1] as DownloadUrlsResponse;
      state = UploadState.completed(
        results[0] as Job,
        downloadUrls.commercialImages,
      );
    } catch (e) {
      state = UploadState.error('Failed to fetch results');
    }
  }

  Future<void> cancel() async {
    _isCancelled = true;
    _cleanup();

    if (_currentJobId != null) {
      try {
        await _client.cancelJob(_currentJobId!);
      } catch (_) {}
    }

    state = const UploadState.cancelled();
  }

  void reset() {
    _cleanup();
    _isCancelled = false;
    _currentJobId = null;
    state = const UploadState.idle();
  }

  void _cleanup() {
    _pollingTimer?.cancel();
    _pollingTimer = null;
  }

  String _capitalizeFirst(String text) {
    if (text.isEmpty) return text;
    return text[0].toUpperCase() + text.substring(1);
  }

  @override
  void dispose() {
    _cleanup();
    super.dispose();
  }
}

// Jobs list provider
final jobsProvider = FutureProvider.autoDispose
    .family<JobListResponse, JobListParams>((ref, params) async {
  final client = ref.watch(vopiClientProvider);
  return client.listJobs(
    status: params.status,
    limit: params.limit,
    offset: params.offset,
  );
});

class JobListParams {
  final String? status;
  final int limit;
  final int offset;

  const JobListParams({
    this.status,
    this.limit = 20,
    this.offset = 0,
  });
}
```

## Widgets

### Video Picker Widget

```dart
// lib/widgets/video_picker.dart
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

class VideoPicker extends StatelessWidget {
  final void Function(File video) onSelect;
  final bool enabled;

  const VideoPicker({
    super.key,
    required this.onSelect,
    this.enabled = true,
  });

  Future<void> _pickVideo(BuildContext context) async {
    try {
      final picker = ImagePicker();
      final video = await picker.pickVideo(source: ImageSource.gallery);

      if (video != null) {
        onSelect(File(video.path));
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to pick video: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: enabled ? () => _pickVideo(context) : null,
      style: ElevatedButton.styleFrom(
        padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 32),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
        ),
      ),
      child: const Text(
        'Select Video',
        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    );
  }
}
```

### Upload Progress Widget

```dart
// lib/widgets/upload_progress.dart
import 'package:flutter/material.dart';
import '../models/upload_state.dart';

class UploadProgressWidget extends StatelessWidget {
  final UploadState state;
  final VoidCallback onCancel;

  const UploadProgressWidget({
    super.key,
    required this.state,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    return state.when(
      idle: () => const SizedBox.shrink(),
      uploading: (progress) => _buildProgress(
        context,
        'Uploading: ${(progress * 100).toInt()}%',
        progress,
      ),
      processing: (progress, step) => _buildProgress(
        context,
        '$step: $progress%',
        progress / 100,
      ),
      completed: (_, __) => const SizedBox.shrink(),
      error: (message) => _buildError(context, message),
      cancelled: () => _buildMessage(context, 'Cancelled'),
    );
  }

  Widget _buildProgress(BuildContext context, String label, double progress) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.grey[100],
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: const TextStyle(fontSize: 14, color: Colors.black87),
          ),
          const SizedBox(height: 12),
          LinearProgressIndicator(
            value: progress,
            backgroundColor: Colors.grey[300],
          ),
          const SizedBox(height: 16),
          TextButton(
            onPressed: onCancel,
            child: const Text(
              'Cancel',
              style: TextStyle(color: Colors.red),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildError(BuildContext context, String message) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.red[50],
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        'Error: $message',
        style: TextStyle(color: Colors.red[700]),
      ),
    );
  }

  Widget _buildMessage(BuildContext context, String message) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.grey[100],
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(message),
    );
  }
}
```

### Results Gallery Widget

```dart
// lib/widgets/results_gallery.dart
import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';

class ResultsGallery extends StatelessWidget {
  final Map<String, Map<String, String>> images;
  final void Function(String url)? onImageTap;

  const ResultsGallery({
    super.key,
    required this.images,
    this.onImageTap,
  });

  @override
  Widget build(BuildContext context) {
    if (images.isEmpty) {
      return const Center(
        child: Text('No results available'),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: images.length,
      itemBuilder: (context, index) {
        final variant = images.keys.elementAt(index);
        final versions = images[variant]!;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                _capitalize(variant),
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            GridView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                crossAxisSpacing: 8,
                mainAxisSpacing: 8,
                childAspectRatio: 1,
              ),
              itemCount: versions.length,
              itemBuilder: (context, versionIndex) {
                final version = versions.keys.elementAt(versionIndex);
                final url = versions[version]!;

                return GestureDetector(
                  onTap: () => onImageTap?.call(url),
                  child: Column(
                    children: [
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: CachedNetworkImage(
                            imageUrl: url,
                            fit: BoxFit.cover,
                            placeholder: (_, __) => Container(
                              color: Colors.grey[200],
                              child: const Center(
                                child: CircularProgressIndicator(),
                              ),
                            ),
                            errorWidget: (_, __, ___) => Container(
                              color: Colors.grey[200],
                              child: const Icon(Icons.error),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _capitalize(version),
                        style: const TextStyle(
                          fontSize: 12,
                          color: Colors.grey,
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
            const SizedBox(height: 24),
          ],
        );
      },
    );
  }

  String _capitalize(String text) {
    if (text.isEmpty) return text;
    return text[0].toUpperCase() + text.substring(1);
  }
}
```

## Complete Example

### Main App

```dart
// lib/main.dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'screens/home_screen.dart';

void main() {
  runApp(const ProviderScope(child: VOPIApp()));
}

class VOPIApp extends StatelessWidget {
  const VOPIApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VOPI',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
```

### Home Screen

```dart
// lib/screens/home_screen.dart
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/upload_state.dart';
import '../providers/vopi_provider.dart';
import '../widgets/video_picker.dart';
import '../widgets/upload_progress.dart';
import '../widgets/results_gallery.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(uploadStateProvider);
    final notifier = ref.read(uploadStateProvider.notifier);

    final isProcessing = state.maybeWhen(
      uploading: (_) => true,
      processing: (_, __) => true,
      orElse: () => false,
    );

    return Scaffold(
      appBar: AppBar(
        title: const Text('VOPI'),
        centerTitle: true,
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              const Spacer(),

              // Video Picker
              VideoPicker(
                enabled: !isProcessing,
                onSelect: (video) => _handleVideoSelect(video, notifier),
              ),

              const SizedBox(height: 24),

              // Progress Indicator
              UploadProgressWidget(
                state: state,
                onCancel: notifier.cancel,
              ),

              // Completed Actions
              state.maybeWhen(
                completed: (job, images) => Column(
                  children: [
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed: () => _showResults(context, images),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.green,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(
                          vertical: 16,
                          horizontal: 32,
                        ),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: const Text('View Results'),
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton(
                      onPressed: notifier.reset,
                      child: const Text('Process Another Video'),
                    ),
                  ],
                ),
                error: (_) => Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: OutlinedButton(
                    onPressed: notifier.reset,
                    child: const Text('Try Again'),
                  ),
                ),
                cancelled: () => Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: OutlinedButton(
                    onPressed: notifier.reset,
                    child: const Text('Start Over'),
                  ),
                ),
                orElse: () => const SizedBox.shrink(),
              ),

              const Spacer(),
            ],
          ),
        ),
      ),
    );
  }

  void _handleVideoSelect(File video, UploadStateNotifier notifier) {
    notifier.uploadAndProcess(video);
  }

  void _showResults(
    BuildContext context,
    Map<String, Map<String, String>> images,
  ) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.9,
        minChildSize: 0.5,
        maxChildSize: 0.95,
        expand: false,
        builder: (context, scrollController) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    'Results',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Done'),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: ResultsGallery(images: images),
            ),
          ],
        ),
      ),
    );
  }
}
```

### Full Image Viewer

```dart
// lib/screens/image_viewer_screen.dart
import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';

class ImageViewerScreen extends StatelessWidget {
  final String imageUrl;
  final String? title;

  const ImageViewerScreen({
    super.key,
    required this.imageUrl,
    this.title,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: title != null ? Text(title!) : null,
        iconTheme: const IconThemeData(color: Colors.white),
      ),
      body: Center(
        child: InteractiveViewer(
          child: CachedNetworkImage(
            imageUrl: imageUrl,
            fit: BoxFit.contain,
            placeholder: (_, __) => const CircularProgressIndicator(),
            errorWidget: (_, __, ___) => const Icon(
              Icons.error,
              color: Colors.white,
            ),
          ),
        ),
      ),
    );
  }
}
```

## Error Handling

### Custom Exception Classes

```dart
// lib/exceptions/vopi_exceptions.dart
class VOPIException implements Exception {
  final String message;
  final int? statusCode;

  const VOPIException(this.message, {this.statusCode});

  @override
  String toString() => 'VOPIException: $message';
}

class UploadException extends VOPIException {
  const UploadException(super.message);
}

class JobException extends VOPIException {
  const JobException(super.message, {super.statusCode});
}

class NetworkException extends VOPIException {
  const NetworkException(super.message);
}
```

### Error Handling Wrapper

```dart
// lib/utils/api_wrapper.dart
import 'package:dio/dio.dart';
import '../exceptions/vopi_exceptions.dart';

Future<T> apiCall<T>(Future<T> Function() call) async {
  try {
    return await call();
  } on DioException catch (e) {
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.sendTimeout ||
        e.type == DioExceptionType.receiveTimeout) {
      throw const NetworkException('Connection timeout');
    }

    final response = e.response;
    if (response != null) {
      final data = response.data;
      final message = data is Map ? data['error'] ?? e.message : e.message;
      throw VOPIException(message ?? 'Unknown error', statusCode: response.statusCode);
    }

    throw NetworkException(e.message ?? 'Network error');
  } catch (e) {
    if (e is VOPIException) rethrow;
    throw VOPIException(e.toString());
  }
}
```

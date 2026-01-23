# React Native Integration Guide

Complete guide for integrating VOPI into React Native applications using TypeScript.

> **Important: Private S3 Bucket**
>
> The VOPI S3 bucket is private. Direct URLs in job results are not publicly accessible. You must use the `/jobs/:id/download-urls` endpoint to get presigned URLs with temporary access tokens. These URLs expire after a configurable time (default: 1 hour).

## Table of Contents

- [Setup](#setup)
- [Dependencies](#dependencies)
- [API Client](#api-client)
- [Types](#types)
- [Hooks](#hooks)
- [Components](#components)
- [Complete Example](#complete-example)

## Setup

### Requirements

- React Native 0.72+
- TypeScript 5.0+
- Node.js 18+

### Dependencies

```bash
# Core dependencies
npm install axios react-native-blob-util

# Video picker (choose one)
npm install react-native-image-picker
# OR
npm install expo-image-picker  # for Expo projects

# State management (optional but recommended)
npm install zustand

# Image display
npm install react-native-fast-image
```

For iOS, add to `Info.plist`:
```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>We need access to your photo library to select videos</string>
```

For Android, add to `AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
```

## API Client

### Configuration

```typescript
// src/config/vopi.config.ts
export const VOPIConfig = {
  baseURL: 'https://api.your-domain.com',
  apiKey: 'your-api-key',
  uploadTimeout: 300000, // 5 minutes
  requestTimeout: 30000,
  pollingInterval: 3000,
} as const;
```

### API Client

```typescript
// src/services/vopi.client.ts
import axios, { AxiosInstance, AxiosError } from 'axios';
import { VOPIConfig } from '../config/vopi.config';
import {
  PresignRequest,
  PresignResponse,
  CreateJobRequest,
  Job,
  JobStatus,
  CancelJobResponse,
  Frame,
  ApiError,
  DownloadUrlsResponse,
} from '../types/vopi.types';

class VOPIClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: VOPIConfig.baseURL,
      timeout: VOPIConfig.requestTimeout,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': VOPIConfig.apiKey,
      },
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError<ApiError>) => {
        const message = error.response?.data?.error || error.message;
        throw new Error(message);
      }
    );
  }

  // Presign URL
  async getPresignedUrl(request: PresignRequest): Promise<PresignResponse> {
    const { data } = await this.client.post<PresignResponse>(
      '/api/v1/uploads/presign',
      request
    );
    return data;
  }

  // Jobs
  async createJob(request: CreateJobRequest): Promise<Job> {
    const { data } = await this.client.post<Job>('/api/v1/jobs', request);
    return data;
  }

  async getJob(jobId: string): Promise<Job> {
    const { data } = await this.client.get<Job>(`/api/v1/jobs/${jobId}`);
    return data;
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const { data } = await this.client.get<JobStatus>(
      `/api/v1/jobs/${jobId}/status`
    );
    return data;
  }

  async cancelJob(jobId: string): Promise<CancelJobResponse> {
    const { data } = await this.client.delete<CancelJobResponse>(
      `/api/v1/jobs/${jobId}`
    );
    return data;
  }

  async listJobs(params?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ jobs: Job[]; total: number }> {
    const { data } = await this.client.get('/api/v1/jobs', { params });
    return data;
  }

  // Results
  async getGroupedImages(
    jobId: string
  ): Promise<Record<string, Record<string, string>>> {
    const { data } = await this.client.get(
      `/api/v1/jobs/${jobId}/images/grouped`
    );
    return data;
  }

  async getFinalFrames(jobId: string): Promise<Frame[]> {
    const { data } = await this.client.get<Frame[]>(
      `/api/v1/jobs/${jobId}/frames/final`
    );
    return data;
  }

  // Get presigned download URLs (required for private S3 bucket)
  async getDownloadUrls(
    jobId: string,
    expiresIn = 3600
  ): Promise<DownloadUrlsResponse> {
    const { data } = await this.client.get<DownloadUrlsResponse>(
      `/api/v1/jobs/${jobId}/download-urls`,
      { params: { expiresIn } }
    );
    return data;
  }
}

export const vopiClient = new VOPIClient();
```

## Types

### TypeScript Definitions

```typescript
// src/types/vopi.types.ts

// API Error
export interface ApiError {
  error: string;
  statusCode: number;
  details?: Record<string, string>;
}

// Presign
export interface PresignRequest {
  filename?: string;
  contentType?: 'video/mp4' | 'video/quicktime' | 'video/webm';
  expiresIn?: number;
}

export interface PresignResponse {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  expiresIn: number;
}

// Job
export type CommercialVersion = 'transparent' | 'solid' | 'real' | 'creative';

export interface JobConfig {
  fps?: number;
  batchSize?: number;
  commercialVersions?: CommercialVersion[];
  aiCleanup?: boolean;
  geminiModel?: string;
}

export interface CreateJobRequest {
  videoUrl: string;
  config?: JobConfig;
  callbackUrl?: string;
}

export type JobStatusType =
  | 'pending'
  | 'downloading'
  | 'extracting'
  | 'scoring'
  | 'classifying'
  | 'extracting_product'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobProgress {
  step: string;
  percentage: number;
  message?: string;
  totalSteps?: number;
  currentStep?: number;
}

export interface JobResult {
  variantsDiscovered?: number;
  framesAnalyzed?: number;
  finalFrames?: string[];
  commercialImages?: Record<string, Record<string, string>>;
}

export interface Job {
  id: string;
  status: JobStatusType;
  videoUrl: string;
  config?: JobConfig;
  progress?: JobProgress;
  result?: JobResult;
  error?: string;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JobStatus {
  id: string;
  status: JobStatusType;
  progress?: JobProgress;
  createdAt: string;
  updatedAt?: string;
}

export interface CancelJobResponse {
  id: string;
  status: JobStatusType;
  message: string;
}

// Download URLs (for private S3 bucket)
export interface DownloadUrlsResponse {
  jobId: string;
  expiresIn: number;
  frames: Array<{
    frameId: string;
    downloadUrl: string;
  }>;
  commercialImages: Record<string, Record<string, string>>;
  /** Product metadata extracted from audio analysis (null if no audio or analysis failed) */
  productMetadata: ProductMetadataOutput | null;
}

// Product Metadata (from audio analysis)

/** Complete product metadata output including platform-specific formats */
export interface ProductMetadataOutput {
  /** Raw transcript from audio */
  transcript: string;
  /** Universal product metadata */
  product: ProductMetadata;
  /** Platform-specific formatted versions */
  platforms: PlatformFormats;
  /** ISO timestamp when metadata was extracted */
  extractedAt: string;
  /** Audio duration in seconds (if available) */
  audioDuration?: number;
  /** Pipeline version */
  pipelineVersion: string;
}

/** Universal product metadata */
export interface ProductMetadata {
  title: string;
  description: string;
  shortDescription?: string;
  bulletPoints: string[];
  brand?: string;
  category?: string;
  subcategory?: string;
  materials?: string[];
  color?: string;
  colors?: string[];
  size?: string;
  sizes?: string[];
  price?: number;
  currency?: string;
  keywords?: string[];
  tags?: string[];
  condition?: 'new' | 'refurbished' | 'used' | 'open_box';
  confidence: MetadataConfidence;
  extractedFromAudio: boolean;
  transcriptExcerpts?: string[];
}

/** Confidence scores for metadata fields */
export interface MetadataConfidence {
  overall: number;
  title: number;
  description: number;
  price?: number;
  attributes?: number;
}

/** Platform-specific formatted product data */
export interface PlatformFormats {
  shopify: ShopifyProduct;
  amazon: AmazonProduct;
  ebay: EbayProduct;
}

/** Shopify-formatted product data */
export interface ShopifyProduct {
  title: string;
  descriptionHtml: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  status?: string;
}

/** Amazon-formatted product data */
export interface AmazonProduct {
  item_name: string;
  brand_name?: string;
  product_description?: string;
  bullet_point?: string[];
  generic_keyword?: string[];
  color?: string;
  material?: string[];
}

/** eBay-formatted product data */
export interface EbayProduct {
  title: string;
  description: string;
  condition: string;
  conditionDescription?: string;
  brand?: string;
  aspects?: Record<string, string[]>;
}

// Frame
export interface FrameObstructions {
  has_obstruction: boolean;
  obstruction_types?: string[];
  obstruction_description?: string;
  removable_by_ai?: boolean;
}

export interface BackgroundRecommendations {
  solid_color?: string;
  solid_color_name?: string;
  real_life_setting?: string;
  creative_shot?: string;
}

export interface Frame {
  id: string;
  jobId: string;
  frameId: string;
  timestamp: number;
  s3Url: string;
  productId?: string;
  variantId?: string;
  angleEstimate?: string;
  variantDescription?: string;
  obstructions?: FrameObstructions;
  backgroundRecommendations?: BackgroundRecommendations;
  createdAt: string;
}

// Upload State
export type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: number }
  | { status: 'processing'; progress: number; step: string }
  | {
      status: 'completed';
      job: Job;
      images: Record<string, Record<string, string>>;
    }
  | { status: 'error'; message: string }
  | { status: 'cancelled' };
```

## Hooks

### useVOPIUpload Hook

```typescript
// src/hooks/useVOPIUpload.ts
import { useState, useCallback, useRef } from 'react';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { vopiClient } from '../services/vopi.client';
import { VOPIConfig } from '../config/vopi.config';
import {
  UploadState,
  JobConfig,
  Job,
  JobStatusType,
} from '../types/vopi.types';

interface VideoFile {
  uri: string;
  fileName?: string;
  type?: string;
}

export function useVOPIUpload() {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const currentJobIdRef = useRef<string | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);

  const cleanup = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const uploadAndProcess = useCallback(
    async (video: VideoFile, config?: JobConfig) => {
      isCancelledRef.current = false;
      cleanup();

      try {
        // Step 1: Get presigned URL
        setState({ status: 'uploading', progress: 0 });

        const filename = video.fileName || 'video.mp4';
        const presign = await vopiClient.getPresignedUrl({
          filename,
          contentType: 'video/mp4',
        });

        if (isCancelledRef.current) return;

        // Step 2: Upload to S3 with progress
        await ReactNativeBlobUtil.fetch(
          'PUT',
          presign.uploadUrl,
          {
            'Content-Type': 'video/mp4',
          },
          ReactNativeBlobUtil.wrap(video.uri.replace('file://', ''))
        )
          .uploadProgress({ interval: 100 }, (written, total) => {
            if (!isCancelledRef.current) {
              setState({
                status: 'uploading',
                progress: written / total,
              });
            }
          })
          .then((response) => {
            if (response.respInfo.status >= 400) {
              throw new Error('Upload failed');
            }
          });

        if (isCancelledRef.current) return;

        // Step 3: Create job
        setState({ status: 'processing', progress: 0, step: 'Starting...' });

        const job = await vopiClient.createJob({
          videoUrl: presign.publicUrl,
          config,
        });

        currentJobIdRef.current = job.id;

        if (isCancelledRef.current) {
          await vopiClient.cancelJob(job.id);
          return;
        }

        // Step 4: Poll for completion
        const pollStatus = async () => {
          if (isCancelledRef.current) {
            cleanup();
            return;
          }

          try {
            const status = await vopiClient.getJobStatus(job.id);

            setState({
              status: 'processing',
              progress: status.progress?.percentage || 0,
              step: status.progress?.message || capitalizeFirst(status.status),
            });

            if (
              status.status === 'completed' ||
              status.status === 'failed' ||
              status.status === 'cancelled'
            ) {
              cleanup();
              await handleJobComplete(job.id, status.status);
            }
          } catch (error) {
            // Continue polling on transient errors
            console.warn('Polling error:', error);
          }
        };

        // Start polling
        pollStatus();
        pollingRef.current = setInterval(pollStatus, VOPIConfig.pollingInterval);
      } catch (error) {
        cleanup();
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        setState({ status: 'error', message });
      }
    },
    [cleanup]
  );

  const handleJobComplete = async (jobId: string, status: JobStatusType) => {
    if (status === 'completed') {
      try {
        const [job, downloadUrls] = await Promise.all([
          vopiClient.getJob(jobId),
          // Use presigned download URLs (required for private S3 bucket)
          vopiClient.getDownloadUrls(jobId),
        ]);

        setState({
          status: 'completed',
          job,
          images: downloadUrls.commercialImages,
        });
      } catch (error) {
        setState({
          status: 'error',
          message: 'Failed to fetch results',
        });
      }
    } else {
      setState({
        status: 'error',
        message: `Job ${status}`,
      });
    }
  };

  const cancel = useCallback(async () => {
    isCancelledRef.current = true;
    cleanup();

    if (currentJobIdRef.current) {
      try {
        await vopiClient.cancelJob(currentJobIdRef.current);
      } catch {
        // Ignore errors when cancelling
      }
    }

    setState({ status: 'cancelled' });
  }, [cleanup]);

  const reset = useCallback(() => {
    cleanup();
    isCancelledRef.current = false;
    currentJobIdRef.current = null;
    setState({ status: 'idle' });
  }, [cleanup]);

  return {
    state,
    uploadAndProcess,
    cancel,
    reset,
  };
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
```

### useVOPIJobs Hook

```typescript
// src/hooks/useVOPIJobs.ts
import { useState, useCallback, useEffect } from 'react';
import { vopiClient } from '../services/vopi.client';
import { Job, JobStatusType } from '../types/vopi.types';

interface UseVOPIJobsOptions {
  status?: JobStatusType;
  limit?: number;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export function useVOPIJobs(options: UseVOPIJobsOptions = {}) {
  const {
    status,
    limit = 20,
    autoRefresh = false,
    refreshInterval = 10000,
  } = options;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const fetchJobs = useCallback(
    async (newOffset = 0) => {
      setLoading(true);
      setError(null);

      try {
        const result = await vopiClient.listJobs({
          status,
          limit,
          offset: newOffset,
        });

        if (newOffset === 0) {
          setJobs(result.jobs);
        } else {
          setJobs((prev) => [...prev, ...result.jobs]);
        }
        setTotal(result.total);
        setOffset(newOffset);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
      } finally {
        setLoading(false);
      }
    },
    [status, limit]
  );

  const refresh = useCallback(() => fetchJobs(0), [fetchJobs]);

  const loadMore = useCallback(() => {
    if (!loading && jobs.length < total) {
      fetchJobs(offset + limit);
    }
  }, [loading, jobs.length, total, offset, limit, fetchJobs]);

  useEffect(() => {
    fetchJobs(0);
  }, [fetchJobs]);

  useEffect(() => {
    if (autoRefresh) {
      const interval = setInterval(refresh, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, refreshInterval, refresh]);

  return {
    jobs,
    total,
    loading,
    error,
    refresh,
    loadMore,
    hasMore: jobs.length < total,
  };
}
```

## Components

### Video Picker Component

```typescript
// src/components/VideoPicker.tsx
import React from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import {
  launchImageLibrary,
  ImagePickerResponse,
} from 'react-native-image-picker';

interface VideoPickerProps {
  onSelect: (video: { uri: string; fileName?: string; type?: string }) => void;
  disabled?: boolean;
}

export function VideoPicker({ onSelect, disabled }: VideoPickerProps) {
  const handlePress = async () => {
    try {
      const result: ImagePickerResponse = await launchImageLibrary({
        mediaType: 'video',
        quality: 1,
        selectionLimit: 1,
      });

      if (result.didCancel) return;

      if (result.errorCode) {
        Alert.alert('Error', result.errorMessage || 'Failed to pick video');
        return;
      }

      const asset = result.assets?.[0];
      if (asset?.uri) {
        onSelect({
          uri: asset.uri,
          fileName: asset.fileName,
          type: asset.type,
        });
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to access video library');
    }
  };

  return (
    <TouchableOpacity
      style={[styles.button, disabled && styles.buttonDisabled]}
      onPress={handlePress}
      disabled={disabled}
    >
      <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>
        Select Video
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#A0A0A0',
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonTextDisabled: {
    color: '#E0E0E0',
  },
});
```

### Progress Component

```typescript
// src/components/UploadProgress.tsx
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { UploadState } from '../types/vopi.types';

interface UploadProgressProps {
  state: UploadState;
  onCancel: () => void;
}

export function UploadProgress({ state, onCancel }: UploadProgressProps) {
  if (state.status === 'idle' || state.status === 'completed') {
    return null;
  }

  const getProgressValue = () => {
    if (state.status === 'uploading') {
      return state.progress;
    }
    if (state.status === 'processing') {
      return state.progress / 100;
    }
    return 0;
  };

  const getStatusText = () => {
    if (state.status === 'uploading') {
      return `Uploading: ${Math.round(state.progress * 100)}%`;
    }
    if (state.status === 'processing') {
      return `${state.step}: ${state.progress}%`;
    }
    if (state.status === 'error') {
      return `Error: ${state.message}`;
    }
    if (state.status === 'cancelled') {
      return 'Cancelled';
    }
    return '';
  };

  const isActive =
    state.status === 'uploading' || state.status === 'processing';

  return (
    <View style={styles.container}>
      <Text style={styles.statusText}>{getStatusText()}</Text>

      {isActive && (
        <>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                { width: `${getProgressValue() * 100}%` },
              ]}
            />
          </View>

          <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    marginVertical: 16,
  },
  statusText: {
    fontSize: 14,
    color: '#333',
    marginBottom: 12,
    textAlign: 'center',
  },
  progressBar: {
    height: 8,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 4,
  },
  cancelButton: {
    marginTop: 12,
    alignItems: 'center',
  },
  cancelText: {
    color: '#FF3B30',
    fontSize: 14,
    fontWeight: '500',
  },
});
```

### Results Gallery Component

```typescript
// src/components/ResultsGallery.tsx
import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
} from 'react-native';
import FastImage from 'react-native-fast-image';

interface ResultsGalleryProps {
  images: Record<string, Record<string, string>>;
  onImagePress?: (url: string) => void;
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const IMAGE_SIZE = (SCREEN_WIDTH - 48) / 2;

export function ResultsGallery({ images, onImagePress }: ResultsGalleryProps) {
  const variants = Object.keys(images);

  if (variants.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No results available</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {variants.map((variant) => (
        <View key={variant} style={styles.section}>
          <Text style={styles.sectionTitle}>
            {variant.charAt(0).toUpperCase() + variant.slice(1)}
          </Text>

          <View style={styles.grid}>
            {Object.entries(images[variant]).map(([version, url]) => (
              <TouchableOpacity
                key={version}
                style={styles.imageContainer}
                onPress={() => onImagePress?.(url)}
                activeOpacity={0.8}
              >
                <FastImage
                  source={{ uri: url }}
                  style={styles.image}
                  resizeMode={FastImage.resizeMode.cover}
                />
                <Text style={styles.versionLabel}>
                  {version.charAt(0).toUpperCase() + version.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
  },
  imageContainer: {
    width: IMAGE_SIZE,
    marginHorizontal: 4,
    marginBottom: 8,
  },
  image: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    borderRadius: 8,
    backgroundColor: '#F0F0F0',
  },
  versionLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
    textAlign: 'center',
  },
});
```

## Complete Example

### Main App Screen

```typescript
// src/screens/HomeScreen.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Modal,
  TouchableOpacity,
} from 'react-native';
import { useVOPIUpload } from '../hooks/useVOPIUpload';
import { VideoPicker } from '../components/VideoPicker';
import { UploadProgress } from '../components/UploadProgress';
import { ResultsGallery } from '../components/ResultsGallery';

export function HomeScreen() {
  const { state, uploadAndProcess, cancel, reset } = useVOPIUpload();
  const [showResults, setShowResults] = useState(false);

  const handleVideoSelect = (video: {
    uri: string;
    fileName?: string;
    type?: string;
  }) => {
    uploadAndProcess(video, {
      fps: 10,
      commercialVersions: ['transparent', 'solid', 'real', 'creative'],
    });
  };

  const isProcessing =
    state.status === 'uploading' || state.status === 'processing';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>VOPI</Text>
        <Text style={styles.subtitle}>Video Object Processing</Text>

        <View style={styles.mainContent}>
          <VideoPicker onSelect={handleVideoSelect} disabled={isProcessing} />

          <UploadProgress state={state} onCancel={cancel} />

          {state.status === 'completed' && (
            <View style={styles.completedActions}>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => setShowResults(true)}
              >
                <Text style={styles.primaryButtonText}>View Results</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.secondaryButton} onPress={reset}>
                <Text style={styles.secondaryButtonText}>
                  Process Another Video
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {(state.status === 'error' || state.status === 'cancelled') && (
            <TouchableOpacity style={styles.secondaryButton} onPress={reset}>
              <Text style={styles.secondaryButtonText}>Try Again</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Results Modal */}
      <Modal
        visible={showResults && state.status === 'completed'}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Results</Text>
            <TouchableOpacity onPress={() => setShowResults(false)}>
              <Text style={styles.closeButton}>Done</Text>
            </TouchableOpacity>
          </View>

          {state.status === 'completed' && (
            <ResultsGallery images={state.images} />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 20,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 40,
  },
  mainContent: {
    flex: 1,
    justifyContent: 'center',
  },
  completedActions: {
    marginTop: 24,
  },
  primaryButton: {
    backgroundColor: '#34C759',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#F5F5F5',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#333',
    fontSize: 16,
    fontWeight: '500',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  closeButton: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '500',
  },
});
```

### Zustand Store (Alternative)

```typescript
// src/store/vopi.store.ts
import { create } from 'zustand';
import { UploadState, Job, JobConfig } from '../types/vopi.types';

interface VOPIStore {
  uploadState: UploadState;
  recentJobs: Job[];
  setUploadState: (state: UploadState) => void;
  addRecentJob: (job: Job) => void;
  clearRecentJobs: () => void;
}

export const useVOPIStore = create<VOPIStore>((set) => ({
  uploadState: { status: 'idle' },
  recentJobs: [],

  setUploadState: (state) => set({ uploadState: state }),

  addRecentJob: (job) =>
    set((prev) => ({
      recentJobs: [job, ...prev.recentJobs.slice(0, 9)],
    })),

  clearRecentJobs: () => set({ recentJobs: [] }),
}));
```

## Expo Configuration

For Expo projects, use `expo-image-picker`:

```typescript
// src/components/VideoPicker.expo.tsx
import React from 'react';
import { TouchableOpacity, Text, StyleSheet, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

interface VideoPickerProps {
  onSelect: (video: { uri: string; fileName?: string; type?: string }) => void;
  disabled?: boolean;
}

export function VideoPicker({ onSelect, disabled }: VideoPickerProps) {
  const handlePress = async () => {
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          'Permission Required',
          'Please allow access to your photo library'
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        quality: 1,
        allowsEditing: false,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        onSelect({
          uri: asset.uri,
          fileName: asset.fileName || 'video.mp4',
          type: asset.mimeType,
        });
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to access video library');
    }
  };

  return (
    <TouchableOpacity
      style={[styles.button, disabled && styles.buttonDisabled]}
      onPress={handlePress}
      disabled={disabled}
    >
      <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>
        Select Video
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#A0A0A0',
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonTextDisabled: {
    color: '#E0E0E0',
  },
});
```

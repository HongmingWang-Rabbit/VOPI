# React Native Integration Guide

Complete guide for integrating VOPI into React Native applications using TypeScript with OAuth authentication.

## Production API

```
https://api.vopi.24rabbit.com
```

> **Important: Private S3 Bucket**
>
> The VOPI S3 bucket is private. Direct URLs in job results are not publicly accessible. You must use the `/jobs/:id/download-urls` endpoint to get presigned URLs with temporary access tokens. These URLs expire after a configurable time (default: 1 hour).

## Table of Contents

- [Setup](#setup)
- [Dependencies](#dependencies)
- [Authentication](#authentication)
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

# OAuth and secure storage
npm install react-native-inappbrowser-reborn react-native-keychain

# Video picker
npm install react-native-image-picker

# State management (optional but recommended)
npm install zustand

# Image display
npm install react-native-fast-image
```

For iOS, add to `Info.plist`:
```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>We need access to your photo library to select videos</string>
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>your-app-scheme</string>
    </array>
  </dict>
</array>
```

For Android, add to `AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />

<activity android:name="com.reactnativeinappbrowser.ChromeTabsManagerActivity"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="your-app-scheme" />
    </intent-filter>
</activity>
```

## Authentication

### Configuration

```typescript
// src/config/vopi.config.ts
export const VOPIConfig = {
  baseURL: 'https://api.vopi.24rabbit.com',
  appScheme: 'your-app-scheme',
  uploadTimeout: 300000, // 5 minutes
  requestTimeout: 30000,
  pollingInterval: 3000,
} as const;
```

### Auth Context

```typescript
// src/contexts/AuthContext.tsx
import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import InAppBrowser from 'react-native-inappbrowser-reborn';
import * as Keychain from 'react-native-keychain';
import { Linking, Platform } from 'react-native';
import { VOPIConfig } from '../config/vopi.config';

interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  emailVerified: boolean;
  createdAt: string;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface AuthContextType {
  user: User | null;
  tokens: AuthTokens | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  getValidAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const KEYCHAIN_SERVICE = 'vopi-auth';
const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000; // 5 minutes before expiry

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load stored tokens on mount
  useEffect(() => {
    loadStoredAuth();
  }, []);

  // Handle deep link callback
  useEffect(() => {
    const handleDeepLink = async (event: { url: string }) => {
      const url = event.url;
      if (url.startsWith(`${VOPIConfig.appScheme}://auth/callback`)) {
        await handleAuthCallback(url);
      }
    };

    const subscription = Linking.addEventListener('url', handleDeepLink);

    // Check for initial URL (app opened via deep link)
    Linking.getInitialURL().then((url) => {
      if (url && url.startsWith(`${VOPIConfig.appScheme}://auth/callback`)) {
        handleAuthCallback(url);
      }
    });

    return () => subscription.remove();
  }, []);

  const loadStoredAuth = async () => {
    try {
      const credentials = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
      if (credentials) {
        const stored = JSON.parse(credentials.password) as AuthTokens;
        setTokens(stored);

        // Fetch user profile
        const response = await fetch(`${VOPIConfig.baseURL}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${stored.accessToken}` },
        });

        if (response.ok) {
          const userData = await response.json();
          setUser(userData.user);
        } else if (response.status === 401) {
          // Token expired, try refresh
          const refreshed = await refreshWithToken(stored.refreshToken);
          if (!refreshed) {
            await clearAuth();
          }
        }
      }
    } catch (error) {
      console.error('Failed to load stored auth:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const storeTokens = async (newTokens: AuthTokens) => {
    await Keychain.setGenericPassword('auth', JSON.stringify(newTokens), {
      service: KEYCHAIN_SERVICE,
    });
    setTokens(newTokens);
  };

  const clearAuth = async () => {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
    setTokens(null);
    setUser(null);
  };

  const handleAuthCallback = async (url: string) => {
    try {
      const urlObj = new URL(url);
      const code = urlObj.searchParams.get('code');
      const state = urlObj.searchParams.get('state');
      const provider = urlObj.searchParams.get('provider') || 'google';

      if (!code || !state) {
        throw new Error('Missing code or state in callback');
      }

      // Exchange code for tokens
      const response = await fetch(`${VOPIConfig.baseURL}/api/v1/auth/${provider}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Authentication failed');
      }

      const data = await response.json();

      await storeTokens({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + data.expiresIn * 1000,
      });

      setUser(data.user);
    } catch (error) {
      console.error('Auth callback error:', error);
      throw error;
    }
  };

  const signInWithProvider = async (provider: 'google' | 'apple') => {
    try {
      // Generate state and PKCE verifier
      const state = generateRandomString(32);
      const codeVerifier = generateRandomString(64);

      // Store PKCE verifier temporarily
      await Keychain.setGenericPassword('pkce', JSON.stringify({ state, codeVerifier }), {
        service: `${KEYCHAIN_SERVICE}-pkce`,
      });

      // Get auth URL
      const redirectUri = `${VOPIConfig.appScheme}://auth/callback`;
      const initResponse = await fetch(
        `${VOPIConfig.baseURL}/api/v1/auth/${provider}/init?` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `state=${state}&` +
        `code_challenge=${await generateCodeChallenge(codeVerifier)}&` +
        `code_challenge_method=S256`
      );

      if (!initResponse.ok) {
        throw new Error('Failed to initialize OAuth');
      }

      const { authUrl } = await initResponse.json();

      // Open in-app browser
      if (await InAppBrowser.isAvailable()) {
        await InAppBrowser.openAuth(authUrl, redirectUri, {
          ephemeralWebSession: true,
          showTitle: false,
          enableUrlBarHiding: true,
          enableDefaultShare: false,
        });
      } else {
        await Linking.openURL(authUrl);
      }
    } catch (error) {
      console.error(`${provider} sign in error:`, error);
      throw error;
    }
  };

  const signInWithGoogle = () => signInWithProvider('google');
  const signInWithApple = () => signInWithProvider('apple');

  const signOut = async () => {
    try {
      if (tokens?.accessToken) {
        await fetch(`${VOPIConfig.baseURL}/api/v1/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
      }
    } catch (error) {
      console.warn('Logout API error:', error);
    }
    await clearAuth();
  };

  const refreshWithToken = async (refreshToken: string): Promise<boolean> => {
    try {
      const response = await fetch(`${VOPIConfig.baseURL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) return false;

      const data = await response.json();

      await storeTokens({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + data.expiresIn * 1000,
      });

      setUser(data.user);
      return true;
    } catch {
      return false;
    }
  };

  const refreshSession = useCallback(async (): Promise<boolean> => {
    if (!tokens?.refreshToken) return false;
    return refreshWithToken(tokens.refreshToken);
  }, [tokens?.refreshToken]);

  const getValidAccessToken = useCallback(async (): Promise<string | null> => {
    if (!tokens) return null;

    // Check if token needs refresh
    if (Date.now() >= tokens.expiresAt - TOKEN_REFRESH_MARGIN) {
      const success = await refreshSession();
      if (!success) return null;

      // Get updated tokens
      const credentials = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
      if (credentials) {
        const updated = JSON.parse(credentials.password) as AuthTokens;
        return updated.accessToken;
      }
      return null;
    }

    return tokens.accessToken;
  }, [tokens, refreshSession]);

  return (
    <AuthContext.Provider
      value={{
        user,
        tokens,
        isLoading,
        isAuthenticated: !!user && !!tokens,
        signInWithGoogle,
        signInWithApple,
        signOut,
        refreshSession,
        getValidAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Utility functions
function generateRandomString(length: number): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomValues = new Uint8Array(length);

  // Use crypto.getRandomValues if available, otherwise fallback
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomValues);
  } else {
    for (let i = 0; i < length; i++) {
      randomValues[i] = Math.floor(Math.random() * 256);
    }
  }

  for (let i = 0; i < length; i++) {
    result += charset[randomValues[i] % charset.length];
  }
  return result;
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  // In React Native, use crypto-js or expo-crypto
  // This is a simplified version - use proper SHA256 in production
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
```

## API Client

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
  CreditBalance,
} from '../types/vopi.types';

type GetAccessToken = () => Promise<string | null>;

class VOPIClient {
  private client: AxiosInstance;
  private getAccessToken: GetAccessToken | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: VOPIConfig.baseURL,
      timeout: VOPIConfig.requestTimeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add auth token to requests
    this.client.interceptors.request.use(async (config) => {
      if (this.getAccessToken) {
        const token = await this.getAccessToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      }
      return config;
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

  setTokenProvider(getAccessToken: GetAccessToken) {
    this.getAccessToken = getAccessToken;
  }

  // Credits
  async getCreditBalance(): Promise<CreditBalance> {
    const { data } = await this.client.get<CreditBalance>('/api/v1/credits/balance');
    return data;
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

### Initialize Client with Auth

```typescript
// src/App.tsx or where you initialize your app
import { useEffect } from 'react';
import { useAuth } from './contexts/AuthContext';
import { vopiClient } from './services/vopi.client';

function AppInitializer({ children }: { children: React.ReactNode }) {
  const { getValidAccessToken } = useAuth();

  useEffect(() => {
    vopiClient.setTokenProvider(getValidAccessToken);
  }, [getValidAccessToken]);

  return <>{children}</>;
}
```

## Types

```typescript
// src/types/vopi.types.ts

// API Error
export interface ApiError {
  error: string;
  statusCode: number;
  details?: Record<string, string>;
}

// Credits
export interface CreditBalance {
  balance: number;
  transactions?: CreditTransaction[];
}

export interface CreditTransaction {
  id: string;
  creditsDelta: number;
  type: 'signup_grant' | 'purchase' | 'spend' | 'refund';
  description?: string;
  createdAt: string;
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
export interface ProductMetadataOutput {
  transcript: string;
  product: ProductMetadata;
  platforms: PlatformFormats;
  extractedAt: string;
  audioDuration?: number;
  pipelineVersion: string;
}

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

export interface MetadataConfidence {
  overall: number;
  title: number;
  description: number;
  price?: number;
  attributes?: number;
}

export interface PlatformFormats {
  shopify: ShopifyProduct;
  amazon: AmazonProduct;
  ebay: EbayProduct;
}

export interface ShopifyProduct {
  title: string;
  descriptionHtml: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  status?: string;
}

export interface AmazonProduct {
  item_name: string;
  brand_name?: string;
  product_description?: string;
  bullet_point?: string[];
  generic_keyword?: string[];
  color?: string;
  material?: string[];
}

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

### useCredits Hook

```typescript
// src/hooks/useCredits.ts
import { useState, useCallback, useEffect } from 'react';
import { vopiClient } from '../services/vopi.client';
import { CreditBalance } from '../types/vopi.types';
import { useAuth } from '../contexts/AuthContext';

export function useCredits() {
  const { isAuthenticated } = useAuth();
  const [balance, setBalance] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    if (!isAuthenticated) return;

    setLoading(true);
    setError(null);

    try {
      const data = await vopiClient.getCreditBalance();
      setBalance(data.balance);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch balance');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  return {
    balance,
    loading,
    error,
    refresh: fetchBalance,
  };
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

### Login Screen

```typescript
// src/screens/LoginScreen.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';

export function LoginScreen() {
  const { signInWithGoogle, signInWithApple } = useAuth();
  const [loading, setLoading] = useState<'google' | 'apple' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async (provider: 'google' | 'apple') => {
    setLoading(provider);
    setError(null);

    try {
      if (provider === 'google') {
        await signInWithGoogle();
      } else {
        await signInWithApple();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(null);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>VOPI</Text>
      <Text style={styles.subtitle}>Video Object Processing</Text>

      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.googleButton]}
          onPress={() => handleSignIn('google')}
          disabled={loading !== null}
        >
          {loading === 'google' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Continue with Google</Text>
          )}
        </TouchableOpacity>

        {Platform.OS === 'ios' && (
          <TouchableOpacity
            style={[styles.button, styles.appleButton]}
            onPress={() => handleSignIn('apple')}
            disabled={loading !== null}
          >
            {loading === 'apple' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Continue with Apple</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 48,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 18,
    color: '#666',
    marginBottom: 60,
  },
  buttonContainer: {
    width: '100%',
    maxWidth: 300,
  },
  button: {
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  googleButton: {
    backgroundColor: '#4285F4',
  },
  appleButton: {
    backgroundColor: '#000',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#FF3B30',
    marginTop: 20,
    textAlign: 'center',
  },
});
```

### Video Picker Component

```typescript
// src/components/VideoPicker.tsx
import React from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  Alert,
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

### App Entry Point

```typescript
// App.tsx
import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import { vopiClient } from './src/services/vopi.client';
import { LoginScreen } from './src/screens/LoginScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ActivityIndicator, View } from 'react-native';

const Stack = createNativeStackNavigator();

function AppNavigator() {
  const { isAuthenticated, isLoading, getValidAccessToken } = useAuth();

  // Set up API client with token provider
  useEffect(() => {
    vopiClient.setTokenProvider(getValidAccessToken);
  }, [getValidAccessToken]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {isAuthenticated ? (
        <Stack.Screen name="Home" component={HomeScreen} />
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>
    </AuthProvider>
  );
}
```

### Home Screen

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
import { useAuth } from '../contexts/AuthContext';
import { useVOPIUpload } from '../hooks/useVOPIUpload';
import { useCredits } from '../hooks/useCredits';
import { VideoPicker } from '../components/VideoPicker';
import { UploadProgress } from '../components/UploadProgress';
import { ResultsGallery } from '../components/ResultsGallery';

export function HomeScreen() {
  const { user, signOut } = useAuth();
  const { balance } = useCredits();
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
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hello, {user?.name || 'User'}</Text>
          <Text style={styles.credits}>{balance} credits</Text>
        </View>
        <TouchableOpacity onPress={signOut}>
          <Text style={styles.signOut}>Sign Out</Text>
        </TouchableOpacity>
      </View>

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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  greeting: {
    fontSize: 16,
    fontWeight: '600',
  },
  credits: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  signOut: {
    color: '#FF3B30',
    fontSize: 14,
    fontWeight: '500',
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

## Zustand Store (Alternative)

```typescript
// src/store/vopi.store.ts
import { create } from 'zustand';
import { UploadState, Job } from '../types/vopi.types';

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

## Security Best Practices

1. **Token Storage**: Always use `react-native-keychain` for storing tokens securely
2. **Token Refresh**: Automatically refresh tokens before they expire
3. **PKCE**: Use PKCE for OAuth to prevent authorization code interception
4. **Secure Transport**: All API calls use HTTPS
5. **Token Validation**: Always validate tokens server-side

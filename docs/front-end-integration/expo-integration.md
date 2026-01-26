# Expo Integration Guide

Complete guide for integrating VOPI into Expo applications with OAuth authentication, secure token storage, and video processing.

> **Recommended for new React Native projects.** Expo provides a smoother development experience with managed native modules.

## Table of Contents

- [Setup](#setup)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [API Client](#api-client)
- [Types](#types)
- [Hooks](#hooks)
- [Components](#components)
- [Complete Example App](#complete-example-app)

---

## Setup

### Requirements

- Expo SDK 50+
- TypeScript 5.0+
- Node.js 18+

### Create New Project

```bash
npx create-expo-app@latest my-vopi-app --template blank-typescript
cd my-vopi-app
```

### Install Dependencies

```bash
# Core dependencies
npx expo install expo-secure-store expo-image-picker expo-file-system expo-web-browser expo-auth-session expo-crypto

# Additional UI dependencies (optional)
npx expo install expo-image expo-linear-gradient
```

### App Configuration

Update `app.json` or `app.config.js`:

```json
{
  "expo": {
    "name": "My VOPI App",
    "slug": "my-vopi-app",
    "scheme": "myvopiapp",
    "ios": {
      "bundleIdentifier": "com.yourcompany.myvopiapp",
      "infoPlist": {
        "NSPhotoLibraryUsageDescription": "We need access to your photo library to select videos for processing."
      }
    },
    "android": {
      "package": "com.yourcompany.myvopiapp",
      "permissions": [
        "READ_EXTERNAL_STORAGE",
        "READ_MEDIA_VIDEO"
      ]
    },
    "plugins": [
      [
        "expo-image-picker",
        {
          "photosPermission": "Allow $(PRODUCT_NAME) to access your photos for video selection."
        }
      ]
    ]
  }
}
```

---

## Configuration

### Environment Configuration

```typescript
// src/config/vopi.config.ts

export const VOPIConfig = {
  // Production API
  apiUrl: 'https://api.vopi.24rabbit.com',

  // OAuth redirect scheme (must match app.json scheme)
  scheme: 'myvopiapp',

  // Timeouts
  uploadTimeout: 300000, // 5 minutes
  requestTimeout: 30000, // 30 seconds

  // Polling
  pollingInterval: 3000, // 3 seconds
  maxPollingAttempts: 200, // ~10 minutes max
} as const;

// OAuth redirect URI for your app
export const getRedirectUri = () => {
  return `${VOPIConfig.scheme}://oauth/callback`;
};
```

---

## Authentication

### Auth Context

Complete authentication context with OAuth, token refresh, and secure storage.

```typescript
// src/contexts/AuthContext.tsx

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { VOPIConfig, getRedirectUri } from '../config/vopi.config';

// Ensure web browser auth sessions are dismissed
WebBrowser.maybeCompleteAuthSession();

// Types
interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  creditsBalance: number;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Secure storage keys
const STORAGE_KEYS = {
  ACCESS_TOKEN: 'vopi_access_token',
  REFRESH_TOKEN: 'vopi_refresh_token',
  USER: 'vopi_user',
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });

  const isRefreshing = useRef(false);
  const refreshPromise = useRef<Promise<string | null> | null>(null);

  // Load stored user on mount
  useEffect(() => {
    loadStoredAuth();
  }, []);

  const loadStoredAuth = async () => {
    try {
      const [accessToken, userJson] = await Promise.all([
        SecureStore.getItemAsync(STORAGE_KEYS.ACCESS_TOKEN),
        SecureStore.getItemAsync(STORAGE_KEYS.USER),
      ]);

      if (accessToken && userJson) {
        const user = JSON.parse(userJson) as User;

        // Verify token is still valid by fetching fresh user data
        try {
          const freshUser = await fetchUserProfile(accessToken);
          setState({
            user: freshUser,
            isLoading: false,
            isAuthenticated: true,
          });
          await SecureStore.setItemAsync(STORAGE_KEYS.USER, JSON.stringify(freshUser));
        } catch (error) {
          // Token might be expired, try refresh
          const newToken = await refreshAccessToken();
          if (newToken) {
            const freshUser = await fetchUserProfile(newToken);
            setState({
              user: freshUser,
              isLoading: false,
              isAuthenticated: true,
            });
          } else {
            // Refresh failed, clear auth
            await clearAuth();
            setState({ user: null, isLoading: false, isAuthenticated: false });
          }
        }
      } else {
        setState({ user: null, isLoading: false, isAuthenticated: false });
      }
    } catch (error) {
      console.error('Failed to load stored auth:', error);
      setState({ user: null, isLoading: false, isAuthenticated: false });
    }
  };

  const fetchUserProfile = async (accessToken: string): Promise<User> => {
    const response = await fetch(`${VOPIConfig.apiUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user profile');
    }

    const profile = await response.json();

    // Also fetch credit balance
    const balanceResponse = await fetch(`${VOPIConfig.apiUrl}/api/v1/credits/balance`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let creditsBalance = 0;
    if (balanceResponse.ok) {
      const balanceData = await balanceResponse.json();
      creditsBalance = balanceData.balance;
    }

    return {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      creditsBalance,
    };
  };

  const signInWithProvider = async (provider: 'google' | 'apple') => {
    try {
      setState(prev => ({ ...prev, isLoading: true }));

      const redirectUri = getRedirectUri();

      // Step 1: Initialize OAuth
      const initResponse = await fetch(`${VOPIConfig.apiUrl}/api/v1/auth/oauth/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, redirectUri }),
      });

      if (!initResponse.ok) {
        throw new Error('Failed to initialize OAuth');
      }

      const { authorizationUrl, state: oauthState, codeVerifier } = await initResponse.json();

      // Store OAuth state temporarily
      await SecureStore.setItemAsync('oauth_state', oauthState);
      await SecureStore.setItemAsync('oauth_code_verifier', codeVerifier || '');
      await SecureStore.setItemAsync('oauth_provider', provider);

      // Step 2: Open browser for OAuth
      const result = await WebBrowser.openAuthSessionAsync(
        authorizationUrl,
        redirectUri
      );

      if (result.type !== 'success' || !result.url) {
        setState(prev => ({ ...prev, isLoading: false }));
        return;
      }

      // Step 3: Extract code from redirect URL
      const url = new URL(result.url);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code) {
        throw new Error('No authorization code received');
      }

      // Retrieve stored OAuth state
      const storedState = await SecureStore.getItemAsync('oauth_state');
      const storedCodeVerifier = await SecureStore.getItemAsync('oauth_code_verifier');
      const storedProvider = await SecureStore.getItemAsync('oauth_provider');

      // Validate state
      if (returnedState !== storedState) {
        throw new Error('OAuth state mismatch - possible CSRF attack');
      }

      // Step 4: Exchange code for tokens
      const callbackResponse = await fetch(`${VOPIConfig.apiUrl}/api/v1/auth/oauth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: storedProvider,
          code,
          redirectUri,
          state: storedState,
          codeVerifier: storedCodeVerifier || undefined,
          deviceInfo: {
            deviceName: `Expo App`,
          },
        }),
      });

      if (!callbackResponse.ok) {
        const error = await callbackResponse.json();
        throw new Error(error.message || 'Failed to exchange code for tokens');
      }

      const { accessToken, refreshToken, user } = await callbackResponse.json();

      // Store tokens and user
      await Promise.all([
        SecureStore.setItemAsync(STORAGE_KEYS.ACCESS_TOKEN, accessToken),
        SecureStore.setItemAsync(STORAGE_KEYS.REFRESH_TOKEN, refreshToken),
        SecureStore.setItemAsync(STORAGE_KEYS.USER, JSON.stringify(user)),
      ]);

      // Clean up OAuth state
      await Promise.all([
        SecureStore.deleteItemAsync('oauth_state'),
        SecureStore.deleteItemAsync('oauth_code_verifier'),
        SecureStore.deleteItemAsync('oauth_provider'),
      ]);

      setState({
        user,
        isLoading: false,
        isAuthenticated: true,
      });
    } catch (error) {
      console.error('Sign in error:', error);
      setState(prev => ({ ...prev, isLoading: false }));
      throw error;
    }
  };

  const signInWithGoogle = useCallback(() => signInWithProvider('google'), []);
  const signInWithApple = useCallback(() => signInWithProvider('apple'), []);

  const signOut = useCallback(async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync(STORAGE_KEYS.REFRESH_TOKEN);

      if (refreshToken) {
        // Revoke token on server
        await fetch(`${VOPIConfig.apiUrl}/api/v1/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      }
    } catch (error) {
      console.warn('Failed to revoke token:', error);
    } finally {
      await clearAuth();
      setState({ user: null, isLoading: false, isAuthenticated: false });
    }
  }, []);

  const clearAuth = async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(STORAGE_KEYS.ACCESS_TOKEN),
      SecureStore.deleteItemAsync(STORAGE_KEYS.REFRESH_TOKEN),
      SecureStore.deleteItemAsync(STORAGE_KEYS.USER),
    ]);
  };

  const refreshAccessToken = async (): Promise<string | null> => {
    // Prevent concurrent refresh requests
    if (isRefreshing.current) {
      return refreshPromise.current;
    }

    isRefreshing.current = true;
    refreshPromise.current = (async () => {
      try {
        const refreshToken = await SecureStore.getItemAsync(STORAGE_KEYS.REFRESH_TOKEN);

        if (!refreshToken) {
          return null;
        }

        const response = await fetch(`${VOPIConfig.apiUrl}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        if (!response.ok) {
          await clearAuth();
          return null;
        }

        const { accessToken, refreshToken: newRefreshToken } = await response.json();

        await Promise.all([
          SecureStore.setItemAsync(STORAGE_KEYS.ACCESS_TOKEN, accessToken),
          SecureStore.setItemAsync(STORAGE_KEYS.REFRESH_TOKEN, newRefreshToken),
        ]);

        return accessToken;
      } catch (error) {
        console.error('Token refresh failed:', error);
        return null;
      } finally {
        isRefreshing.current = false;
        refreshPromise.current = null;
      }
    })();

    return refreshPromise.current;
  };

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const accessToken = await SecureStore.getItemAsync(STORAGE_KEYS.ACCESS_TOKEN);

    if (!accessToken) {
      return null;
    }

    // Check if token is expired
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1]));
      const expiresAt = payload.exp * 1000;
      const now = Date.now();
      const bufferMs = 60 * 1000; // 1 minute buffer

      if (expiresAt - bufferMs < now) {
        // Token is expired or about to expire, refresh it
        return await refreshAccessToken();
      }

      return accessToken;
    } catch {
      // If we can't decode the token, try to refresh
      return await refreshAccessToken();
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const accessToken = await getAccessToken();
    if (accessToken) {
      const freshUser = await fetchUserProfile(accessToken);
      setState(prev => ({ ...prev, user: freshUser }));
      await SecureStore.setItemAsync(STORAGE_KEYS.USER, JSON.stringify(freshUser));
    }
  }, [getAccessToken]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        signInWithGoogle,
        signInWithApple,
        signOut,
        refreshUser,
        getAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  ifoken (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
```

---

## API Client

### Authenticated API Client

```typescript
// src/services/api.client.ts

import { VOPIConfig } from '../config/vopi.config';

type GetAccessToken = () => Promise<string | null>;

class APIClient {
  private getAccessToken: GetAccessToken | null = null;

  setTokenGetter(getter: GetAccessToken) {
    this.getAccessToken = getter;
  }

  private async getHeaders(): Promise<HeadersInit> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (this.getAccessToken) {
      const token = await this.getAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    return headers;
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(`${VOPIConfig.apiUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: await this.getHeaders(),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${VOPIConfig.apiUrl}${path}`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${VOPIConfig.apiUrl}${path}`, {
      method: 'PATCH',
      headers: await this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async delete<T>(path: string): Promise<T> {
    const response = await fetch(`${VOPIConfig.apiUrl}${path}`, {
      method: 'DELETE',
      headers: await this.getHeaders(),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }
}

export const apiClient = new APIClient();
```

### VOPI Service

```typescript
// src/services/vopi.service.ts

import * as FileSystem from 'expo-file-system';
import { apiClient } from './api.client';
import {
  PresignResponse,
  Job,
  JobStatus,
  DownloadUrlsResponse,
  CreditBalance,
  CreditPack,
  CostEstimate,
  ProductMetadata,
} from '../types/vopi.types';

export const vopiService = {
  // Auth
  getProviders: () => apiClient.get<{ google: boolean; apple: boolean }>('/api/v1/auth/providers'),

  // Credits
  getBalance: () => apiClient.get<CreditBalance>('/api/v1/credits/balance'),

  getPacks: () => apiClient.get<{ packs: CreditPack[]; stripeConfigured: boolean }>('/api/v1/credits/packs'),

  estimateCost: (videoDurationSeconds: number, frameCount?: number) =>
    apiClient.post<CostEstimate>('/api/v1/credits/estimate', {
      videoDurationSeconds,
      frameCount,
    }),

  createCheckout: (packType: string, successUrl: string, cancelUrl: string) =>
    apiClient.post<{ checkoutUrl: string; sessionId: string }>('/api/v1/credits/checkout', {
      packType,
      successUrl,
      cancelUrl,
    }),

  // Uploads
  getPresignedUrl: (filename: string, contentType = 'video/mp4') =>
    apiClient.post<PresignResponse>('/api/v1/uploads/presign', {
      filename,
      contentType,
    }),

  uploadFile: async (
    uploadUrl: string,
    fileUri: string,
    contentType: string,
    onProgress?: (progress: number) => void
  ): Promise<void> => {
    // Get file info
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) {
      throw new Error('File not found');
    }

    // Upload using FileSystem.uploadAsync
    const uploadResult = await FileSystem.uploadAsync(uploadUrl, fileUri, {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        'Content-Type': contentType,
      },
    });

    if (uploadResult.status >= 400) {
      throw new Error(`Upload failed with status ${uploadResult.status}`);
    }

    // Note: expo-file-system doesn't support upload progress callbacks
    // For progress tracking, consider using a different approach or library
    onProgress?.(1);
  },

  // Jobs
  createJob: (videoUrl: string, config?: { stackId?: string }) =>
    apiClient.post<Job>('/api/v1/jobs', { videoUrl, config }),

  getJob: (jobId: string) => apiClient.get<Job>(`/api/v1/jobs/${jobId}`),

  getJobStatus: (jobId: string) => apiClient.get<JobStatus>(`/api/v1/jobs/${jobId}/status`),

  cancelJob: (jobId: string) => apiClient.delete<{ id: string; status: string; message: string }>(`/api/v1/jobs/${jobId}`),

  listJobs: (params?: { status?: string; limit?: number; offset?: number }) =>
    apiClient.get<{ jobs: Job[]; total: number }>('/api/v1/jobs', params),

  getDownloadUrls: (jobId: string, expiresIn = 3600) =>
    apiClient.get<DownloadUrlsResponse>(`/api/v1/jobs/${jobId}/download-urls`, { expiresIn }),

  // Metadata
  getProductMetadata: (jobId: string) =>
    apiClient.get<ProductMetadata>(`/api/v1/jobs/${jobId}/metadata`),

  updateProductMetadata: (jobId: string, updates: Partial<ProductMetadata['product']>) =>
    apiClient.patch<ProductMetadata>(`/api/v1/jobs/${jobId}/metadata`, updates),
};
```

---

## Types

```typescript
// src/types/vopi.types.ts

// Presign
export interface PresignResponse {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  expiresIn: number;
}

// Job
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

export interface Job {
  id: string;
  status: JobStatusType;
  videoUrl: string;
  config?: Record<string, unknown>;
  progress?: JobProgress;
  result?: {
    variantsDiscovered?: number;
    framesAnalyzed?: number;
    finalFrames?: string[];
    commercialImages?: Record<string, Record<string, string>>;
  };
  error?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface JobStatus {
  id: string;
  status: JobStatusType;
  progress?: JobProgress;
  createdAt: string;
  updatedAt?: string;
}

// Download URLs
export interface DownloadUrlsResponse {
  jobId: string;
  expiresIn: number;
  frames: Array<{
    frameId: string;
    downloadUrl: string;
  }>;
  commercialImages: Record<string, Record<string, string>>;
  productMetadata?: ProductMetadata;
}

// Credits
export interface CreditBalance {
  balance: number;
  transactions?: Array<{
    id: string;
    creditsDelta: number;
    type: string;
    description?: string;
    createdAt: string;
  }>;
}

export interface CreditPack {
  packType: string;
  credits: number;
  priceUsd: number;
  name: string;
  available: boolean;
}

export interface CostEstimate {
  totalCredits: number;
  breakdown: Array<{
    type: string;
    description: string;
    credits: number;
  }>;
  canAfford?: boolean;
  currentBalance?: number;
}

// Product Metadata
export interface ProductMetadata {
  transcript: string;
  product: {
    title: string;
    description: string;
    shortDescription?: string;
    bulletPoints: string[];
    brand?: string;
    category?: string;
    materials?: string[];
    color?: string;
    price?: number;
    currency?: string;
    keywords?: string[];
    confidence: {
      overall: number;
      title: number;
      description: number;
    };
  };
  platforms: {
    shopify: Record<string, unknown>;
    amazon: Record<string, unknown>;
    ebay: Record<string, unknown>;
  };
  extractedAt: string;
}

// Upload State
export type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: number }
  | { status: 'processing'; jobId: string; progress: number; step: string }
  | { status: 'completed'; job: Job; downloadUrls: DownloadUrlsResponse }
  | { status: 'error'; message: string }
  | { status: 'cancelled' };
```

---

## Hooks

### useVOPIUpload Hook

```typescript
// src/hooks/useVOPIUpload.ts

import { useState, useCallback, useRef } from 'react';
import { vopiService } from '../services/vopi.service';
import { VOPIConfig } from '../config/vopi.config';
import { UploadState, Job } from '../types/vopi.types';

interface VideoFile {
  uri: string;
  fileName?: string;
  mimeType?: string;
}

export function useVOPIUpload() {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);
  const currentJobIdRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const uploadAndProcess = useCallback(
    async (video: VideoFile, stackId = 'unified_video_analyzer') => {
      isCancelledRef.current = false;
      cleanup();

      try {
        // Step 1: Get presigned URL
        setState({ status: 'uploading', progress: 0 });

        const filename = video.fileName || 'video.mp4';
        const contentType = video.mimeType || 'video/mp4';

        const presign = await vopiService.getPresignedUrl(filename, contentType);

        if (isCancelledRef.current) return;

        // Step 2: Upload to S3
        setState({ status: 'uploading', progress: 0.5 });

        await vopiService.uploadFile(
          presign.uploadUrl,
          video.uri,
          contentType,
          (progress) => {
            if (!isCancelledRef.current) {
              setState({ status: 'uploading', progress });
            }
          }
        );

        if (isCancelledRef.current) return;

        // Step 3: Create job
        setState({ status: 'processing', jobId: '', progress: 0, step: 'Creating job...' });

        const job = await vopiService.createJob(presign.publicUrl, { stackId });
        currentJobIdRef.current = job.id;

        if (isCancelledRef.current) {
          await vopiService.cancelJob(job.id);
          return;
        }

        setState({ status: 'processing', jobId: job.id, progress: 0, step: 'Starting...' });

        // Step 4: Poll for completion
        let attempts = 0;

        const pollStatus = async () => {
          if (isCancelledRef.current) {
            cleanup();
            return;
          }

          attempts++;
          if (attempts > VOPIConfig.maxPollingAttempts) {
            cleanup();
            setState({ status: 'error', message: 'Job timed out' });
            return;
          }

          try {
            const status = await vopiService.getJobStatus(job.id);

            setState({
              status: 'processing',
              jobId: job.id,
              progress: status.progress?.percentage || 0,
              step: status.progress?.message || capitalizeFirst(status.status),
            });

            if (status.status === 'completed') {
              cleanup();
              await handleJobComplete(job.id);
            } else if (status.status === 'failed' || status.status === 'cancelled') {
              cleanup();
              setState({ status: 'error', message: `Job ${status.status}` });
            }
          } catch (error) {
            console.warn('Polling error:', error);
            // Continue polling on transient errors
          }
        };

        // Start polling
        pollStatus();
        pollingRef.current = setInterval(pollStatus, VOPIConfig.pollingInterval);
      } catch (error) {
        cleanup();
        const message = error instanceof Error ? error.message : 'Unknown error';
        setState({ status: 'error', message });
      }
    },
    [cleanup]
  );

  const handleJobComplete = async (jobId: string) => {
    try {
      const [job, downloadUrls] = await Promise.all([
        vopiService.getJob(jobId),
        vopiService.getDownloadUrls(jobId),
      ]);

      setState({
        status: 'completed',
        job,
        downloadUrls,
      });
    } catch (error) {
      setState({
        status: 'error',
        message: 'Failed to fetch results',
      });
    }
  };

  const cancel = useCallback(async () => {
    isCancelledRef.current = true;
    cleanup();

    if (currentJobIdRef.current) {
      try {
        await vopiService.cancelJob(currentJobIdRef.current);
      } catch {
        // Ignore cancellation errors
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
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
}
```

### useCredits Hook

```typescript
// src/hooks/useCredits.ts

import { useState, useEffect, useCallback } from 'react';
import { vopiService } from '../services/vopi.service';
import { CreditBalance, CreditPack, CostEstimate } from '../types/vopi.types';

export function useCredits() {
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    try {
      const data = await vopiService.getBalance();
      setBalance(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch balance');
    }
  }, []);

  const fetchPacks = useCallback(async () => {
    try {
      const data = await vopiService.getPacks();
      setPacks(data.packs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch packs');
    }
  }, []);

  const estimateCost = useCallback(
    async (videoDurationSeconds: number, frameCount?: number): Promise<CostEstimate | null> => {
      try {
        return await vopiService.estimateCost(videoDurationSeconds, frameCount);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to estimate cost');
        return null;
      }
    },
    []
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([fetchBalance(), fetchPacks()]);
    setLoading(false);
  }, [fetchBalance, fetchPacks]);

  useEffect(() => {
    refresh();
  }, []);

  return {
    balance: balance?.balance ?? 0,
    transactions: balance?.transactions ?? [],
    packs,
    loading,
    error,
    refresh,
    estimateCost,
  };
}
```

---

## Components

### Login Screen

```typescript
// src/screens/LoginScreen.tsx

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useAuth } from '../contexts/AuthContext';

export function LoginScreen() {
  const { signInWithGoogle, signInWithApple, isLoading } = useAuth();

  const handleGoogleSignIn = async () => {
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error('Google sign in failed:', error);
    }
  };

  const handleAppleSignIn = async () => {
    try {
      await signInWithApple();
    } catch (error) {
      console.error('Apple sign in failed:', error);
    }
  };

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Signing in...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>VOPI</Text>
        <Text style={styles.subtitle}>Video Object Processing</Text>
      </View>

      <View style={styles.buttons}>
        <TouchableOpacity style={styles.googleButton} onPress={handleGoogleSignIn}>
          <Text style={styles.googleButtonText}>Continue with Google</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.appleButton} onPress={handleAppleSignIn}>
          <Text style={styles.appleButtonText}>Continue with Apple</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.terms}>
        By continuing, you agree to our Terms of Service and Privacy Policy
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 24,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 60,
  },
  title: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#1a1a1a',
  },
  subtitle: {
    fontSize: 18,
    color: '#666',
    marginTop: 8,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
  },
  buttons: {
    gap: 16,
  },
  googleButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  appleButton: {
    backgroundColor: '#000',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  appleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  terms: {
    marginTop: 40,
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
  },
});
```

### Video Picker

```typescript
// src/components/VideoPicker.tsx

import React from 'react';
import { TouchableOpacity, Text, StyleSheet, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

interface VideoPickerProps {
  onSelect: (video: { uri: string; fileName?: string; mimeType?: string }) => void;
  disabled?: boolean;
}

export function VideoPicker({ onSelect, disabled }: VideoPickerProps) {
  const handlePress = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          'Permission Required',
          'Please allow access to your photo library to select videos.'
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
          mimeType: asset.mimeType || 'video/mp4',
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
    backgroundColor: '#ccc',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonTextDisabled: {
    color: '#999',
  },
});
```

### Upload Progress

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
    if (state.status === 'uploading') return state.progress;
    if (state.status === 'processing') return state.progress / 100;
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

  const isActive = state.status === 'uploading' || state.status === 'processing';

  return (
    <View style={styles.container}>
      <Text style={styles.statusText}>{getStatusText()}</Text>

      {isActive && (
        <>
          <View style={styles.progressBar}>
            <View
              style={[styles.progressFill, { width: `${getProgressValue() * 100}%` }]}
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
    backgroundColor: '#f5f5f5',
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
    backgroundColor: '#ddd',
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

---

## Complete Example App

### App Entry Point

```typescript
// App.tsx

import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import { apiClient } from './src/services/api.client';
import { LoginScreen } from './src/screens/LoginScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ResultsScreen } from './src/screens/ResultsScreen';

const Stack = createNativeStackNavigator();

function AppNavigator() {
  const { isAuthenticated, isLoading, getAccessToken } = useAuth();

  // Connect API client to auth context
  useEffect(() => {
    apiClient.setTokenGetter(getAccessToken);
  }, [getAccessToken]);

  if (isLoading) {
    return null; // Or a splash screen
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {isAuthenticated ? (
        <>
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Results" component={ResultsScreen} />
        </>
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

import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../contexts/AuthContext';
import { useCredits } from '../hooks/useCredits';
import { useVOPIUpload } from '../hooks/useVOPIUpload';
import { VideoPicker } from '../components/VideoPicker';
import { UploadProgress } from '../components/UploadProgress';

export function HomeScreen() {
  const navigation = useNavigation();
  const { user, signOut } = useAuth();
  const { balance, refresh: refreshCredits } = useCredits();
  const { state, uploadAndProcess, cancel, reset } = useVOPIUpload();

  const handleVideoSelect = async (video: { uri: string; fileName?: string; mimeType?: string }) => {
    await uploadAndProcess(video);
  };

  const handleViewResults = () => {
    if (state.status === 'completed') {
      navigation.navigate('Results' as never, {
        job: state.job,
        downloadUrls: state.downloadUrls
      } as never);
    }
  };

  const isProcessing = state.status === 'uploading' || state.status === 'processing';

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hello, {user?.name || 'User'}</Text>
          <Text style={styles.credits}>{balance} credits</Text>
        </View>
        <TouchableOpacity onPress={signOut}>
          <Text style={styles.signOut}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      {/* Main Content */}
      <View style={styles.content}>
        <Text style={styles.title}>Process Video</Text>
        <Text style={styles.description}>
          Select a product video to extract frames and generate commercial images.
        </Text>

        <VideoPicker onSelect={handleVideoSelect} disabled={isProcessing} />

        <UploadProgress state={state} onCancel={cancel} />

        {state.status === 'completed' && (
          <View style={styles.completedActions}>
            <TouchableOpacity style={styles.primaryButton} onPress={handleViewResults}>
              <Text style={styles.primaryButtonText}>View Results</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                reset();
                refreshCredits();
              }}
            >
              <Text style={styles.secondaryButtonText}>Process Another Video</Text>
            </TouchableOpacity>
          </View>
        )}

        {(state.status === 'error' || state.status === 'cancelled') && (
          <TouchableOpacity style={styles.secondaryButton} onPress={reset}>
            <Text style={styles.secondaryButtonText}>Try Again</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  greeting: {
    fontSize: 18,
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
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
  },
  description: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 32,
  },
  completedActions: {
    marginTop: 24,
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#34C759',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#333',
    fontSize: 16,
    fontWeight: '500',
  },
});
```

---

## Troubleshooting

### OAuth Redirect Not Working

1. **Check scheme in app.json** matches `VOPIConfig.scheme`
2. **iOS**: Rebuild the app after changing scheme
3. **Android**: Clear app data and rebuild

### "Invalid state" Error

This usually means the OAuth state expired or was lost. Ensure:
1. SecureStore is working correctly
2. User completes OAuth within 10 minutes
3. App wasn't force-closed during OAuth

### Token Refresh Failing

1. Check network connectivity
2. Verify refresh token is stored correctly
3. User may need to sign in again if refresh token expired (30 days)

### Upload Failing

1. Check file size (max 500 MB recommended)
2. Verify video format (MP4, MOV, WebM)
3. Ensure sufficient credits for processing

---

## Additional Resources

- [VOPI API Documentation](../api.md)
- [API Changelog](./api-changelog/)
- [Expo Documentation](https://docs.expo.dev/)
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)
- [Expo ImagePicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/)

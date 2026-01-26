# Mobile Front-End Integration Guide

This guide covers integrating VOPI (Video Object Processing Infrastructure) into mobile applications. VOPI extracts high-quality product photography frames from videos and generates commercial images.

> **Important: Check API Changelog**
>
> Before integrating or upgrading, review the [API Changelog](./api-changelog/) for breaking changes and migration guides.

## Production API

| Environment | Base URL |
|-------------|----------|
| **Production** | `https://api.vopi.24rabbit.com` |
| Development | `http://localhost:3000` |

## Authentication

VOPI uses **OAuth 2.0** with JWT tokens for user authentication. Users sign in via Google or Apple.

### Authentication Methods

| Method | Use Case | Header |
|--------|----------|--------|
| **JWT Token** (recommended) | Mobile/Web apps with user accounts | `Authorization: Bearer <access_token>` |
| API Key | Server-to-server integrations | `x-api-key: <api_key>` |

### OAuth Flow Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Mobile App    │     │   VOPI API      │     │  OAuth Provider │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │  1. POST /auth/oauth/init                     │
         │──────────────────────>│                       │
         │                       │                       │
         │  { authorizationUrl, state, codeVerifier }    │
         │<──────────────────────│                       │
         │                       │                       │
         │  2. Open browser/WebView to authorizationUrl  │
         │─────────────────────────────────────────────>│
         │                       │                       │
         │  3. User signs in, redirects back with code   │
         │<─────────────────────────────────────────────│
         │                       │                       │
         │  4. POST /auth/oauth/callback                 │
         │──────────────────────>│                       │
         │                       │                       │
         │  { accessToken, refreshToken, user }          │
         │<──────────────────────│                       │
```

### Token Lifecycle

| Token | Expiration | Storage |
|-------|------------|---------|
| Access Token | 1 hour | Memory or secure storage |
| Refresh Token | 30 days | Secure storage (Keychain/Keystore) |

### New User Benefits

- **5 free credits** on first sign-up (one-time, abuse-protected)
- Credits are used for video processing jobs

---

## Quick Start

### Complete Integration Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Mobile App    │     │   VOPI API      │     │   S3 Storage    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │  1. OAuth login (Google/Apple)                │
         │──────────────────────>│                       │
         │                       │                       │
         │  { accessToken, refreshToken, user }          │
         │<──────────────────────│                       │
         │                       │                       │
         │  2. Check credit balance                      │
         │──────────────────────>│                       │
         │                       │                       │
         │  { balance: 5 }       │                       │
         │<──────────────────────│                       │
         │                       │                       │
         │  3. Get presigned upload URL                  │
         │──────────────────────>│                       │
         │                       │                       │
         │  { uploadUrl, publicUrl }                     │
         │<──────────────────────│                       │
         │                       │                       │
         │  4. Upload video directly to S3               │
         │─────────────────────────────────────────────>│
         │                       │                       │
         │  5. Create job with publicUrl                 │
         │──────────────────────>│                       │
         │                       │                       │
         │  { jobId, status: pending }                   │
         │<──────────────────────│                       │
         │                       │                       │
         │  6. Poll status OR receive webhook            │
         │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│                       │
         │                       │                       │
         │  7. Get download URLs (presigned)             │
         │──────────────────────>│                       │
         │                       │                       │
         │  { frames, commercialImages }                 │
         │<──────────────────────│                       │
         │                       │                       │
         │  8. Download images using presigned URLs      │
         │─────────────────────────────────────────────>│
```

> **Note:** The S3 bucket is private. Direct URLs in job results are not accessible. Use the `/jobs/:id/download-urls` endpoint to get time-limited presigned URLs.

---

## Auth Endpoints

### Check Available Providers

**Endpoint:** `GET /api/v1/auth/providers`

**Response:**
```json
{
  "google": true,
  "apple": true
}
```

### Initialize OAuth

**Endpoint:** `POST /api/v1/auth/oauth/init`

**Request:**
```json
{
  "provider": "google",
  "redirectUri": "com.yourapp://oauth/callback"
}
```

**Response:**
```json
{
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "state": "abc123...",
  "codeVerifier": "xyz789..."
}
```

> **Important:** Store `state` and `codeVerifier` securely - you need them for the callback.

### Exchange Code for Tokens

**Endpoint:** `POST /api/v1/auth/oauth/callback`

**Request:**
```json
{
  "provider": "google",
  "code": "authorization_code_from_redirect",
  "redirectUri": "com.yourapp://oauth/callback",
  "state": "abc123...",
  "codeVerifier": "xyz789...",
  "deviceInfo": {
    "deviceId": "unique-device-id",
    "deviceName": "iPhone 15 Pro"
  }
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2g...",
  "expiresIn": 3600,
  "tokenType": "Bearer",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "name": "John Doe",
    "avatarUrl": "https://...",
    "creditsBalance": 5
  }
}
```

### Refresh Access Token

**Endpoint:** `POST /api/v1/auth/refresh`

**Request:**
```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2g..."
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "bmV3IHJlZnJlc2ggdG9rZW4...",
  "expiresIn": 3600,
  "tokenType": "Bearer"
}
```

> **Note:** A new refresh token is returned. Store it and discard the old one.

### Get User Profile

**Endpoint:** `GET /api/v1/auth/me`

**Headers:** `Authorization: Bearer <access_token>`

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "emailVerified": true,
  "name": "John Doe",
  "avatarUrl": "https://...",
  "createdAt": "2025-01-23T10:00:00.000Z",
  "lastLoginAt": "2025-01-24T15:30:00.000Z"
}
```

### Logout

**Endpoint:** `POST /api/v1/auth/logout`

**Request:**
```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2g...",
  "allDevices": false
}
```

---

## Credits System

Users have a credit balance for processing jobs. New users receive 5 free credits.

### Get Credit Balance

**Endpoint:** `GET /api/v1/credits/balance`

**Headers:** `Authorization: Bearer <access_token>`

**Response:**
```json
{
  "balance": 25,
  "transactions": [
    {
      "id": "...",
      "creditsDelta": 5,
      "type": "signup_grant",
      "description": "Welcome bonus: 5 free credits",
      "createdAt": "2025-01-23T10:00:00.000Z"
    }
  ]
}
```

### Get Credit Packs (No Auth)

**Endpoint:** `GET /api/v1/credits/packs`

**Response:**
```json
{
  "packs": [
    { "packType": "CREDIT_1", "credits": 1, "priceUsd": 0.99, "name": "Single Credit" },
    { "packType": "PACK_20", "credits": 20, "priceUsd": 14.99, "name": "20 Credit Pack" },
    { "packType": "PACK_100", "credits": 100, "priceUsd": 59, "name": "100 Credit Pack" },
    { "packType": "PACK_500", "credits": 500, "priceUsd": 199, "name": "500 Credit Pack" }
  ],
  "stripeConfigured": true
}
```

### Estimate Job Cost

**Endpoint:** `POST /api/v1/credits/estimate`

**Request:**
```json
{
  "videoDurationSeconds": 30,
  "frameCount": 8
}
```

**Response:**
```json
{
  "totalCredits": 3,
  "breakdown": [
    { "type": "base", "description": "Base job cost", "credits": 1 },
    { "type": "duration", "description": "30 seconds of video", "credits": 1.5 }
  ],
  "canAfford": true,
  "currentBalance": 25
}
```

### Purchase Credits (Stripe Checkout)

**Endpoint:** `POST /api/v1/credits/checkout`

**Request:**
```json
{
  "packType": "PACK_20",
  "successUrl": "com.yourapp://purchase/success",
  "cancelUrl": "com.yourapp://purchase/cancel"
}
```

**Response:**
```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx...",
  "sessionId": "cs_xxx..."
}
```

Open `checkoutUrl` in a browser/WebView for payment.

---

## Core Job Endpoints

All job endpoints require authentication.

### 1. Get Presigned Upload URL

**Endpoint:** `POST /api/v1/uploads/presign`

**Request:**
```json
{
  "filename": "product-video.mp4",
  "contentType": "video/mp4",
  "expiresIn": 3600
}
```

**Response:**
```json
{
  "uploadUrl": "https://s3.amazonaws.com/bucket/uploads/uuid.mp4?X-Amz-...",
  "key": "uploads/uuid.mp4",
  "publicUrl": "https://s3.amazonaws.com/bucket/uploads/uuid.mp4",
  "expiresIn": 3600
}
```

### 2. Upload Video to S3

Upload directly to S3 using the presigned URL with a `PUT` request.

**Headers:**
```
Content-Type: video/mp4
```

### 3. Create Processing Job

**Endpoint:** `POST /api/v1/jobs`

**Request:**
```json
{
  "videoUrl": "https://s3.amazonaws.com/bucket/uploads/uuid.mp4",
  "config": {
    "stackId": "unified_video_analyzer"
  },
  "callbackUrl": "https://your-server.com/webhook"
}
```

**Available Pipeline Templates (`stackId`):**

| stackId | Description |
|---------|-------------|
| `classic` | Extract frames, score, classify, Stability commercial images |
| `gemini_video` | Gemini video analysis, Stability commercial images |
| `unified_video_analyzer` | Single Gemini call for audio+video, Stability images (recommended) |
| `full_gemini` | Gemini for everything including image generation (no external APIs) |
| `minimal` | Extract and upload frames only, no commercial images |

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "videoUrl": "...",
  "config": {...},
  "createdAt": "2025-01-19T10:00:00.000Z"
}
```

### 4. Poll Job Status

**Endpoint:** `GET /api/v1/jobs/:id/status`

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "classifying",
  "progress": {
    "step": "classifying",
    "percentage": 55,
    "message": "Processing batch 2/4",
    "totalSteps": 7,
    "currentStep": 4
  }
}
```

### 5. Get Download URLs (Required)

**Endpoint:** `GET /api/v1/jobs/:id/download-urls`

Get presigned URLs for accessing job assets. Required because S3 bucket is private.

**Query Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `expiresIn` | 3600 | URL expiration in seconds (60-86400) |

**Response:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 3600,
  "frames": [
    {
      "frameId": "frame_00123",
      "downloadUrl": "https://s3.../...?X-Amz-..."
    }
  ],
  "commercialImages": {
    "product_1_variant_hero": {
      "transparent": "https://s3.../...?X-Amz-...",
      "solid": "https://s3.../...?X-Amz-...",
      "real": "https://s3.../...?X-Amz-...",
      "creative": "https://s3.../...?X-Amz-..."
    }
  },
  "productMetadata": {
    "transcript": "This is a beautiful handmade ceramic vase...",
    "product": {...},
    "platforms": {...}
  }
}
```

### 6. Get Product Metadata

**Endpoint:** `GET /api/v1/jobs/:id/metadata`

Get AI-extracted product information for user review.

**Response:**
```json
{
  "transcript": "This is a beautiful handmade ceramic vase...",
  "product": {
    "title": "Handmade Ceramic Vase",
    "description": "Beautiful handcrafted ceramic vase...",
    "bulletPoints": ["Handcrafted", "Food-safe glaze"],
    "confidence": { "overall": 85, "title": 90, "description": 80 }
  },
  "platforms": {
    "shopify": { "title": "...", "descriptionHtml": "..." },
    "amazon": { "item_name": "...", "bullet_point": [...] },
    "ebay": { "title": "...", "aspects": {...} }
  }
}
```

### 7. Update Product Metadata

**Endpoint:** `PATCH /api/v1/jobs/:id/metadata`

Update metadata with user edits before e-commerce upload.

**Request:**
```json
{
  "title": "User Edited Title",
  "description": "User edited description...",
  "bulletPoints": ["Updated feature 1", "Updated feature 2"],
  "price": 29.99
}
```

**Response:** Returns full updated `productMetadata` with regenerated platform formats.

---

## Job Status Values

| Status | Description |
|--------|-------------|
| `pending` | Job created, waiting to be processed |
| `downloading` | Downloading video from source |
| `extracting` | Extracting frames from video |
| `scoring` | Calculating frame quality scores |
| `classifying` | AI classification of frames |
| `extracting_product` | Extracting and centering product |
| `generating` | Generating commercial images |
| `completed` | Job finished successfully |
| `failed` | Job failed with error |
| `cancelled` | Job was cancelled |

## Commercial Image Versions

Variants depend on the pipeline used:

### Stability Pipelines (`classic`, `gemini_video`, `unified_video_analyzer`)

| Version | Description |
|---------|-------------|
| `transparent` | PNG with transparent background |
| `solid` | AI-recommended solid color background |
| `real` | Realistic lifestyle setting |
| `creative` | Artistic/promotional style |

### Full Gemini Pipeline (`full_gemini`)

| Version | Description |
|---------|-------------|
| `white-studio` | Clean white background with professional lighting |
| `lifestyle` | Natural lifestyle setting (bathroom, vanity, etc.) |

---

## Error Handling

All errors follow this format:

```json
{
  "error": "ERROR_CODE",
  "message": "Human readable message",
  "statusCode": 400
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing or invalid token |
| 402 | Payment Required - Insufficient credits |
| 403 | Forbidden - Access denied |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

### Authentication Error Codes (401)

When authentication fails, check the `error` field for specific error codes:

#### Access Token Errors

| Error Code | Description | Action |
|------------|-------------|--------|
| `ACCESS_TOKEN_EXPIRED` | Token has expired | Refresh the token |
| `ACCESS_TOKEN_INVALID` | Signature verification failed | Re-authenticate |
| `ACCESS_TOKEN_MALFORMED` | Token is not valid JWT | Re-authenticate |
| `UNAUTHORIZED` | No token provided | Login required |

#### Refresh Token Errors

| Error Code | Description | Action |
|------------|-------------|--------|
| `REFRESH_TOKEN_EXPIRED` | Token has expired | Re-authenticate |
| `REFRESH_TOKEN_REVOKED` | Token was revoked (logout) | Re-authenticate |
| `REFRESH_TOKEN_REUSED` | Security alert: possible token theft | Clear all tokens, re-authenticate |

#### User Errors

| Error Code | Description | Action |
|------------|-------------|--------|
| `USER_NOT_FOUND` | User account deleted | Re-authenticate or contact support |
| `USER_DELETED` | Account was deactivated | Contact support |

#### Handling Auth Errors

```typescript
async function handleAuthError(response: Response) {
  const data = await response.json();

  switch (data.error) {
    case 'ACCESS_TOKEN_EXPIRED':
      // Try refreshing the token
      return await refreshTokenAndRetry(request);

    case 'REFRESH_TOKEN_EXPIRED':
    case 'REFRESH_TOKEN_REVOKED':
    case 'USER_NOT_FOUND':
    case 'USER_DELETED':
      // Need to re-authenticate
      clearAuthTokens();
      navigateToLogin();
      break;

    case 'REFRESH_TOKEN_REUSED':
      // Security alert - possible token theft
      clearAuthTokens();
      showSecurityAlert('Your session may have been compromised. Please sign in again.');
      navigateToLogin();
      break;

    default:
      // Generic auth error
      navigateToLogin();
  }
}
```

---

## Platform-Specific Guides

- [Expo/React Native Integration](./expo-integration.md) - **Recommended for new projects**
- [React Native (bare) Integration](./react-native-integration.md)
- [iOS/Swift Integration](./ios-integration.md)
- [Android/Kotlin Integration](./android-integration.md)
- [Flutter/Dart Integration](./flutter-integration.md)
- [API Changelog](./api-changelog/) - Breaking changes and migration guides

---

## Best Practices

### Authentication

1. **Store tokens securely**: Use Keychain (iOS) / Keystore (Android) / SecureStore (Expo)
2. **Implement token refresh**: Check token expiry before requests, refresh proactively
3. **Handle 401 errors**: Refresh token and retry, or redirect to login
4. **Clear tokens on logout**: Remove all stored tokens on logout

### Video Upload

1. **Validate video before upload**: Check file size, format, and duration on the client
2. **Show upload progress**: Use multipart upload progress callbacks
3. **Handle network interruptions**: Implement retry logic for uploads
4. **Compress if needed**: Consider client-side compression for large videos

### Job Processing

1. **Check credits first**: Use `/credits/estimate` before creating jobs
2. **Use webhooks when possible**: More efficient than polling
3. **Poll at reasonable intervals**: 3-5 seconds is recommended
4. **Implement exponential backoff**: For retries on transient failures
5. **Cache results**: Store completed job results locally

### UX Recommendations

1. **Show progress indicators**: Display current step and percentage
2. **Provide cancel option**: Allow users to cancel pending jobs
3. **Handle background processing**: Support app backgrounding during upload/processing
4. **Display intermediate results**: Show frames as they become available

---

## Rate Limits

Recommended limits to avoid throttling:

- Max concurrent jobs per user: 3
- Max video duration: 5 minutes
- Max video file size: 500 MB
- Min polling interval: 3 seconds

---

## Supported Video Formats

| Format | MIME Type |
|--------|-----------|
| MP4 | `video/mp4` |
| MOV | `video/quicktime` |
| WebM | `video/webm` |

# API Reference

## Base URL

```
http://localhost:3000
```

## Authentication

All `/api/v1/*` endpoints require an API key via the `x-api-key` header.

```bash
curl -H "x-api-key: your-api-key" http://localhost:3000/api/v1/jobs
```

### API Key Sources

API keys can come from two sources (checked in order):

1. **Database** (recommended) - Keys stored in the `api_keys` table with usage tracking
2. **Environment variable** (fallback) - Keys in `API_KEYS` env var (comma-separated, no usage tracking)

### Database API Keys

Database-stored keys support:
- **Usage limits**: Each key has a `max_uses` limit (default: 10)
- **Usage tracking**: Each job creation increments `used_count`
- **Expiration**: Optional `expires_at` timestamp
- **Revocation**: Soft delete via `revoked_at` timestamp

Manage keys via CLI:
```bash
pnpm keys create --name "John's Beta Access" --max-uses 20
pnpm keys list
pnpm keys revoke <key-id>
```

See [CLI Commands](#cli-commands) for full documentation.

## Interactive Documentation

Swagger UI is available at `/docs` when the server is running.

---

## Production API

**Base URL**: `https://api.vopi.24rabbit.com`

---

## Auth Endpoints (User Authentication)

VOPI supports two authentication methods:
1. **JWT Authentication** (for end users) - OAuth login via Google/Apple, returns access + refresh tokens
2. **API Key Authentication** (for server-to-server) - Static keys for backend integrations

### Authentication Header

```bash
# JWT Authentication (user apps)
Authorization: Bearer <access_token>

# API Key Authentication (server integrations)
x-api-key: <api_key>
```

Most endpoints accept either authentication method. User-specific endpoints (credits, profile) require JWT.

### Authentication Error Codes

When authentication fails, the API returns specific error codes for easier debugging:

#### Access Token Errors (401)

| Error Code | Description |
|------------|-------------|
| `ACCESS_TOKEN_EXPIRED` | Token has expired |
| `ACCESS_TOKEN_INVALID` | Signature verification failed |
| `ACCESS_TOKEN_MALFORMED` | Token is not a valid JWT |
| `ACCESS_TOKEN_WRONG_TYPE` | Refresh token was provided instead of access token |
| `USER_NOT_FOUND` | User referenced in token no longer exists |
| `USER_DELETED` | User account has been deleted |
| `UNAUTHORIZED` | No authentication provided |

#### Example Error Response

```json
{
  "error": "ACCESS_TOKEN_EXPIRED",
  "message": "Access token has expired"
}
```

---

### GET /api/v1/auth/providers

Check which OAuth providers are available/configured.

**Authentication**: None required

**Response** `200 OK`
```json
{
  "google": true,
  "apple": true
}
```

---

### POST /api/v1/auth/oauth/init

Initialize OAuth flow and get authorization URL. The client redirects the user to this URL.

**Authentication**: None required

**Request Body**
```json
{
  "provider": "google",
  "redirectUri": "com.yourapp://oauth/callback",
  "state": "optional-csrf-token",
  "codeChallenge": "optional-pkce-challenge",
  "codeChallengeMethod": "S256"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | `google` or `apple` |
| `redirectUri` | string (URL) | Yes | Your app's callback URL (see integration guides) |
| `state` | string | No | CSRF token (generated if not provided) |
| `codeChallenge` | string | No | PKCE code challenge (generated if not provided) |
| `codeChallengeMethod` | string | No | `S256` (recommended) or `plain` |

**Response** `200 OK`
```json
{
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&state=...",
  "state": "abc123...",
  "codeVerifier": "xyz789..."
}
```

**Important**:
- `codeVerifier` is only returned if the server generated PKCE (when you didn't provide `codeChallenge`)
- Store `state` and `codeVerifier` securely - you'll need them for the callback

---

### POST /api/v1/auth/oauth/callback

Exchange OAuth authorization code for access and refresh tokens. Call this after the user completes OAuth.

**Authentication**: None required

**Request Body**
```json
{
  "provider": "google",
  "code": "authorization_code_from_oauth",
  "redirectUri": "com.yourapp://oauth/callback",
  "state": "abc123...",
  "codeVerifier": "xyz789...",
  "deviceInfo": {
    "deviceId": "unique-device-id",
    "deviceName": "iPhone 15 Pro"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | `google` or `apple` |
| `code` | string | Yes | Authorization code from OAuth redirect |
| `redirectUri` | string (URL) | Yes | Must match the one used in init |
| `state` | string | No | The state from init (validated against stored state) |
| `codeVerifier` | string | No | PKCE verifier (from init or your own) |
| `deviceInfo` | object | No | Device identification for token tracking |

**Response** `200 OK`
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
  "expiresIn": 3600,
  "tokenType": "Bearer",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "name": "John Doe",
    "avatarUrl": "https://lh3.googleusercontent.com/...",
    "creditsBalance": 5
  }
}
```

**Notes**:
- `accessToken` expires in 1 hour (3600 seconds)
- `refreshToken` expires in 30 days
- New users automatically receive 5 signup credits (one-time, abuse-protected)

**Error Responses**:

`400 Bad Request` - Invalid state
```json
{
  "error": "INVALID_STATE",
  "message": "Invalid or expired state parameter"
}
```

`400 Bad Request` - Provider mismatch
```json
{
  "error": "PROVIDER_MISMATCH",
  "message": "OAuth provider does not match state"
}
```

---

### POST /api/v1/auth/refresh

Refresh an expired access token using the refresh token.

**Authentication**: None required (refresh token in body)

**Request Body**
```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..."
}
```

**Response** `200 OK`
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "bmV3IHJlZnJlc2ggdG9rZW4...",
  "expiresIn": 3600,
  "tokenType": "Bearer"
}
```

**Note**: A new refresh token is returned. Store it and discard the old one.

**Error Responses** `401 Unauthorized`

The refresh endpoint returns specific error codes for easier debugging:

| Error Code | Description |
|------------|-------------|
| `REFRESH_TOKEN_EXPIRED` | Token has expired (either JWT expiry or database expiry) |
| `REFRESH_TOKEN_INVALID` | Token signature verification failed |
| `REFRESH_TOKEN_REVOKED` | Token was explicitly revoked (user logged out) |
| `REFRESH_TOKEN_REUSED` | Token has already been used (security alert - possible token theft) |
| `REFRESH_TOKEN_WRONG_TYPE` | Access token was provided instead of refresh token |
| `USER_NOT_FOUND` | User referenced in token no longer exists |
| `USER_DELETED` | User account has been deleted |

```json
{
  "error": "REFRESH_TOKEN_EXPIRED",
  "message": "Refresh token has expired"
}
```

```json
{
  "error": "REFRESH_TOKEN_REVOKED",
  "message": "Refresh token has been revoked"
}
```

```json
{
  "error": "REFRESH_TOKEN_REUSED",
  "message": "Refresh token has already been used. If you did not do this, your account may be compromised."
}
```

---

### POST /api/v1/auth/logout

Revoke refresh token(s) to logout.

**Authentication**: Optional (required for `allDevices: true`)

**Request Body**
```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
  "allDevices": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `refreshToken` | string | No* | Specific token to revoke |
| `allDevices` | boolean | No | Revoke all refresh tokens for user (requires auth) |

*Either `refreshToken` or `allDevices: true` must be provided.

**Response** `200 OK`
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

Or for all devices:
```json
{
  "success": true,
  "message": "Logged out from all devices"
}
```

---

### GET /api/v1/auth/me

Get current authenticated user's profile.

**Authentication**: Required (JWT)

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "emailVerified": true,
  "name": "John Doe",
  "avatarUrl": "https://lh3.googleusercontent.com/...",
  "createdAt": "2025-01-23T10:00:00.000Z",
  "lastLoginAt": "2025-01-23T15:30:00.000Z"
}
```

---

## Frontend Integration Guides

### Mobile App Integration (iOS / Android)

#### 1. Configure OAuth Redirect URI

Register a custom URL scheme for your app:

**iOS** (Info.plist):
```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.yourapp</string>
    </array>
  </dict>
</array>
```

**Android** (AndroidManifest.xml):
```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="com.yourapp" android:host="oauth" android:pathPrefix="/callback" />
</intent-filter>
```

#### 2. OAuth Login Flow

```typescript
// Step 1: Initialize OAuth
const initResponse = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/oauth/init', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'google', // or 'apple'
    redirectUri: 'com.yourapp://oauth/callback',
  }),
});

const { authorizationUrl, state, codeVerifier } = await initResponse.json();

// Store state and codeVerifier securely (e.g., Keychain/Keystore)
await SecureStorage.set('oauth_state', state);
await SecureStorage.set('oauth_code_verifier', codeVerifier);

// Step 2: Open OAuth URL in browser/WebView
// iOS: ASWebAuthenticationSession
// Android: Custom Tabs
await openAuthSession(authorizationUrl);

// Step 3: Handle callback (when app receives redirect)
// URL: com.yourapp://oauth/callback?code=xxx&state=yyy
function handleOAuthCallback(url: string) {
  const params = new URLSearchParams(url.split('?')[1]);
  const code = params.get('code');
  const returnedState = params.get('state');

  // Retrieve stored values
  const storedState = await SecureStorage.get('oauth_state');
  const codeVerifier = await SecureStorage.get('oauth_code_verifier');

  // Validate state matches
  if (returnedState !== storedState) {
    throw new Error('State mismatch - possible CSRF attack');
  }

  // Exchange code for tokens
  const tokenResponse = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/oauth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      code,
      redirectUri: 'com.yourapp://oauth/callback',
      state: storedState,
      codeVerifier,
      deviceInfo: {
        deviceId: await getDeviceId(),
        deviceName: await getDeviceName(),
      },
    }),
  });

  const { accessToken, refreshToken, user } = await tokenResponse.json();

  // Store tokens securely
  await SecureStorage.set('access_token', accessToken);
  await SecureStorage.set('refresh_token', refreshToken);

  // Clean up OAuth state
  await SecureStorage.delete('oauth_state');
  await SecureStorage.delete('oauth_code_verifier');

  return user;
}
```

#### 3. Token Refresh (with automatic retry)

```typescript
let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;

async function getValidAccessToken(): Promise<string> {
  const accessToken = await SecureStorage.get('access_token');

  // Check if token is expired (decode JWT and check exp)
  if (!isTokenExpired(accessToken)) {
    return accessToken;
  }

  // Prevent concurrent refresh requests
  if (isRefreshing) {
    return refreshPromise!;
  }

  isRefreshing = true;
  refreshPromise = refreshAccessToken();

  try {
    return await refreshPromise;
  } finally {
    isRefreshing = false;
    refreshPromise = null;
  }
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = await SecureStorage.get('refresh_token');

  const response = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) {
    // Refresh token expired - user needs to login again
    await clearTokens();
    throw new Error('Session expired. Please login again.');
  }

  const { accessToken, refreshToken: newRefreshToken } = await response.json();

  await SecureStorage.set('access_token', accessToken);
  await SecureStorage.set('refresh_token', newRefreshToken);

  return accessToken;
}

// Use in API calls
async function apiRequest(url: string, options: RequestInit = {}) {
  const accessToken = await getValidAccessToken();

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${accessToken}`,
    },
  });
}
```

---

### Web App Integration (React / Next.js)

#### 1. Configure OAuth Redirect URI

Use your web domain with a callback route:
```
https://yourapp.com/auth/callback
```

Register this URL in Google Cloud Console and Apple Developer portal.

#### 2. OAuth Login Flow (React)

```typescript
// components/LoginButton.tsx
export function LoginButton({ provider }: { provider: 'google' | 'apple' }) {
  const handleLogin = async () => {
    // Step 1: Initialize OAuth
    const response = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/oauth/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        redirectUri: `${window.location.origin}/auth/callback`,
      }),
    });

    const { authorizationUrl, state, codeVerifier } = await response.json();

    // Store in sessionStorage (cleared when browser closes)
    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_code_verifier', codeVerifier || '');
    sessionStorage.setItem('oauth_provider', provider);

    // Redirect to OAuth provider
    window.location.href = authorizationUrl;
  };

  return (
    <button onClick={handleLogin}>
      Continue with {provider === 'google' ? 'Google' : 'Apple'}
    </button>
  );
}
```

```typescript
// pages/auth/callback.tsx (or app/auth/callback/page.tsx for App Router)
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function AuthCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    async function handleCallback() {
      const code = searchParams.get('code');
      const returnedState = searchParams.get('state');

      // Retrieve stored values
      const storedState = sessionStorage.getItem('oauth_state');
      const codeVerifier = sessionStorage.getItem('oauth_code_verifier');
      const provider = sessionStorage.getItem('oauth_provider');

      // Validate state
      if (returnedState !== storedState) {
        console.error('State mismatch');
        router.push('/login?error=invalid_state');
        return;
      }

      try {
        // Exchange code for tokens
        const response = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/oauth/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            code,
            redirectUri: `${window.location.origin}/auth/callback`,
            state: storedState,
            codeVerifier: codeVerifier || undefined,
          }),
        });

        if (!response.ok) {
          throw new Error('Token exchange failed');
        }

        const { accessToken, refreshToken, user } = await response.json();

        // Store tokens (use httpOnly cookies in production for security)
        localStorage.setItem('access_token', accessToken);
        localStorage.setItem('refresh_token', refreshToken);

        // Clear OAuth state
        sessionStorage.removeItem('oauth_state');
        sessionStorage.removeItem('oauth_code_verifier');
        sessionStorage.removeItem('oauth_provider');

        // Redirect to app
        router.push('/dashboard');
      } catch (error) {
        console.error('Auth error:', error);
        router.push('/login?error=auth_failed');
      }
    }

    handleCallback();
  }, [searchParams, router]);

  return <div>Completing sign in...</div>;
}
```

#### 3. Auth Context (React)

```typescript
// contexts/AuthContext.tsx
import { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  creditsBalance: number;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (provider: 'google' | 'apple') => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load user on mount
  useEffect(() => {
    async function loadUser() {
      const accessToken = localStorage.getItem('access_token');
      if (!accessToken) {
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/me', {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });

        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
        } else if (response.status === 401) {
          // Try to refresh token
          const newToken = await refreshToken();
          if (newToken) {
            const retryResponse = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/me', {
              headers: { 'Authorization': `Bearer ${newToken}` },
            });
            if (retryResponse.ok) {
              setUser(await retryResponse.json());
            }
          }
        }
      } catch (error) {
        console.error('Failed to load user:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadUser();
  }, []);

  const refreshToken = useCallback(async (): Promise<string | null> => {
    const refreshTokenValue = localStorage.getItem('refresh_token');
    if (!refreshTokenValue) return null;

    try {
      const response = await fetch('https://api.vopi.24rabbit.com/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshTokenValue }),
      });

      if (!response.ok) {
        // Refresh failed - clear tokens
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        setUser(null);
        return null;
      }

      const { accessToken, refreshToken: newRefreshToken } = await response.json();
      localStorage.setItem('access_token', accessToken);
      localStorage.setItem('refresh_token', newRefreshToken);
      return accessToken;
    } catch {
      return null;
    }
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const accessToken = localStorage.getItem('access_token');
    if (!accessToken) return null;

    // Check if expired
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1]));
      if (payload.exp * 1000 < Date.now()) {
        return await refreshToken();
      }
    } catch {
      return await refreshToken();
    }

    return accessToken;
  }, [refreshToken]);

  const logout = useCallback(async () => {
    const refreshTokenValue = localStorage.getItem('refresh_token');

    if (refreshTokenValue) {
      await fetch('https://api.vopi.24rabbit.com/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshTokenValue }),
      });
    }

    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isAuthenticated: !!user,
      login: (provider) => { /* trigger OAuth flow */ },
      logout,
      getAccessToken,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
```

---

### Apple Sign In Notes

1. **Web**: Apple requires HTTPS for redirect URIs
2. **iOS**: Use `AuthenticationServices` framework with `ASAuthorizationAppleIDProvider`
3. **First Login**: Apple only sends user's name on first authorization. Store it!
4. **Private Email**: User may choose to hide email (uses Apple relay address)

```swift
// iOS Native Apple Sign In
import AuthenticationServices

class LoginViewController: UIViewController, ASAuthorizationControllerDelegate {
    func startAppleSignIn() {
        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.fullName, .email]

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    func authorizationController(controller: ASAuthorizationController,
                                  didCompleteWithAuthorization authorization: ASAuthorization) {
        if let credential = authorization.credential as? ASAuthorizationAppleIDCredential {
            let authCode = String(data: credential.authorizationCode!, encoding: .utf8)!
            // Send authCode to /api/v1/auth/oauth/callback with provider: 'apple'
        }
    }
}
```

---

## Health Endpoints

### GET /health

Liveness check - returns immediately if the server is running.

**Response** `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2025-01-19T10:00:00.000Z"
}
```

### GET /ready

Readiness check - verifies database and Redis connections.

**Response** `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2025-01-19T10:00:00.000Z",
  "services": {
    "database": "ok",
    "redis": "ok"
  }
}
```

**Response** `503 Service Unavailable`
```json
{
  "status": "error",
  "services": {
    "database": "error",
    "redis": "ok"
  }
}
```

---

## Jobs Endpoints

### POST /api/v1/jobs

Create a new processing job.

**Request Body**
```json
{
  "videoUrl": "https://example.com/product-video.mp4",
  "config": {
    "fps": 10,
    "batchSize": 30,
    "commercialVersions": ["transparent", "solid", "real", "creative"],
    "aiCleanup": true,
    "geminiModel": "gemini-2.0-flash"
  },
  "callbackUrl": "https://your-server.com/webhook"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `videoUrl` | string (URL) | Yes | - | Video source URL (HTTP, HTTPS, or S3) |
| `config.fps` | number | No | 10 | Frame extraction rate (1-30) |
| `config.batchSize` | number | No | 30 | Frames per Gemini batch (1-100) |
| `config.commercialVersions` | array | No | all four | Which commercial versions to generate |
| `config.aiCleanup` | boolean | No | true | Use AI to remove obstructions |
| `config.geminiModel` | string | No | gemini-2.0-flash | Gemini model for classification |
| `callbackUrl` | string (URL) | No | - | Webhook URL for completion notification |

**Commercial Versions**
- `transparent` - PNG with transparent background
- `solid` - AI-recommended solid color background
- `real` - Realistic lifestyle setting
- `creative` - Artistic/promotional style

**Response** `201 Created`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "videoUrl": "https://example.com/product-video.mp4",
  "config": {
    "fps": 10,
    "batchSize": 30,
    "commercialVersions": ["transparent", "solid", "real", "creative"],
    "aiCleanup": true,
    "geminiModel": "gemini-2.0-flash"
  },
  "createdAt": "2025-01-19T10:00:00.000Z"
}
```

---

### GET /api/v1/jobs

List all jobs with optional filtering.

**Query Parameters**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | Filter by status |
| `limit` | number | 20 | Results per page (1-100) |
| `offset` | number | 0 | Pagination offset |

**Status Values**: `pending`, `downloading`, `extracting`, `scoring`, `classifying`, `extracting_product`, `generating`, `completed`, `failed`, `cancelled`

**Response** `200 OK`
```json
{
  "jobs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "completed",
      "videoUrl": "https://example.com/video.mp4",
      "progress": {
        "step": "completed",
        "percentage": 100,
        "message": "Pipeline completed"
      },
      "createdAt": "2025-01-19T10:00:00.000Z",
      "updatedAt": "2025-01-19T10:05:00.000Z"
    }
  ],
  "total": 1
}
```

---

### GET /api/v1/jobs/:id

Get detailed information about a specific job.

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "videoUrl": "https://example.com/video.mp4",
  "config": {
    "fps": 10,
    "batchSize": 30,
    "commercialVersions": ["transparent", "solid", "real", "creative"],
    "aiCleanup": true,
    "geminiModel": "gemini-2.0-flash"
  },
  "progress": {
    "step": "completed",
    "percentage": 100,
    "message": "Pipeline completed",
    "totalSteps": 6,
    "currentStep": 6
  },
  "result": {
    "variantsDiscovered": 3,
    "framesAnalyzed": 45,
    "finalFrames": [
      "https://s3.amazonaws.com/bucket/jobs/{id}/frames/hero_frame_00123_t4.50.png"
    ],
    "commercialImages": {
      "hero": {
        "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_transparent.png",
        "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_solid.png",
        "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_real.png",
        "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_creative.png"
      }
    }
  },
  "error": null,
  "createdAt": "2025-01-19T10:00:00.000Z",
  "updatedAt": "2025-01-19T10:05:00.000Z",
  "startedAt": "2025-01-19T10:00:01.000Z",
  "completedAt": "2025-01-19T10:05:00.000Z"
}
```

**Response** `404 Not Found`
```json
{
  "error": "Job not found",
  "statusCode": 404
}
```

---

### GET /api/v1/jobs/:id/status

Lightweight endpoint for polling job status.

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "classifying",
  "progress": {
    "step": "classifying",
    "percentage": 55,
    "message": "Processing batch 2/4",
    "totalSteps": 6,
    "currentStep": 4
  },
  "createdAt": "2025-01-19T10:00:00.000Z",
  "updatedAt": "2025-01-19T10:02:30.000Z"
}
```

---

### POST /api/v1/jobs/:id/cancel

Cancel a pending job. Uses atomic update to prevent race conditions.

**Note**: Only jobs with `pending` status can be cancelled. Jobs that have already started processing cannot be cancelled.

**Response** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "cancelled",
  "message": "Job cancelled successfully"
}
```

**Response** `400 Bad Request` (job already processing)
```json
{
  "error": "Job cannot be cancelled - status is not pending",
  "statusCode": 400
}
```

---

### DELETE /api/v1/jobs/:id

Delete a job and all associated data (database records and S3 artifacts). Only jobs in terminal statuses (`completed`, `failed`, `cancelled`) or `pending` can be deleted. Actively processing jobs must be cancelled first.

**Response** `204 No Content`

**Response** `409 Conflict` (job is actively processing)
```json
{
  "error": "CONFLICT",
  "message": "Cannot delete job in 'extracting' status. Cancel the job first or wait for it to finish."
}
```

**Response** `404 Not Found`
```json
{
  "error": "NOT_FOUND",
  "message": "Job {id} not found"
}
```

---

### DELETE /api/v1/jobs/:id/images/:frameId/:version

Delete a specific commercial image variant from a completed job. Removes the image from both S3 and the job result in the database.

**Path Parameters**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string (UUID) | Job ID |
| `frameId` | string | The frame/product key in `commercialImages` (e.g. `hero`, `product_1_variant_hero`) |
| `version` | string | The variant name (e.g. `white-studio`, `lifestyle`, `transparent`, `solid`) |

**Response** `200 OK`
```json
{
  "commercialImages": {
    "hero": {
      "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_solid.png",
      "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_real.png"
    }
  }
}
```

**Response** `400 Bad Request` (job not completed)
```json
{
  "error": "BAD_REQUEST",
  "message": "Can only delete images from completed jobs"
}
```

**Response** `404 Not Found` (variant not found)
```json
{
  "error": "NOT_FOUND",
  "message": "Image variant 'lifestyle' not found for frame 'hero'"
}
```

---

### GET /api/v1/jobs/:id/download-urls

Get presigned download URLs for job assets. Since the S3 bucket is private, this endpoint generates time-limited presigned URLs for secure access to frames and commercial images.

**Query Parameters**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `expiresIn` | number | 3600 | URL expiration in seconds (60-86400) |

**Response** `200 OK`
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 3600,
  "frames": [
    {
      "frameId": "frame_00123",
      "downloadUrl": "https://s3.amazonaws.com/bucket/jobs/{id}/frames/...?X-Amz-..."
    }
  ],
  "commercialImages": {
    "product_1_variant_hero": {
      "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-...",
      "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-...",
      "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-...",
      "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/...?X-Amz-..."
    }
  }
}
```

**Response** `400 Bad Request` (job not complete)
```json
{
  "error": "BAD_REQUEST",
  "message": "Job has no results yet. Wait for job to complete."
}
```

**Usage Notes**:
- Presigned URLs are time-limited and include authentication tokens
- URLs work from any client (browser, mobile app, curl)
- Generate new URLs if they expire before download completes
- URLs are generated in parallel for performance

---

### GET /api/v1/jobs/:id/metadata

Get product metadata extracted from audio analysis. Returns the universal product metadata along with platform-specific formatted versions for Shopify, Amazon, and eBay.

**Response** `200 OK`
```json
{
  "transcript": "This is a premium leather wallet...",
  "product": {
    "title": "Premium Leather Bifold Wallet with RFID Protection",
    "description": "Full product description...",
    "shortDescription": "Slim RFID-blocking leather wallet",
    "bulletPoints": ["Genuine full-grain leather", "RFID protection"],
    "brand": "WalletCo",
    "category": "Accessories",
    "materials": ["leather"],
    "color": "Brown",
    "price": 49.99,
    "currency": "USD",
    "gender": "Men",
    "targetAudience": "adults",
    "ageGroup": "adult",
    "style": "casual",
    "modelNumber": "WC-BF-100",
    "confidence": {
      "overall": 85,
      "title": 90,
      "description": 80
    },
    "extractedFromAudio": true
  },
  "platforms": {
    "shopify": { "title": "...", "descriptionHtml": "...", "metafields": [] },
    "amazon": { "item_name": "...", "department": "Men", "standard_price": {} },
    "ebay": { "title": "...", "aspects": {}, "pricingSummary": {} }
  },
  "extractedAt": "2026-01-28T10:00:00.000Z",
  "audioDuration": 45.5,
  "pipelineVersion": "2.1.0"
}
```

**Response** `404 Not Found`
```json
{
  "error": "NOT_FOUND",
  "message": "Job has no product metadata. Metadata is only available for jobs processed with audio analysis."
}
```

---

### PATCH /api/v1/jobs/:id/metadata

Update product metadata for a job. Users can edit AI-extracted fields before uploading to e-commerce platforms. Returns the updated metadata with re-formatted platform outputs.

**Request Body** (all fields optional, at least one required)

```json
{
  "title": "Updated Product Title",
  "description": "Updated description",
  "shortDescription": "Updated summary",
  "bulletPoints": ["Feature 1", "Feature 2"],
  "brand": "BrandName",
  "category": "Electronics",
  "subcategory": "Accessories",
  "materials": ["cotton", "polyester"],
  "color": "Blue",
  "colors": ["Blue", "Red"],
  "size": "Medium",
  "sizes": ["S", "M", "L"],
  "keywords": ["keyword1", "keyword2"],
  "tags": ["tag1", "tag2"],
  "price": 29.99,
  "currency": "USD",
  "sku": "SKU-123",
  "barcode": "012345678901",
  "condition": "new",
  "careInstructions": ["Machine wash cold"],
  "warnings": ["Keep away from heat"],
  "compareAtPrice": 39.99,
  "costPerItem": 12.50,
  "countryOfOrigin": "USA",
  "manufacturer": "Acme Corp",
  "pattern": "striped",
  "productType": "T-Shirt",
  "gender": "Women",
  "targetAudience": "adults",
  "ageGroup": "adult",
  "style": "casual",
  "modelNumber": "AC-100"
}
```

| Field | Type | Validation |
|-------|------|------------|
| `title` | string | 1-500 chars |
| `description` | string | max 10000 chars |
| `shortDescription` | string | max 500 chars |
| `bulletPoints` | string[] | max 10 items, 500 chars each |
| `brand` | string | max 100 chars |
| `category` | string | max 100 chars |
| `subcategory` | string | max 100 chars |
| `materials` | string[] | max 20 items |
| `color` | string | max 50 chars |
| `colors` | string[] | max 20 items |
| `size` | string | max 50 chars |
| `sizes` | string[] | max 20 items |
| `keywords` | string[] | max 50 items |
| `tags` | string[] | max 50 items |
| `price` | number | >= 0 |
| `currency` | string | exactly 3 chars (ISO 4217) |
| `sku` | string | max 100 chars |
| `barcode` | string | max 50 chars |
| `condition` | string | `new`, `refurbished`, `used`, `open_box` |
| `careInstructions` | string[] | max 10 items |
| `warnings` | string[] | max 10 items |
| `compareAtPrice` | number | >= 0 |
| `costPerItem` | number | >= 0 |
| `countryOfOrigin` | string | max 100 chars |
| `manufacturer` | string | max 200 chars |
| `pattern` | string | max 100 chars |
| `productType` | string | max 100 chars |
| `gender` | string | max 50 chars |
| `targetAudience` | string | max 100 chars |
| `ageGroup` | string | max 50 chars |
| `style` | string | max 100 chars |
| `modelNumber` | string | max 100 chars |

**Response** `200 OK` — Same format as `GET /api/v1/jobs/:id/metadata` with updated values and re-formatted platform outputs.

**Response** `400 Bad Request`
```json
{
  "error": "BAD_REQUEST",
  "message": "No fields to update. Provide at least one field to update."
}
```

**Response** `404 Not Found`
```json
{
  "error": "NOT_FOUND",
  "message": "Job has no product metadata. Metadata is only available for jobs processed with audio analysis."
}
```

---

## Upload Endpoints

### POST /api/v1/uploads/presign

Get a presigned URL for uploading a video directly to S3. This is the recommended way for mobile apps to upload videos.

**Request Body**
```json
{
  "filename": "product-video.mp4",
  "contentType": "video/mp4",
  "expiresIn": 3600
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `filename` | string | No | - | Original filename (max 255 chars, used to detect extension) |
| `contentType` | string | No | video/mp4 | MIME type: `video/mp4`, `video/quicktime`, or `video/webm` |
| `expiresIn` | number | No | 3600 | Presigned URL expiration in seconds (60-86400, i.e., 1 min to 24 hours) |

**Response** `200 OK`
```json
{
  "uploadUrl": "https://s3.amazonaws.com/bucket/uploads/550e8400-e29b-41d4-a716-446655440000.mp4?X-Amz-...",
  "key": "uploads/550e8400-e29b-41d4-a716-446655440000.mp4",
  "publicUrl": "https://s3.amazonaws.com/bucket/uploads/550e8400-e29b-41d4-a716-446655440000.mp4",
  "expiresIn": 3600
}
```

**Usage Flow**:
1. Call this endpoint to get a presigned upload URL
2. Upload the video directly to S3 using a PUT request to `uploadUrl`
3. Create a job using the `publicUrl` as the `videoUrl`
4. After job completion, the uploaded video is automatically deleted from S3

**Example (with curl)**:
```bash
# Step 1: Get presigned URL
UPLOAD_INFO=$(curl -s -X POST http://localhost:3000/api/v1/uploads/presign \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{"filename": "video.mp4"}')

UPLOAD_URL=$(echo $UPLOAD_INFO | jq -r '.uploadUrl')
PUBLIC_URL=$(echo $UPLOAD_INFO | jq -r '.publicUrl')

# Step 2: Upload video to S3
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: video/mp4" \
  --data-binary @video.mp4

# Step 3: Create job with the video URL
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d "{\"videoUrl\": \"$PUBLIC_URL\"}"
```

---

## Results Endpoints

### GET /api/v1/jobs/:id/video

Get video metadata for a completed job.

**Response** `200 OK`
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "sourceUrl": "https://example.com/video.mp4",
  "duration": 30.5,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "codec": "h264",
  "metadata": {
    "duration": 30.5,
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "codec": "h264",
    "filename": "video.mp4"
  },
  "createdAt": "2025-01-19T10:00:00.000Z"
}
```

---

### GET /api/v1/jobs/:id/frames

Get all extracted frames for a job.

**Response** `200 OK`
```json
[
  {
    "id": "770e8400-e29b-41d4-a716-446655440001",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "videoId": "660e8400-e29b-41d4-a716-446655440001",
    "frameId": "frame_00001",
    "timestamp": 0.1,
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/frames/frame_00001.png",
    "scores": {
      "sharpness": 1250.5,
      "motion": 0.02,
      "combined": 1245.4
    },
    "productId": null,
    "variantId": null,
    "angleEstimate": null,
    "isBestPerSecond": true,
    "isFinalSelection": false,
    "createdAt": "2025-01-19T10:00:05.000Z"
  }
]
```

---

### GET /api/v1/jobs/:id/frames/final

Get only the final selected frames (AI-classified variants).

**Response** `200 OK`
```json
[
  {
    "id": "770e8400-e29b-41d4-a716-446655440123",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "frameId": "frame_00123",
    "timestamp": 4.5,
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/frames/hero_frame_00123_t4.50.png",
    "productId": "product_1",
    "variantId": "variant_hero",
    "angleEstimate": "front",
    "variantDescription": "Primary product shot, white color variant",
    "obstructions": {
      "has_obstruction": false,
      "obstruction_types": [],
      "obstruction_description": null,
      "removable_by_ai": false
    },
    "backgroundRecommendations": {
      "solid_color": "#F5F5F5",
      "solid_color_name": "Light Gray",
      "real_life_setting": "Modern minimalist desk setup",
      "creative_shot": "Floating with soft shadows"
    },
    "createdAt": "2025-01-19T10:02:00.000Z"
  }
]
```

---

### GET /api/v1/jobs/:id/images

Get all commercial images for a job.

**Response** `200 OK`
```json
[
  {
    "id": "880e8400-e29b-41d4-a716-446655440001",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "frameId": "770e8400-e29b-41d4-a716-446655440123",
    "version": "transparent",
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_transparent.png",
    "backgroundColor": null,
    "backgroundPrompt": null,
    "success": true,
    "error": null,
    "createdAt": "2025-01-19T10:04:00.000Z"
  },
  {
    "id": "880e8400-e29b-41d4-a716-446655440002",
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "frameId": "770e8400-e29b-41d4-a716-446655440123",
    "version": "solid",
    "s3Url": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_solid.png",
    "backgroundColor": "#F5F5F5",
    "backgroundPrompt": null,
    "success": true,
    "error": null,
    "createdAt": "2025-01-19T10:04:05.000Z"
  }
]
```

---

### GET /api/v1/jobs/:id/images/grouped

Get commercial images grouped by product variant.

**Response** `200 OK`
```json
{
  "hero": {
    "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_transparent.png",
    "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_solid.png",
    "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_real.png",
    "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/hero_creative.png"
  },
  "back_view": {
    "transparent": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_transparent.png",
    "solid": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_solid.png",
    "real": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_real.png",
    "creative": "https://s3.amazonaws.com/bucket/jobs/{id}/commercial/back_creative.png"
  }
}
```

---

## Webhook Callback

When a `callbackUrl` is provided, VOPI will POST to that URL on job completion or failure.

**Callback Payload**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "result": {
    "variantsDiscovered": 3,
    "framesAnalyzed": 45,
    "finalFrames": ["..."],
    "commercialImages": {"..."}
  },
  "completedAt": "2025-01-19T10:05:00.000Z"
}
```

**On Failure**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "error": "Video download failed: 404 Not Found",
  "failedAt": "2025-01-19T10:00:30.000Z"
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message",
  "statusCode": 400,
  "details": {}
}
```

### Common Status Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing or invalid API key |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Action not allowed in current state |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Dependencies down |

---

## Rate Limits

The API does not enforce rate limits directly, but external services (Gemini, Photoroom) have their own limits. Large batch sizes or many concurrent jobs may result in throttling.

---

## Examples

### Create and Poll a Job

```bash
# Create job
JOB_ID=$(curl -s -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key" \
  -d '{"videoUrl": "https://example.com/video.mp4"}' \
  | jq -r '.id')

# Poll status
while true; do
  STATUS=$(curl -s -H "x-api-key: test-api-key" \
    "http://localhost:3000/api/v1/jobs/$JOB_ID/status" \
    | jq -r '.status')
  echo "Status: $STATUS"

  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  sleep 5
done

# Get results
curl -H "x-api-key: test-api-key" \
  "http://localhost:3000/api/v1/jobs/$JOB_ID/images/grouped"
```

### Using Webhook Instead of Polling

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key" \
  -d '{
    "videoUrl": "https://example.com/video.mp4",
    "callbackUrl": "https://your-server.com/vopi-webhook"
  }'
```

---

## Credits Endpoints

Endpoints for managing user credits and Stripe checkout.

### GET /api/v1/credits/balance

Get current credit balance and recent transactions. Requires JWT authentication.

**Query Parameters**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeHistory` | boolean | `true` | Include transaction history |
| `limit` | number | `20` | Number of transactions (1-100) |

**Response** `200 OK`
```json
{
  "balance": 25,
  "transactions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "creditsDelta": 5,
      "type": "signup_grant",
      "description": "Welcome bonus: 5 free credits",
      "createdAt": "2025-01-23T10:00:00.000Z",
      "jobId": null
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "creditsDelta": 20,
      "type": "purchase",
      "description": "Purchased 20 Credit Pack",
      "createdAt": "2025-01-23T11:00:00.000Z",
      "jobId": null
    }
  ]
}
```

---

### GET /api/v1/credits/packs

Get available credit packs with pricing. No authentication required.

**Response** `200 OK`
```json
{
  "packs": [
    {
      "packType": "CREDIT_1",
      "credits": 1,
      "priceUsd": 0.99,
      "name": "Single Credit",
      "available": true
    },
    {
      "packType": "PACK_20",
      "credits": 20,
      "priceUsd": 14.99,
      "name": "20 Credit Pack",
      "available": true
    },
    {
      "packType": "PACK_100",
      "credits": 100,
      "priceUsd": 59,
      "name": "100 Credit Pack",
      "available": true
    },
    {
      "packType": "PACK_500",
      "credits": 500,
      "priceUsd": 199,
      "name": "500 Credit Pack",
      "available": true
    }
  ],
  "stripeConfigured": true
}
```

---

### GET /api/v1/credits/pricing

Get current pricing configuration for job cost calculations.

**Response** `200 OK`
```json
{
  "baseCredits": 1,
  "creditsPerSecond": 0.05,
  "includedFrames": 4,
  "extraFrameCost": 0.25,
  "addOns": [
    {
      "id": "extra_frames",
      "name": "Extra Frames",
      "description": "Extract additional frames beyond the default",
      "cost": 0.25,
      "enabled": true
    },
    {
      "id": "commercial_video",
      "name": "Commercial Video Generation",
      "description": "Generate commercial-quality video from extracted frames",
      "cost": 2,
      "enabled": false
    }
  ],
  "minJobCost": 1,
  "maxJobCost": 0
}
```

---

### POST /api/v1/credits/estimate

Estimate credit cost for a job based on video duration and options.

**Request Body**
```json
{
  "videoDurationSeconds": 30,
  "frameCount": 8,
  "addOns": ["extra_frames"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `videoDurationSeconds` | number | Yes | Video duration in seconds (max 1800) |
| `frameCount` | number | No | Number of frames to extract |
| `addOns` | array | No | Add-on services: `extra_frames`, `commercial_video` |

**Response** `200 OK`
```json
{
  "totalCredits": 3,
  "breakdown": [
    {
      "type": "base",
      "description": "Base job cost",
      "credits": 1
    },
    {
      "type": "duration",
      "description": "30 seconds of video",
      "credits": 1.5,
      "details": { "seconds": 30, "rate": 0.05 }
    },
    {
      "type": "extra_frames",
      "description": "4 extra frames beyond included 4",
      "credits": 1,
      "details": { "extraFrames": 4, "rate": 0.25 }
    }
  ],
  "canAfford": true,
  "currentBalance": 25
}
```

**Note**: `canAfford` and `currentBalance` are only included when the user is authenticated.

---

### POST /api/v1/credits/checkout

Create a Stripe checkout session to purchase credits. Requires JWT authentication.

**Request Body**
```json
{
  "packType": "PACK_20",
  "successUrl": "https://your-app.com/purchase/success",
  "cancelUrl": "https://your-app.com/purchase/cancel"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `packType` | string | Yes | Pack type: `CREDIT_1`, `PACK_20`, `PACK_100`, `PACK_500` |
| `successUrl` | string | Yes | URL to redirect after successful payment |
| `cancelUrl` | string | Yes | URL to redirect if payment is cancelled |

**Response** `200 OK`
```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx...",
  "sessionId": "cs_xxx..."
}
```

**Response** `503 Service Unavailable` (Stripe not configured)
```json
{
  "error": "STRIPE_NOT_CONFIGURED",
  "message": "Payment processing is not available"
}
```

---

### POST /api/v1/credits/webhook

Stripe webhook endpoint for processing payment events. This endpoint is automatically called by Stripe.

**Note**: This endpoint requires a valid Stripe signature header and is excluded from normal authentication.

**Response** `200 OK`
```json
{
  "received": true
}
```

---

### POST /api/v1/credits/spend

Spend credits (idempotent via idempotencyKey). Requires JWT authentication.

**Request Body**
```json
{
  "amount": 3,
  "idempotencyKey": "job-123-spend",
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "description": "Video processing (30s)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount` | number | Yes | Credits to spend (minimum 1) |
| `idempotencyKey` | string | Yes | Unique key to prevent duplicate spends |
| `jobId` | string | No | Associated job ID |
| `description` | string | No | Human-readable description |

**Response** `200 OK`
```json
{
  "success": true,
  "newBalance": 22,
  "transactionId": "770e8400-e29b-41d4-a716-446655440001"
}
```

**Response** `402 Payment Required` (insufficient credits)
```json
{
  "success": false,
  "newBalance": 2,
  "error": "Insufficient credits"
}
```

---

### POST /api/v1/credits/recalculate (Admin Only)

Recalculate a user's cached balance from the ledger. Requires admin API key.

**Request Body**
```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response** `200 OK`
```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "previousBalance": 25,
  "calculatedBalance": 25
}
```

---

## Config Endpoints

Endpoints for managing runtime configuration. Write operations require admin API keys.

### GET /api/v1/config

Get all config values with metadata.

**Response** `200 OK`
```json
[
  {
    "key": "pipeline.strategy",
    "value": "classic",
    "type": "string",
    "category": "pipeline",
    "description": "Pipeline processing strategy",
    "isActive": true,
    "isDefault": true,
    "updatedAt": null
  },
  {
    "key": "pipeline.fps",
    "value": 10,
    "type": "number",
    "category": "pipeline",
    "description": "Frame extraction rate",
    "isActive": true,
    "isDefault": false,
    "updatedAt": "2025-01-21T10:00:00.000Z"
  }
]
```

---

### GET /api/v1/config/effective

Get the effective runtime configuration object.

**Response** `200 OK`
```json
{
  "pipelineStrategy": "classic",
  "fps": 10,
  "batchSize": 30,
  "geminiModel": "gemini-2.0-flash",
  "geminiVideoModel": "gemini-2.0-flash",
  "temperature": 0.2,
  "topP": 0.8,
  "motionAlpha": 0.3,
  "minTemporalGap": 1.0,
  "topKPercent": 0.3,
  "commercialVersions": ["transparent", "solid", "real", "creative"],
  "aiCleanup": true,
  "geminiVideoFps": 1,
  "geminiVideoMaxFrames": 10,
  "debugEnabled": false
}
```

---

### GET /api/v1/config/:key

Get a single config value.

**Response** `200 OK`
```json
{
  "key": "pipeline.fps",
  "value": 10
}
```

**Response** `404 Not Found`
```json
{
  "error": "Config key not found"
}
```

---

### PUT /api/v1/config (Admin Only)

Set a single config value.

**Request Body**
```json
{
  "key": "pipeline.fps",
  "value": 15,
  "type": "number",
  "category": "pipeline",
  "description": "Frame extraction rate"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | Config key |
| `value` | any | Yes | Config value |
| `type` | string | No | Value type (string/number/boolean/json) |
| `category` | string | No | Category for grouping |
| `description` | string | No | Human-readable description |
| `isActive` | boolean | No | Whether config is active (default: true) |

**Response** `200 OK`
```json
{
  "success": true,
  "key": "pipeline.fps"
}
```

**Response** `403 Forbidden`
```json
{
  "error": "FORBIDDEN",
  "message": "Admin access required for this operation"
}
```

---

### PUT /api/v1/config/batch (Admin Only)

Set multiple config values in a transaction.

**Request Body**
```json
[
  { "key": "pipeline.fps", "value": 15 },
  { "key": "ai.temperature", "value": 0.3 }
]
```

**Response** `200 OK`
```json
{
  "success": true,
  "count": 2
}
```

---

### DELETE /api/v1/config/:key (Admin Only)

Delete a config value (resets to default).

**Response** `200 OK`
```json
{
  "success": true,
  "deleted": true
}
```

---

### POST /api/v1/config/seed (Admin Only)

Initialize database with default config values.

**Response** `200 OK`
```json
{
  "success": true,
  "seeded": 14
}
```

---

### POST /api/v1/config/invalidate-cache (Admin Only)

Force cache invalidation.

**Response** `200 OK`
```json
{
  "success": true
}
```

---

## Admin Authentication

Admin endpoints require an admin API key set via the `ADMIN_API_KEYS` environment variable.

```bash
# Set admin keys (comma-separated)
export ADMIN_API_KEYS=admin-key-1,admin-key-2

# Use admin key for config operations
curl -X PUT http://localhost:3000/api/v1/config \
  -H "Content-Type: application/json" \
  -H "x-api-key: admin-key-1" \
  -d '{"key": "pipeline.strategy", "value": "gemini_video"}'
```

---

## Listings Endpoints

Endpoints for pushing product listings to e-commerce platforms with automatic image uploads.

### POST /api/v1/listings/push

Push a processed job's product and images to an e-commerce platform.

**Authentication**: Required (JWT)

**Request Body**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "connectionId": "660e8400-e29b-41d4-a716-446655440001",
  "options": {
    "publishAsDraft": true,
    "skipImages": false,
    "overrideMetadata": {}
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jobId` | string (UUID) | Yes | Job ID with completed processing and images |
| `connectionId` | string (UUID) | Yes | Platform connection ID (must belong to user) |
| `options.publishAsDraft` | boolean | No | Create product as draft (default: true) |
| `options.skipImages` | boolean | No | Skip image upload, product metadata only (default: false) |
| `options.overrideMetadata` | object | No | Override specific metadata fields |

**Response** `201 Created`
```json
{
  "id": "770e8400-e29b-41d4-a716-446655440002",
  "status": "completed",
  "platformProductId": "gid://shopify/Product/123456789",
  "message": "Product pushed successfully"
}
```

**Process Flow** (Shopify example):
1. Create product via `productSet` GraphQL mutation with metadata (title, description, price, SKU, metafields, etc.)
2. Select images for upload (prioritizes commercial images over raw frames):
   - **Commercial images** (preferred): AI-processed product photos from `final/` S3 prefix with backgrounds removed, styled backgrounds, and lifestyle shots
   - **Raw frames** (fallback): Original extracted video frames used only if no commercial images exist
   - Selects up to 10 images from the chosen source
3. Generate presigned URLs for private S3 bucket access (1 hour expiry)
4. Upload images via Shopify's staged upload flow:
   - Call `stagedUploadsCreate` to reserve upload slots
   - Download each image from presigned URL (server-side)
   - Upload to Shopify staging target (parallel for performance)
   - Attach via `productCreateMedia` mutation
5. Update listing record with product ID and status

**Image Selection Priority**:
- **Commercial images** are preferred because they are AI-processed with:
  - Background removal and replacement
  - Lighting adjustments
  - Lifestyle scene generation
  - Consistent product framing and centering
- Falls back to raw video frames only if commercial images are unavailable

**Image Upload Flow (Shopify Staged Uploads)**:
```
┌──────────────────────────────────────┐
│  S3 Private Bucket                   │
│  (S3 URLs via presigned access)      │
└──────────────────┬───────────────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ Server: Generate     │
        │ Presigned URLs       │
        │ (1 hour expiry)      │
        └──────────┬───────────┘
                   │
        ┌──────────▼───────────┐
        │ Shopify:             │
        │ stagedUploadsCreate  │
        │ (get upload targets) │
        └──────────┬───────────┘
                   │
        ┌──────────▼──────────────────────┐
        │ Server (Parallel):              │
        │ 1. Download from presigned URL  │
        │ 2. Build multipart form data    │
        │ 3. POST to upload target        │
        └──────────┬───────────────────────┘
                   │
        ┌──────────▼───────────┐
        │ Shopify:             │
        │ productCreateMedia   │
        │ (attach images)      │
        └──────────────────────┘
```

**Error Responses**:

`404 Not Found` - Connection not found or doesn't belong to user
```json
{
  "error": "NOT_FOUND",
  "message": "Connection not found"
}
```

`400 Bad Request` - Connection not active
```json
{
  "error": "CONNECTION_INACTIVE",
  "message": "Connection is disconnected"
}
```

---

## Platform OAuth Endpoints

Platform OAuth endpoints connect e-commerce platforms (Shopify, Amazon, eBay) to a user's account.

### GET /api/v1/platforms/available

Check which OAuth platforms are configured and available.

**Authentication**: Required (JWT)

**Response** `200 OK`
```json
{
  "platforms": [
    { "platform": "shopify", "configured": true, "name": "Shopify" },
    { "platform": "amazon", "configured": false, "name": "Amazon" },
    { "platform": "ebay", "configured": true, "name": "eBay" }
  ]
}
```

---

### GET /api/v1/oauth/shopify/authorize

Start Shopify OAuth flow. Redirects to Shopify authorization page (or returns JSON with `response_type=json`).

**Authentication**: Required (JWT)

**Query Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `shop` | string | Yes | Shopify store domain (e.g., `mystore.myshopify.com`) |
| `redirectUri` | string (URL) | No | Custom callback URI (defaults to server callback) |
| `response_type` | string | No | Set to `json` for JSON response instead of 302 redirect |
| `successRedirect` | string | No | URL to redirect after success (e.g., mobile deep link) |

**Response** `302 Found` (default) - Redirects to Shopify OAuth

**Response** `200 OK` (when `response_type=json`)
```json
{
  "authUrl": "https://mystore.myshopify.com/admin/oauth/authorize?..."
}
```

---

### GET /api/v1/oauth/shopify/callback

Shopify OAuth callback. Exchanges authorization code for access token and stores the connection. Redirects to the OAuth success page.

**Authentication**: None (callback from Shopify)

---

### GET /api/v1/oauth/amazon/authorize

Start Amazon OAuth flow. Redirects to Amazon authorization page.

**Authentication**: Required (JWT)

---

### GET /api/v1/oauth/amazon/callback

Amazon OAuth callback. Exchanges code for tokens and stores the connection.

**Authentication**: None (callback from Amazon)

---

### GET /api/v1/oauth/ebay/authorize

Start eBay OAuth flow. Redirects to eBay authorization page.

**Authentication**: Required (JWT)

---

### GET /api/v1/oauth/ebay/callback

eBay OAuth callback. Exchanges code for tokens and stores the connection.

**Authentication**: None (callback from eBay)

---

### GET /api/v1/oauth/success

Simple HTML success page shown after OAuth callback redirect. Displays a confirmation message with the connected platform name.

**Authentication**: None required (this is the redirect target after platform OAuth completes)

**Query Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | No | Platform name (`shopify`, `amazon`, `ebay`) - uses whitelist lookup to prevent XSS |

**Response** `200 OK` - HTML page with success message

---

### GET /api/v1/connections

List user's platform connections.

**Authentication**: Required (JWT)

**Response** `200 OK`
```json
{
  "connections": [
    {
      "id": "550e8400-...",
      "platform": "shopify",
      "platformAccountId": "shop-id",
      "status": "active",
      "metadata": { "shop": "mystore.myshopify.com", "shopName": "My Store" },
      "lastError": null,
      "lastUsedAt": "2026-01-28T10:00:00.000Z",
      "createdAt": "2026-01-28T09:00:00.000Z"
    }
  ]
}
```

---

### GET /api/v1/connections/:id

Get connection details.

**Authentication**: Required (JWT)

---

### DELETE /api/v1/connections/:id

Disconnect a platform.

**Authentication**: Required (JWT)

**Response** `200 OK`
```json
{
  "success": true,
  "message": "Connection deleted"
}
```

---

### POST /api/v1/connections/:id/test

Test a platform connection by verifying the stored access token.

**Authentication**: Required (JWT)

**Response** `200 OK`
```json
{
  "success": true,
  "message": "Connection is valid"
}
```

---

## CLI Commands

VOPI includes CLI commands for managing API keys.

### API Key Management

```bash
# Create a new API key
pnpm keys create --name "John's Beta Access" --max-uses 20

# Create with expiration
pnpm keys create --name "Trial Access" --max-uses 5 --expires "2025-06-30"

# Create with quiet mode (outputs only the key, useful for scripting)
pnpm keys create --name "Script Key" --quiet

# Use in scripts
API_KEY=$(pnpm keys create --name "Auto Key" --quiet)

# List active API keys
pnpm keys list

# List all keys (including revoked/expired)
pnpm keys list --all

# Get details about a specific key
pnpm keys info <key-id>

# Revoke an API key
pnpm keys revoke <key-id>

# Show help
pnpm keys help
```

### Output Examples

**Creating a key:**
```
✓ API Key Created

Key Details:
  ID:        550e8400-e29b-41d4-a716-446655440000
  Key:       dG9wX3NlY3JldF9rZXlfaGVyZQ...
  Name:      John's Beta Access
  Max Uses:  20
  Expires:   Never
  Created:   2025-01-19T10:00:00.000Z

⚠️  Save this key securely - it cannot be retrieved later!
```

**Listing keys:**
```
API Keys (3 total):

ID                                    Name                     Usage       Status      Created
----------------------------------------------------------------------------------------------------
550e8400-e29b-41d4-a716-446655440000  John's Beta Access       5/20        Active      2025-01-19
660e8400-e29b-41d4-a716-446655440001  Trial User               3/5         Active      2025-01-18
770e8400-e29b-41d4-a716-446655440002  Old Key                  10/10       Revoked     2025-01-10
```

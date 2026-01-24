# API Update: Credit System & OAuth Authentication

**Date:** 2026-01-23
**Version:** 2.0.0
**Breaking Change:** No (additive changes only)

## Summary

VOPI now supports **user authentication via OAuth** (Google Sign-In) and a **credit-based billing system**. Users receive 5 free credits on signup and can purchase more via Stripe Checkout. Jobs created by authenticated users are charged credits based on video duration.

---

## What's New

### 1. User Authentication (OAuth)

Users can now sign in with Google. The backend issues JWT tokens for authenticated requests.

### 2. Credit System

- **5 free credits** on first signup
- **Dynamic pricing** based on video duration
- **Stripe Checkout** for purchasing credit packs
- **Idempotent transactions** prevent double-charging

### 3. Dual Auth Support

The API supports both authentication methods:
- **API Key** (`x-api-key` header) - For server-to-server integration, no credit deduction
- **JWT** (`Authorization: Bearer` header) - For user apps, credits are charged

---

## New Endpoints

### Authentication

#### POST /api/v1/auth/google

Exchange Google ID token for VOPI JWT tokens.

**Request:**
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIs...",
  "deviceId": "optional-device-identifier"
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 900,
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

#### POST /api/v1/auth/refresh

Refresh an expired access token.

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 900
}
```

#### POST /api/v1/auth/logout

Revoke the current refresh token.

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

---

### Credits

#### GET /api/v1/credits/balance

Get current credit balance and transaction history. **Requires JWT auth.**

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeHistory` | boolean | `true` | Include transaction history |
| `limit` | number | `20` | Number of transactions (1-100) |

**Response:**
```json
{
  "balance": 25,
  "transactions": [
    {
      "id": "txn-001",
      "creditsDelta": 5,
      "type": "signup_grant",
      "description": "Welcome bonus: 5 free credits",
      "createdAt": "2026-01-23T10:00:00.000Z",
      "jobId": null
    },
    {
      "id": "txn-002",
      "creditsDelta": 20,
      "type": "purchase",
      "description": "Purchased 20 Credit Pack",
      "createdAt": "2026-01-23T11:00:00.000Z",
      "jobId": null
    },
    {
      "id": "txn-003",
      "creditsDelta": -3,
      "type": "spend",
      "description": "Video processing (45s)",
      "createdAt": "2026-01-23T12:00:00.000Z",
      "jobId": "job-123"
    }
  ]
}
```

#### GET /api/v1/credits/packs

Get available credit packs. **No auth required.**

**Response:**
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

#### POST /api/v1/credits/estimate

Estimate job cost before submission. **Auth optional** (includes `canAfford` if authenticated).

**Request:**
```json
{
  "videoDurationSeconds": 45,
  "frameCount": 8
}
```

**Response:**
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
      "description": "45 seconds of video",
      "credits": 2.25
    }
  ],
  "canAfford": true,
  "currentBalance": 25
}
```

#### POST /api/v1/credits/checkout

Create Stripe checkout session. **Requires JWT auth.**

**Request:**
```json
{
  "packType": "PACK_20",
  "successUrl": "https://your-app.com/purchase/success",
  "cancelUrl": "https://your-app.com/purchase/cancel"
}
```

**Response:**
```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx...",
  "sessionId": "cs_xxx..."
}
```

---

## Credit Pricing

| Component | Rate |
|-----------|------|
| Base cost | 1 credit per job |
| Duration | 0.05 credits per second |
| Minimum | 1 credit |

**Example:** A 60-second video costs `1 + (60 × 0.05) = 4 credits`

---

## Integration Guide

### Step 1: Add Google Sign-In SDK

**iOS:** Add `GoogleSignIn` pod
```ruby
pod 'GoogleSignIn'
```

**Android:** Add to `build.gradle`
```groovy
implementation 'com.google.android.gms:play-services-auth:20.7.0'
```

**React Native:**
```bash
npm install @react-native-google-signin/google-signin
```

**Flutter:**
```yaml
dependencies:
  google_sign_in: ^6.1.0
```

### Step 2: Configure Google Client ID

Use the **Web Application** client ID from Google Cloud Console for all platforms:

```
# Your OAuth 2.0 Client ID
GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
```

### Step 3: Add Auth Models

**iOS (Swift):**
```swift
struct AuthResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
    let user: User
}

struct User: Decodable {
    let id: String
    let email: String
    let name: String?
    let avatarUrl: String?
    let creditsBalance: Int
}

struct CreditBalance: Decodable {
    let balance: Int
    let transactions: [CreditTransaction]?
}

struct CreditTransaction: Decodable {
    let id: String
    let creditsDelta: Int
    let type: String  // signup_grant, purchase, spend, refund
    let description: String?
    let createdAt: String
    let jobId: String?
}

struct CreditPack: Decodable {
    let packType: String
    let credits: Int
    let priceUsd: Double
    let name: String
    let available: Bool
}

struct CheckoutResponse: Decodable {
    let checkoutUrl: String
    let sessionId: String
}

struct CostEstimate: Decodable {
    let totalCredits: Double
    let breakdown: [CostBreakdown]
    let canAfford: Bool?
    let currentBalance: Int?
}

struct CostBreakdown: Decodable {
    let type: String
    let description: String
    let credits: Double
}
```

**Android (Kotlin):**
```kotlin
data class AuthResponse(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int,
    val user: User
)

data class User(
    val id: String,
    val email: String,
    val name: String?,
    val avatarUrl: String?,
    val creditsBalance: Int
)

data class CreditBalance(
    val balance: Int,
    val transactions: List<CreditTransaction>?
)

data class CreditTransaction(
    val id: String,
    val creditsDelta: Int,
    val type: String,
    val description: String?,
    val createdAt: String,
    val jobId: String?
)

data class CreditPack(
    val packType: String,
    val credits: Int,
    val priceUsd: Double,
    val name: String,
    val available: Boolean
)

data class CheckoutResponse(
    val checkoutUrl: String,
    val sessionId: String
)

data class CostEstimate(
    val totalCredits: Double,
    val breakdown: List<CostBreakdown>,
    val canAfford: Boolean?,
    val currentBalance: Int?
)

data class CostBreakdown(
    val type: String,
    val description: String,
    val credits: Double
)
```

**React Native (TypeScript):**
```typescript
export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  creditsBalance: number;
}

export interface CreditBalance {
  balance: number;
  transactions?: CreditTransaction[];
}

export interface CreditTransaction {
  id: string;
  creditsDelta: number;
  type: 'signup_grant' | 'purchase' | 'spend' | 'refund' | 'admin_adjustment';
  description: string | null;
  createdAt: string;
  jobId: string | null;
}

export interface CreditPack {
  packType: 'CREDIT_1' | 'PACK_20' | 'PACK_100' | 'PACK_500';
  credits: number;
  priceUsd: number;
  name: string;
  available: boolean;
}

export interface CheckoutResponse {
  checkoutUrl: string;
  sessionId: string;
}

export interface CostEstimate {
  totalCredits: number;
  breakdown: CostBreakdown[];
  canAfford?: boolean;
  currentBalance?: number;
}

export interface CostBreakdown {
  type: 'base' | 'duration' | 'extra_frames' | 'adjustment';
  description: string;
  credits: number;
}
```

**Flutter (Dart):**
```dart
@freezed
class AuthResponse with _$AuthResponse {
  const factory AuthResponse({
    required String accessToken,
    required String refreshToken,
    required int expiresIn,
    required User user,
  }) = _AuthResponse;

  factory AuthResponse.fromJson(Map<String, dynamic> json) =>
      _$AuthResponseFromJson(json);
}

@freezed
class User with _$User {
  const factory User({
    required String id,
    required String email,
    String? name,
    String? avatarUrl,
    required int creditsBalance,
  }) = _User;

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
}

@freezed
class CreditBalance with _$CreditBalance {
  const factory CreditBalance({
    required int balance,
    List<CreditTransaction>? transactions,
  }) = _CreditBalance;

  factory CreditBalance.fromJson(Map<String, dynamic> json) =>
      _$CreditBalanceFromJson(json);
}

@freezed
class CreditTransaction with _$CreditTransaction {
  const factory CreditTransaction({
    required String id,
    required int creditsDelta,
    required String type,
    String? description,
    required String createdAt,
    String? jobId,
  }) = _CreditTransaction;

  factory CreditTransaction.fromJson(Map<String, dynamic> json) =>
      _$CreditTransactionFromJson(json);
}

@freezed
class CreditPack with _$CreditPack {
  const factory CreditPack({
    required String packType,
    required int credits,
    required double priceUsd,
    required String name,
    required bool available,
  }) = _CreditPack;

  factory CreditPack.fromJson(Map<String, dynamic> json) =>
      _$CreditPackFromJson(json);
}

@freezed
class CheckoutResponse with _$CheckoutResponse {
  const factory CheckoutResponse({
    required String checkoutUrl,
    required String sessionId,
  }) = _CheckoutResponse;

  factory CheckoutResponse.fromJson(Map<String, dynamic> json) =>
      _$CheckoutResponseFromJson(json);
}

@freezed
class CostEstimate with _$CostEstimate {
  const factory CostEstimate({
    required double totalCredits,
    required List<CostBreakdown> breakdown,
    bool? canAfford,
    int? currentBalance,
  }) = _CostEstimate;

  factory CostEstimate.fromJson(Map<String, dynamic> json) =>
      _$CostEstimateFromJson(json);
}

@freezed
class CostBreakdown with _$CostBreakdown {
  const factory CostBreakdown({
    required String type,
    required String description,
    required double credits,
  }) = _CostBreakdown;

  factory CostBreakdown.fromJson(Map<String, dynamic> json) =>
      _$CostBreakdownFromJson(json);
}
```

### Step 4: Implement Auth Flow

**iOS (Swift):**
```swift
import GoogleSignIn

class AuthService {
    private let vopiClient: VOPIClient

    func signInWithGoogle(presenting: UIViewController) async throws -> AuthResponse {
        // 1. Get Google ID token
        let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenting)
        guard let idToken = result.user.idToken?.tokenString else {
            throw AuthError.noIdToken
        }

        // 2. Exchange for VOPI tokens
        let authResponse = try await vopiClient.authenticateWithGoogle(idToken: idToken)

        // 3. Store tokens securely
        try KeychainService.save(authResponse.accessToken, forKey: "accessToken")
        try KeychainService.save(authResponse.refreshToken, forKey: "refreshToken")

        return authResponse
    }

    func refreshTokenIfNeeded() async throws {
        guard let refreshToken = KeychainService.get("refreshToken") else { return }

        let response = try await vopiClient.refreshToken(refreshToken: refreshToken)
        try KeychainService.save(response.accessToken, forKey: "accessToken")
    }
}
```

**Android (Kotlin):**
```kotlin
class AuthService(
    private val vopiClient: VOPIClient,
    private val context: Context
) {
    private val googleSignInClient: GoogleSignInClient by lazy {
        val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(BuildConfig.GOOGLE_CLIENT_ID)
            .requestEmail()
            .build()
        GoogleSignIn.getClient(context, options)
    }

    fun getSignInIntent(): Intent = googleSignInClient.signInIntent

    suspend fun handleSignInResult(data: Intent?): AuthResponse {
        val task = GoogleSignIn.getSignedInAccountFromIntent(data)
        val account = task.getResult(ApiException::class.java)
        val idToken = account.idToken ?: throw AuthException("No ID token")

        val authResponse = vopiClient.authenticateWithGoogle(idToken)

        // Store tokens securely
        TokenStorage.saveAccessToken(authResponse.accessToken)
        TokenStorage.saveRefreshToken(authResponse.refreshToken)

        return authResponse
    }
}
```

**React Native (TypeScript):**
```typescript
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import AsyncStorage from '@react-native-async-storage/async-storage';

class AuthService {
  constructor(private vopiClient: VOPIClient) {
    GoogleSignin.configure({
      webClientId: 'YOUR_WEB_CLIENT_ID', // Use web client ID
    });
  }

  async signInWithGoogle(): Promise<AuthResponse> {
    // 1. Get Google ID token
    await GoogleSignin.hasPlayServices();
    const userInfo = await GoogleSignin.signIn();
    const idToken = userInfo.idToken;

    if (!idToken) {
      throw new Error('No ID token received');
    }

    // 2. Exchange for VOPI tokens
    const authResponse = await this.vopiClient.authenticateWithGoogle(idToken);

    // 3. Store tokens
    await AsyncStorage.setItem('accessToken', authResponse.accessToken);
    await AsyncStorage.setItem('refreshToken', authResponse.refreshToken);

    return authResponse;
  }

  async refreshTokenIfNeeded(): Promise<void> {
    const refreshToken = await AsyncStorage.getItem('refreshToken');
    if (!refreshToken) return;

    const response = await this.vopiClient.refreshToken(refreshToken);
    await AsyncStorage.setItem('accessToken', response.accessToken);
  }
}
```

**Flutter (Dart):**
```dart
import 'package:google_sign_in/google_sign_in.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class AuthService {
  final VOPIClient _vopiClient;
  final _googleSignIn = GoogleSignIn(
    scopes: ['email', 'profile'],
    serverClientId: 'YOUR_WEB_CLIENT_ID', // Use web client ID
  );
  final _storage = const FlutterSecureStorage();

  AuthService(this._vopiClient);

  Future<AuthResponse> signInWithGoogle() async {
    // 1. Get Google ID token
    final account = await _googleSignIn.signIn();
    if (account == null) throw AuthException('Sign in cancelled');

    final auth = await account.authentication;
    final idToken = auth.idToken;
    if (idToken == null) throw AuthException('No ID token');

    // 2. Exchange for VOPI tokens
    final authResponse = await _vopiClient.authenticateWithGoogle(idToken);

    // 3. Store tokens
    await _storage.write(key: 'accessToken', value: authResponse.accessToken);
    await _storage.write(key: 'refreshToken', value: authResponse.refreshToken);

    return authResponse;
  }

  Future<void> refreshTokenIfNeeded() async {
    final refreshToken = await _storage.read(key: 'refreshToken');
    if (refreshToken == null) return;

    final response = await _vopiClient.refreshToken(refreshToken);
    await _storage.write(key: 'accessToken', value: response.accessToken);
  }
}
```

### Step 5: Add API Client Methods

**All Platforms - Add these methods to your VOPI client:**

```typescript
// Authentication
async authenticateWithGoogle(idToken: string, deviceId?: string): Promise<AuthResponse> {
  const { data } = await this.client.post<AuthResponse>('/api/v1/auth/google', {
    idToken,
    deviceId,
  });
  return data;
}

async refreshToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const { data } = await this.client.post('/api/v1/auth/refresh', { refreshToken });
  return data;
}

async logout(refreshToken: string): Promise<void> {
  await this.client.post('/api/v1/auth/logout', { refreshToken });
}

// Credits
async getBalance(includeHistory = true, limit = 20): Promise<CreditBalance> {
  const { data } = await this.client.get<CreditBalance>('/api/v1/credits/balance', {
    params: { includeHistory, limit },
  });
  return data;
}

async getPacks(): Promise<{ packs: CreditPack[]; stripeConfigured: boolean }> {
  const { data } = await this.client.get('/api/v1/credits/packs');
  return data;
}

async estimateCost(videoDurationSeconds: number, frameCount?: number): Promise<CostEstimate> {
  const { data } = await this.client.post<CostEstimate>('/api/v1/credits/estimate', {
    videoDurationSeconds,
    frameCount,
  });
  return data;
}

async createCheckout(
  packType: string,
  successUrl: string,
  cancelUrl: string
): Promise<CheckoutResponse> {
  const { data } = await this.client.post<CheckoutResponse>('/api/v1/credits/checkout', {
    packType,
    successUrl,
    cancelUrl,
  });
  return data;
}
```

### Step 6: Handle Insufficient Credits

When a job fails due to insufficient credits, the error response includes structured data:

**Error Response (402 Payment Required):**
```json
{
  "error": "Insufficient credits. Required: 5, available: 2",
  "creditError": {
    "code": "INSUFFICIENT_CREDITS",
    "creditsRequired": 5,
    "creditsAvailable": 2,
    "breakdown": [
      { "type": "base", "description": "Base job cost", "credits": 1 },
      { "type": "duration", "description": "60 seconds of video", "credits": 3 }
    ],
    "videoDurationSeconds": 60
  }
}
```

**Handle in your app:**
```typescript
try {
  const job = await vopiClient.createJob(videoUrl);
} catch (error) {
  if (error.response?.status === 402) {
    const creditError = error.response.data.creditError;

    // Show purchase prompt
    showPurchaseDialog({
      required: creditError.creditsRequired,
      available: creditError.creditsAvailable,
      breakdown: creditError.breakdown,
    });
  }
}
```

---

## Purchase Flow

### Mobile In-App Browser Flow

```
1. User taps "Buy Credits"
2. App calls POST /api/v1/credits/checkout
3. Open checkoutUrl in system browser or in-app browser
4. User completes Stripe payment
5. Stripe redirects to successUrl
6. App detects redirect, closes browser
7. App refreshes balance via GET /api/v1/credits/balance
```

**React Native Example:**
```typescript
import { Linking } from 'react-native';
import InAppBrowser from 'react-native-inappbrowser-reborn';

async function purchaseCredits(packType: string) {
  const checkout = await vopiClient.createCheckout(
    packType,
    'https://your-app.com/purchase/success', // Or use deep link: yourapp://purchase/success
    'https://your-app.com/purchase/cancel'
  );

  if (await InAppBrowser.isAvailable()) {
    const result = await InAppBrowser.open(checkout.checkoutUrl, {
      dismissButtonStyle: 'cancel',
      preferredBarTintColor: '#000000',
    });

    // Refresh balance after browser closes
    await refreshBalance();
  } else {
    await Linking.openURL(checkout.checkoutUrl);
  }
}
```

---

## Important Notes

1. **Token Expiration:** Access tokens expire in 15 minutes. Implement automatic refresh.

2. **Secure Storage:** Store tokens in Keychain (iOS), EncryptedSharedPreferences (Android), or secure storage libraries.

3. **Offline Support:** Cache the user's balance locally, but always verify before job submission.

4. **Deep Links:** Configure `successUrl` and `cancelUrl` as deep links for better UX on mobile.

5. **Dual Auth:** If your app uses API keys for some operations and JWT for others, ensure you're using the correct auth header for each request.

---

## Questions?

If you encounter issues integrating, please open an issue on GitHub.

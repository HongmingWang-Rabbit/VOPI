import { UnauthorizedError } from './errors.js';

/**
 * Auth error codes for debugging
 * These codes are returned to clients and should be stable (don't rename without migration)
 */
export const AuthErrorCode = {
  // Access token errors
  ACCESS_TOKEN_EXPIRED: 'ACCESS_TOKEN_EXPIRED',
  ACCESS_TOKEN_INVALID: 'ACCESS_TOKEN_INVALID',
  ACCESS_TOKEN_MALFORMED: 'ACCESS_TOKEN_MALFORMED',
  ACCESS_TOKEN_WRONG_TYPE: 'ACCESS_TOKEN_WRONG_TYPE',

  // Refresh token errors
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_REVOKED: 'REFRESH_TOKEN_REVOKED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  REFRESH_TOKEN_WRONG_TYPE: 'REFRESH_TOKEN_WRONG_TYPE',

  // User errors
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DELETED: 'USER_DELETED',

  // OAuth errors
  OAUTH_STATE_INVALID: 'OAUTH_STATE_INVALID',
  OAUTH_STATE_EXPIRED: 'OAUTH_STATE_EXPIRED',
  OAUTH_PROVIDER_MISMATCH: 'OAUTH_PROVIDER_MISMATCH',
  OAUTH_PROVIDER_NOT_CONFIGURED: 'OAUTH_PROVIDER_NOT_CONFIGURED',
  OAUTH_TOKEN_EXCHANGE_FAILED: 'OAUTH_TOKEN_EXCHANGE_FAILED',
  OAUTH_MISSING_ID_TOKEN: 'OAUTH_MISSING_ID_TOKEN',

  // General auth errors
  JWT_SECRET_NOT_CONFIGURED: 'JWT_SECRET_NOT_CONFIGURED',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type AuthErrorCodeType = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/**
 * Base class for authentication errors
 * Extends UnauthorizedError (401) with additional context for debugging
 */
export class AuthError extends UnauthorizedError {
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: AuthErrorCodeType,
    context?: Record<string, unknown>
  ) {
    super(message, code);
    this.context = context;
  }
}

/**
 * Access token has expired
 */
export class AccessTokenExpiredError extends AuthError {
  constructor(expiredAt?: Date) {
    super(
      'Access token has expired',
      AuthErrorCode.ACCESS_TOKEN_EXPIRED,
      expiredAt ? { expiredAt: expiredAt.toISOString() } : undefined
    );
  }
}

/**
 * Access token signature is invalid or token is malformed
 */
export class AccessTokenInvalidError extends AuthError {
  constructor(reason: string) {
    super(
      `Access token is invalid: ${reason}`,
      AuthErrorCode.ACCESS_TOKEN_INVALID,
      { reason }
    );
  }
}

/**
 * Token is malformed (not a valid JWT structure)
 */
export class AccessTokenMalformedError extends AuthError {
  constructor(reason: string) {
    super(
      `Access token is malformed: ${reason}`,
      AuthErrorCode.ACCESS_TOKEN_MALFORMED,
      { reason }
    );
  }
}

/**
 * Token is valid but wrong type (e.g., refresh token used as access token)
 */
export class AccessTokenWrongTypeError extends AuthError {
  constructor(expectedType: string, actualType: string) {
    super(
      `Expected ${expectedType} token, got ${actualType}`,
      AuthErrorCode.ACCESS_TOKEN_WRONG_TYPE,
      { expectedType, actualType }
    );
  }
}

/**
 * Refresh token has expired
 */
export class RefreshTokenExpiredError extends AuthError {
  constructor(expiredAt?: Date) {
    super(
      'Refresh token has expired',
      AuthErrorCode.REFRESH_TOKEN_EXPIRED,
      expiredAt ? { expiredAt: expiredAt.toISOString() } : undefined
    );
  }
}

/**
 * Refresh token signature is invalid
 */
export class RefreshTokenInvalidError extends AuthError {
  constructor(reason: string) {
    super(
      `Refresh token is invalid: ${reason}`,
      AuthErrorCode.REFRESH_TOKEN_INVALID,
      { reason }
    );
  }
}

/**
 * Refresh token has been explicitly revoked (logout)
 */
export class RefreshTokenRevokedError extends AuthError {
  constructor(userId?: string) {
    super(
      'Refresh token has been revoked',
      AuthErrorCode.REFRESH_TOKEN_REVOKED,
      userId ? { userId } : undefined
    );
  }
}

/**
 * Refresh token appears to have been reused (potential token theft)
 * This is a security-sensitive error
 */
export class RefreshTokenReusedError extends AuthError {
  constructor(userId: string) {
    super(
      'Refresh token has already been used. If you did not do this, your account may be compromised.',
      AuthErrorCode.REFRESH_TOKEN_REUSED,
      { userId, securityAlert: true }
    );
  }
}

/**
 * Refresh token is wrong type
 */
export class RefreshTokenWrongTypeError extends AuthError {
  constructor(expectedType: string, actualType: string) {
    super(
      `Expected ${expectedType} token, got ${actualType}`,
      AuthErrorCode.REFRESH_TOKEN_WRONG_TYPE,
      { expectedType, actualType }
    );
  }
}

/**
 * User referenced in token does not exist
 */
export class UserNotFoundError extends AuthError {
  constructor(userId: string) {
    super(
      'User account not found',
      AuthErrorCode.USER_NOT_FOUND,
      { userId }
    );
  }
}

/**
 * User account has been deleted
 */
export class UserDeletedError extends AuthError {
  constructor(userId: string) {
    super(
      'User account has been deleted',
      AuthErrorCode.USER_DELETED,
      { userId }
    );
  }
}

/**
 * JWT secret is not configured
 */
export class JwtSecretNotConfiguredError extends AuthError {
  constructor() {
    super(
      'JWT authentication is not configured',
      AuthErrorCode.JWT_SECRET_NOT_CONFIGURED
    );
  }
}

/**
 * OAuth state is invalid or expired
 */
export class OAuthStateError extends AuthError {
  constructor(reason: 'invalid' | 'expired' | 'provider_mismatch', context?: Record<string, unknown>) {
    const messages = {
      invalid: 'Invalid OAuth state parameter',
      expired: 'OAuth state has expired',
      provider_mismatch: 'OAuth provider does not match state',
    };
    const codes = {
      invalid: AuthErrorCode.OAUTH_STATE_INVALID,
      expired: AuthErrorCode.OAUTH_STATE_EXPIRED,
      provider_mismatch: AuthErrorCode.OAUTH_PROVIDER_MISMATCH,
    };
    super(messages[reason], codes[reason], context);
  }
}

/**
 * Helper to extract error details for logging and response
 */
export function formatAuthError(error: unknown): {
  code: string;
  message: string;
  context?: Record<string, unknown>;
} {
  if (error instanceof AuthError) {
    return {
      code: error.code,
      message: error.message,
      context: error.context,
    };
  }

  if (error instanceof Error) {
    return {
      code: AuthErrorCode.UNAUTHORIZED,
      message: error.message,
    };
  }

  return {
    code: AuthErrorCode.UNAUTHORIZED,
    message: 'Authentication failed',
  };
}

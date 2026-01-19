/**
 * Base application error
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: string, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 400 Bad Request
 */
export class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = 'BAD_REQUEST') {
    super(message, 400, code);
  }
}

/**
 * 401 Unauthorized
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(message, 401, code);
  }
}

/**
 * 403 Forbidden
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}

/**
 * 404 Not Found
 */
export class NotFoundError extends AppError {
  constructor(message = 'Not found', code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

/**
 * 409 Conflict
 */
export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(message, 409, code);
  }
}

/**
 * 422 Unprocessable Entity
 */
export class ValidationError extends AppError {
  public readonly details: unknown;

  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 422, 'VALIDATION_ERROR');
    this.details = details;
  }
}

/**
 * 500 Internal Server Error
 */
export class InternalError extends AppError {
  constructor(message = 'Internal server error', code = 'INTERNAL_ERROR') {
    super(message, 500, code, false);
  }
}

/**
 * 503 Service Unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable', code = 'SERVICE_UNAVAILABLE') {
    super(message, 503, code);
  }
}

/**
 * Job processing error
 */
export class JobError extends AppError {
  public readonly jobId: string;

  constructor(jobId: string, message: string, code = 'JOB_ERROR') {
    super(message, 500, code);
    this.jobId = jobId;
  }
}

/**
 * External API error (Gemini, Photoroom, etc.)
 */
export class ExternalApiError extends AppError {
  public readonly service: string;
  public readonly originalError?: Error;

  constructor(service: string, message: string, originalError?: Error) {
    super(`${service}: ${message}`, 502, 'EXTERNAL_API_ERROR');
    this.service = service;
    this.originalError = originalError;
  }
}

import { describe, it, expect } from 'vitest';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  InternalError,
  ServiceUnavailableError,
  JobError,
  ExternalApiError,
} from './errors.js';

describe('errors', () => {
  describe('AppError', () => {
    it('should create error with all properties', () => {
      const error = new AppError('Test message', 400, 'TEST_CODE', true);

      expect(error.message).toBe('Test message');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('TEST_CODE');
      expect(error.isOperational).toBe(true);
      expect(error.stack).toBeDefined();
      // Error is instance of AppError
      expect(error).toBeInstanceOf(AppError);
    });

    it('should default isOperational to true', () => {
      const error = new AppError('Test', 500, 'TEST');
      expect(error.isOperational).toBe(true);
    });

    it('should be instance of Error', () => {
      const error = new AppError('Test', 500, 'TEST');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
    });
  });

  describe('BadRequestError', () => {
    it('should create 400 error with default message', () => {
      const error = new BadRequestError();

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Bad request');
      expect(error.code).toBe('BAD_REQUEST');
    });

    it('should accept custom message', () => {
      const error = new BadRequestError('Invalid input');
      expect(error.message).toBe('Invalid input');
    });

    it('should accept custom code', () => {
      const error = new BadRequestError('Invalid', 'INVALID_INPUT');
      expect(error.code).toBe('INVALID_INPUT');
    });
  });

  describe('UnauthorizedError', () => {
    it('should create 401 error with default message', () => {
      const error = new UnauthorizedError();

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Unauthorized');
      expect(error.code).toBe('UNAUTHORIZED');
    });

    it('should accept custom message', () => {
      const error = new UnauthorizedError('Invalid token');
      expect(error.message).toBe('Invalid token');
    });
  });

  describe('ForbiddenError', () => {
    it('should create 403 error with default message', () => {
      const error = new ForbiddenError();

      expect(error.statusCode).toBe(403);
      expect(error.message).toBe('Forbidden');
      expect(error.code).toBe('FORBIDDEN');
    });
  });

  describe('NotFoundError', () => {
    it('should create 404 error with default message', () => {
      const error = new NotFoundError();

      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Not found');
      expect(error.code).toBe('NOT_FOUND');
    });

    it('should accept custom message', () => {
      const error = new NotFoundError('Job not found');
      expect(error.message).toBe('Job not found');
    });
  });

  describe('ConflictError', () => {
    it('should create 409 error with default message', () => {
      const error = new ConflictError();

      expect(error.statusCode).toBe(409);
      expect(error.message).toBe('Conflict');
      expect(error.code).toBe('CONFLICT');
    });
  });

  describe('ValidationError', () => {
    it('should create 422 error with default message', () => {
      const error = new ValidationError();

      expect(error.statusCode).toBe(422);
      expect(error.message).toBe('Validation failed');
      expect(error.code).toBe('VALIDATION_ERROR');
    });

    it('should include validation details', () => {
      const details = { field: 'email', message: 'Invalid format' };
      const error = new ValidationError('Validation failed', details);

      expect(error.details).toEqual(details);
    });
  });

  describe('InternalError', () => {
    it('should create 500 error with default message', () => {
      const error = new InternalError();

      expect(error.statusCode).toBe(500);
      expect(error.message).toBe('Internal server error');
      expect(error.code).toBe('INTERNAL_ERROR');
    });

    it('should mark as non-operational', () => {
      const error = new InternalError();
      expect(error.isOperational).toBe(false);
    });
  });

  describe('ServiceUnavailableError', () => {
    it('should create 503 error with default message', () => {
      const error = new ServiceUnavailableError();

      expect(error.statusCode).toBe(503);
      expect(error.message).toBe('Service unavailable');
      expect(error.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  describe('JobError', () => {
    it('should create error with job ID', () => {
      const error = new JobError('job-123', 'Processing failed');

      expect(error.statusCode).toBe(500);
      expect(error.message).toBe('Processing failed');
      expect(error.code).toBe('JOB_ERROR');
      expect(error.jobId).toBe('job-123');
    });

    it('should accept custom code', () => {
      const error = new JobError('job-123', 'Failed', 'JOB_TIMEOUT');
      expect(error.code).toBe('JOB_TIMEOUT');
    });
  });

  describe('ExternalApiError', () => {
    it('should create error with service name', () => {
      const error = new ExternalApiError('Gemini', 'Rate limited');

      expect(error.statusCode).toBe(502);
      expect(error.message).toBe('Gemini: Rate limited');
      expect(error.code).toBe('EXTERNAL_API_ERROR');
      expect(error.service).toBe('Gemini');
    });

    it('should include original error', () => {
      const originalError = new Error('Connection refused');
      const error = new ExternalApiError('S3', 'Upload failed', originalError);

      expect(error.originalError).toBe(originalError);
    });
  });
});

import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { AppError, ValidationError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { ZodError } from 'zod';

interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
}

/**
 * Global error handler for Fastify
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const logger = getLogger();

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const validationError = new ValidationError('Validation failed', error.format());
    reply.status(validationError.statusCode).send({
      error: validationError.code,
      message: validationError.message,
      statusCode: validationError.statusCode,
      details: validationError.details,
    } satisfies ErrorResponse);
    return;
  }

  // Handle custom application errors
  if (error instanceof AppError) {
    if (!error.isOperational) {
      logger.error({ err: error, requestId: request.id }, 'Non-operational error occurred');
    } else {
      logger.warn({ err: error, requestId: request.id }, 'Operational error occurred');
    }

    const response: ErrorResponse = {
      error: error.code,
      message: error.message,
      statusCode: error.statusCode,
    };

    if (error instanceof ValidationError && error.details) {
      response.details = error.details;
    }

    reply.status(error.statusCode).send(response);
    return;
  }

  // Handle Fastify validation errors
  if (error.validation) {
    reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      statusCode: 400,
      details: error.validation,
    } satisfies ErrorResponse);
    return;
  }

  // Unknown errors
  logger.error({ err: error, requestId: request.id }, 'Unhandled error occurred');

  reply.status(500).send({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500,
  } satisfies ErrorResponse);
}

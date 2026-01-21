/**
 * Pipeline Timer Utility
 * Tracks execution time for pipeline steps and individual operations
 */

import { createChildLogger } from './logger.js';

const logger = createChildLogger({ service: 'timer' });

/** Default threshold in ms for logging slow operations */
const DEFAULT_SLOW_THRESHOLD_MS = 1000;

/** Known API operation types that should always be logged */
const API_OPERATION_TYPES = new Set([
  'gemini_classify_batch',
  'photoroom_generate_versions',
  'photoroom_remove_background',
  'product_extraction_all',
]);

export interface TimingEntry {
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface StepSummary {
  step: string;
  durationMs: number;
  durationFormatted: string;
  operations: OperationSummary[];
}

export interface OperationSummary {
  name: string;
  count: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

export interface PipelineSummary {
  jobId: string;
  totalDurationMs: number;
  totalDurationFormatted: string;
  steps: StepSummary[];
  operationTotals: OperationSummary[];
}

export interface TimerOptions {
  /** Threshold in ms for logging slow operations (default: 1000) */
  slowThresholdMs?: number;
  /** Log prefix (default: "[TIMER]") */
  logPrefix?: string;
}

/**
 * Format milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Pipeline Timer - tracks timing for all pipeline operations
 */
export class PipelineTimer {
  private jobId: string;
  private pipelineStart: number;
  private currentStep: string | null = null;
  private stepStart: number = 0;
  private steps: Map<string, TimingEntry> = new Map();
  private operations: Map<string, TimingEntry[]> = new Map();
  private slowThresholdMs: number;
  private logPrefix: string;

  constructor(jobId: string, options: TimerOptions = {}) {
    this.jobId = jobId;
    this.pipelineStart = Date.now();
    this.slowThresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
    this.logPrefix = options.logPrefix ?? '[TIMER]';
    logger.info({ jobId }, `${this.logPrefix} Pipeline timer started`);
  }

  /**
   * Start timing a pipeline step
   */
  startStep(stepName: string): void {
    // End previous step if any
    if (this.currentStep) {
      this.endStep();
    }

    this.currentStep = stepName;
    this.stepStart = Date.now();
    this.steps.set(stepName, {
      name: stepName,
      startTime: this.stepStart,
    });

    logger.info(
      { jobId: this.jobId, step: stepName },
      `${this.logPrefix} Step started: ${stepName}`
    );
  }

  /**
   * End timing the current step
   */
  endStep(): void {
    if (!this.currentStep) return;

    const entry = this.steps.get(this.currentStep);
    if (entry) {
      entry.endTime = Date.now();
      entry.durationMs = entry.endTime - entry.startTime;

      logger.info(
        {
          jobId: this.jobId,
          step: this.currentStep,
          durationMs: entry.durationMs,
          duration: formatDuration(entry.durationMs),
        },
        `${this.logPrefix} Step completed: ${this.currentStep} (${formatDuration(entry.durationMs)})`
      );
    }

    this.currentStep = null;
  }

  /**
   * Check if an operation type is a known API call
   */
  private isApiOperation(operationType: string): boolean {
    return API_OPERATION_TYPES.has(operationType);
  }

  /**
   * Time an individual operation (frame processing, API call, etc.)
   * Returns a function to call when the operation completes
   * @param operationType - Type of operation (use consistent names for aggregation)
   * @param metadata - Optional metadata to include in logs
   * @param options - Optional settings for this operation
   */
  startOperation(
    operationType: string,
    metadata?: Record<string, unknown>,
    options?: { alwaysLog?: boolean }
  ): () => void {
    const startTime = Date.now();
    const entry: TimingEntry = {
      name: operationType,
      startTime,
      metadata,
    };

    return () => {
      entry.endTime = Date.now();
      entry.durationMs = entry.endTime - entry.startTime;

      // Store operation timing
      const operationList = this.operations.get(operationType);
      if (operationList) {
        operationList.push(entry);
      } else {
        this.operations.set(operationType, [entry]);
      }

      // Log individual operation if it's slow, an API call, or explicitly requested
      const shouldLog =
        options?.alwaysLog ||
        entry.durationMs > this.slowThresholdMs ||
        this.isApiOperation(operationType);

      if (shouldLog) {
        logger.debug(
          {
            jobId: this.jobId,
            operation: operationType,
            durationMs: entry.durationMs,
            duration: formatDuration(entry.durationMs),
            ...metadata,
          },
          `${this.logPrefix} ${operationType}: ${formatDuration(entry.durationMs)}`
        );
      }
    };
  }

  /**
   * Convenience method to time an async operation
   */
  async timeOperation<T>(
    operationType: string,
    operation: () => Promise<T>,
    metadata?: Record<string, unknown>,
    options?: { alwaysLog?: boolean }
  ): Promise<T> {
    const end = this.startOperation(operationType, metadata, options);
    try {
      return await operation();
    } finally {
      end();
    }
  }

  /**
   * Get summary of all timings
   */
  getSummary(): PipelineSummary {
    // End current step if still running
    if (this.currentStep) {
      this.endStep();
    }

    const totalDurationMs = Date.now() - this.pipelineStart;

    // Build step summaries
    const stepSummaries: StepSummary[] = [];
    for (const [stepName, entry] of this.steps) {
      if (entry.durationMs !== undefined) {
        stepSummaries.push({
          step: stepName,
          durationMs: entry.durationMs,
          durationFormatted: formatDuration(entry.durationMs),
          operations: [],
        });
      }
    }

    // Build operation summaries
    const operationTotals: OperationSummary[] = [];
    for (const [opType, entries] of this.operations) {
      // Filter entries with valid duration and extract durations
      const validEntries = entries.filter((e): e is TimingEntry & { durationMs: number } =>
        e.durationMs !== undefined
      );

      if (validEntries.length > 0) {
        const durations = validEntries.map((e) => e.durationMs);
        const totalMs = durations.reduce((a, b) => a + b, 0);
        operationTotals.push({
          name: opType,
          count: durations.length,
          totalMs,
          avgMs: Math.round(totalMs / durations.length),
          minMs: Math.min(...durations),
          maxMs: Math.max(...durations),
        });
      }
    }

    // Sort operations by total time (descending)
    operationTotals.sort((a, b) => b.totalMs - a.totalMs);

    return {
      jobId: this.jobId,
      totalDurationMs,
      totalDurationFormatted: formatDuration(totalDurationMs),
      steps: stepSummaries,
      operationTotals,
    };
  }

  /**
   * Log the final summary
   */
  logSummary(): void {
    const summary = this.getSummary();

    // Log step breakdown
    logger.info(
      {
        jobId: this.jobId,
        totalDuration: summary.totalDurationFormatted,
        totalDurationMs: summary.totalDurationMs,
      },
      `${this.logPrefix} Pipeline completed in ${summary.totalDurationFormatted}`
    );

    // Log step details
    const stepBreakdown = summary.steps.map(
      (s) => `${s.step}: ${s.durationFormatted}`
    ).join(' | ');
    logger.info({ jobId: this.jobId }, `${this.logPrefix} Steps: ${stepBreakdown}`);

    // Log operation breakdown (top 10 by total time)
    const topOperations = summary.operationTotals.slice(0, 10);
    if (topOperations.length > 0) {
      const opBreakdown = topOperations.map(
        (o) => `${o.name}: ${o.count}x @ avg ${formatDuration(o.avgMs)} (total: ${formatDuration(o.totalMs)})`
      );
      logger.info(
        { jobId: this.jobId, operations: summary.operationTotals },
        `${this.logPrefix} Top operations:\n    ${opBreakdown.join('\n    ')}`
      );
    }
  }
}

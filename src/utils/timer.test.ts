import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDuration, PipelineTimer } from './timer.js';

// Mock the logger
vi.mock('./logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('formatDuration', () => {
  it('should format milliseconds under 1 second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('should format seconds under 1 minute', () => {
    expect(formatDuration(1000)).toBe('1.00s');
    expect(formatDuration(1500)).toBe('1.50s');
    expect(formatDuration(5000)).toBe('5.00s');
    expect(formatDuration(59999)).toBe('60.00s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0.0s');
    expect(formatDuration(90000)).toBe('1m 30.0s');
    expect(formatDuration(125000)).toBe('2m 5.0s');
    expect(formatDuration(3661000)).toBe('61m 1.0s');
  });

  it('should handle edge cases', () => {
    expect(formatDuration(0.4)).toBe('0ms');
    expect(formatDuration(0.6)).toBe('1ms');
  });
});

describe('PipelineTimer', () => {
  let originalDateNow: () => number;
  let mockTime: number;

  beforeEach(() => {
    originalDateNow = Date.now;
    mockTime = 1000000;
    Date.now = vi.fn(() => mockTime);
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  const advanceTime = (ms: number) => {
    mockTime += ms;
  };

  describe('constructor', () => {
    it('should initialize with jobId', () => {
      const timer = new PipelineTimer('job-123');
      const summary = timer.getSummary();
      expect(summary.jobId).toBe('job-123');
    });

    it('should start tracking time from construction', () => {
      const timer = new PipelineTimer('job-123');
      advanceTime(5000);
      const summary = timer.getSummary();
      expect(summary.totalDurationMs).toBe(5000);
    });
  });

  describe('startStep/endStep', () => {
    it('should track a single step duration', () => {
      const timer = new PipelineTimer('job-123');

      timer.startStep('download');
      advanceTime(2000);
      timer.endStep();

      const summary = timer.getSummary();
      expect(summary.steps).toHaveLength(1);
      expect(summary.steps[0].step).toBe('download');
      expect(summary.steps[0].durationMs).toBe(2000);
      expect(summary.steps[0].durationFormatted).toBe('2.00s');
    });

    it('should track multiple steps', () => {
      const timer = new PipelineTimer('job-123');

      timer.startStep('download');
      advanceTime(1000);
      timer.endStep();

      timer.startStep('extract');
      advanceTime(3000);
      timer.endStep();

      timer.startStep('score');
      advanceTime(500);
      timer.endStep();

      const summary = timer.getSummary();
      expect(summary.steps).toHaveLength(3);
      expect(summary.steps[0]).toEqual({
        step: 'download',
        durationMs: 1000,
        durationFormatted: '1.00s',
        operations: [],
      });
      expect(summary.steps[1]).toEqual({
        step: 'extract',
        durationMs: 3000,
        durationFormatted: '3.00s',
        operations: [],
      });
      expect(summary.steps[2]).toEqual({
        step: 'score',
        durationMs: 500,
        durationFormatted: '500ms',
        operations: [],
      });
    });

    it('should auto-end previous step when starting a new one', () => {
      const timer = new PipelineTimer('job-123');

      timer.startStep('download');
      advanceTime(1000);
      timer.startStep('extract'); // Should auto-end 'download'
      advanceTime(2000);
      timer.endStep();

      const summary = timer.getSummary();
      expect(summary.steps).toHaveLength(2);
      expect(summary.steps[0].durationMs).toBe(1000);
      expect(summary.steps[1].durationMs).toBe(2000);
    });

    it('should handle endStep when no step is active', () => {
      const timer = new PipelineTimer('job-123');
      // Should not throw
      expect(() => timer.endStep()).not.toThrow();
    });

    it('should auto-end step in getSummary if still running', () => {
      const timer = new PipelineTimer('job-123');

      timer.startStep('download');
      advanceTime(1500);
      // Don't call endStep

      const summary = timer.getSummary();
      expect(summary.steps).toHaveLength(1);
      expect(summary.steps[0].durationMs).toBe(1500);
    });
  });

  describe('startOperation', () => {
    it('should track operation timing with callback', () => {
      const timer = new PipelineTimer('job-123');

      const end = timer.startOperation('api_call');
      advanceTime(500);
      end();

      const summary = timer.getSummary();
      expect(summary.operationTotals).toHaveLength(1);
      expect(summary.operationTotals[0].name).toBe('api_call');
      expect(summary.operationTotals[0].count).toBe(1);
      expect(summary.operationTotals[0].totalMs).toBe(500);
    });

    it('should track multiple operations of the same type', () => {
      const timer = new PipelineTimer('job-123');

      const end1 = timer.startOperation('s3_upload');
      advanceTime(100);
      end1();

      const end2 = timer.startOperation('s3_upload');
      advanceTime(200);
      end2();

      const end3 = timer.startOperation('s3_upload');
      advanceTime(150);
      end3();

      const summary = timer.getSummary();
      expect(summary.operationTotals).toHaveLength(1);
      expect(summary.operationTotals[0]).toEqual({
        name: 's3_upload',
        count: 3,
        totalMs: 450,
        avgMs: 150,
        minMs: 100,
        maxMs: 200,
      });
    });

    it('should track operations with metadata', () => {
      const timer = new PipelineTimer('job-123');

      const end = timer.startOperation('gemini_call', { batchIdx: 0, batchSize: 30 });
      advanceTime(5000);
      end();

      const summary = timer.getSummary();
      expect(summary.operationTotals[0].name).toBe('gemini_call');
    });

    it('should track different operation types separately', () => {
      const timer = new PipelineTimer('job-123');

      const end1 = timer.startOperation('gemini_call');
      advanceTime(3000);
      end1();

      const end2 = timer.startOperation('photoroom_call');
      advanceTime(2000);
      end2();

      const summary = timer.getSummary();
      expect(summary.operationTotals).toHaveLength(2);
      // Sorted by total time descending
      expect(summary.operationTotals[0].name).toBe('gemini_call');
      expect(summary.operationTotals[1].name).toBe('photoroom_call');
    });
  });

  describe('timeOperation', () => {
    it('should time an async operation', async () => {
      const timer = new PipelineTimer('job-123');

      const result = await timer.timeOperation(
        'async_op',
        async () => {
          advanceTime(1000);
          return 'result';
        }
      );

      expect(result).toBe('result');
      const summary = timer.getSummary();
      expect(summary.operationTotals[0].totalMs).toBe(1000);
    });

    it('should time operation even if it throws', async () => {
      const timer = new PipelineTimer('job-123');

      await expect(
        timer.timeOperation('failing_op', async () => {
          advanceTime(500);
          throw new Error('Operation failed');
        })
      ).rejects.toThrow('Operation failed');

      const summary = timer.getSummary();
      expect(summary.operationTotals).toHaveLength(1);
      expect(summary.operationTotals[0].name).toBe('failing_op');
      expect(summary.operationTotals[0].totalMs).toBe(500);
    });

    it('should pass metadata to the operation', async () => {
      const timer = new PipelineTimer('job-123');

      await timer.timeOperation(
        'api_call',
        async () => {
          advanceTime(100);
          return true;
        },
        { endpoint: '/test', method: 'POST' }
      );

      const summary = timer.getSummary();
      expect(summary.operationTotals[0].count).toBe(1);
    });
  });

  describe('getSummary', () => {
    it('should return empty summary for fresh timer', () => {
      const timer = new PipelineTimer('job-123');

      const summary = timer.getSummary();
      expect(summary.jobId).toBe('job-123');
      expect(summary.steps).toHaveLength(0);
      expect(summary.operationTotals).toHaveLength(0);
      expect(summary.totalDurationMs).toBe(0);
    });

    it('should format total duration', () => {
      const timer = new PipelineTimer('job-123');
      advanceTime(65000); // 1m 5s

      const summary = timer.getSummary();
      expect(summary.totalDurationFormatted).toBe('1m 5.0s');
    });

    it('should sort operations by total time descending', () => {
      const timer = new PipelineTimer('job-123');

      // Add operations in random order
      const end1 = timer.startOperation('fast_op');
      advanceTime(100);
      end1();

      const end2 = timer.startOperation('slow_op');
      advanceTime(5000);
      end2();

      const end3 = timer.startOperation('medium_op');
      advanceTime(1000);
      end3();

      const summary = timer.getSummary();
      expect(summary.operationTotals[0].name).toBe('slow_op');
      expect(summary.operationTotals[1].name).toBe('medium_op');
      expect(summary.operationTotals[2].name).toBe('fast_op');
    });
  });

  describe('logSummary', () => {
    it('should not throw for empty timer', () => {
      const timer = new PipelineTimer('job-123');
      expect(() => timer.logSummary()).not.toThrow();
    });

    it('should not throw with steps and operations', () => {
      const timer = new PipelineTimer('job-123');

      timer.startStep('test');
      advanceTime(1000);
      timer.endStep();

      const end = timer.startOperation('op');
      advanceTime(500);
      end();

      expect(() => timer.logSummary()).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle rapid successive operations', () => {
      const timer = new PipelineTimer('job-123');

      for (let i = 0; i < 100; i++) {
        const end = timer.startOperation('rapid_op');
        advanceTime(10);
        end();
      }

      const summary = timer.getSummary();
      expect(summary.operationTotals[0].count).toBe(100);
      expect(summary.operationTotals[0].totalMs).toBe(1000);
      expect(summary.operationTotals[0].avgMs).toBe(10);
    });

    it('should handle zero-duration operations', () => {
      const timer = new PipelineTimer('job-123');

      const end = timer.startOperation('instant_op');
      // No time advance
      end();

      const summary = timer.getSummary();
      expect(summary.operationTotals[0].totalMs).toBe(0);
      expect(summary.operationTotals[0].minMs).toBe(0);
      expect(summary.operationTotals[0].maxMs).toBe(0);
    });

    it('should handle concurrent operations', () => {
      const timer = new PipelineTimer('job-123');

      const end1 = timer.startOperation('concurrent_a');
      advanceTime(100);
      const end2 = timer.startOperation('concurrent_b');
      advanceTime(200);
      end1(); // Total: 300ms for concurrent_a
      advanceTime(100);
      end2(); // Total: 300ms for concurrent_b

      const summary = timer.getSummary();
      expect(summary.operationTotals).toHaveLength(2);
      expect(summary.operationTotals.find(o => o.name === 'concurrent_a')?.totalMs).toBe(300);
      expect(summary.operationTotals.find(o => o.name === 'concurrent_b')?.totalMs).toBe(300);
    });
  });
});

import { createChildLogger } from './logger.js';

const logger = createChildLogger({ service: 'token-usage' });

/**
 * Token usage information for a specific processor+model combination
 */
export interface TokenUsage {
  /** Gemini model name (e.g., 'gemini-2.0-flash') */
  model: string;
  /** Processor name (e.g., 'gemini-classify', 'gemini-audio-analysis') */
  processor: string;
  /** Total prompt tokens consumed */
  promptTokens: number;
  /** Total candidate/output tokens generated */
  candidatesTokens: number;
  /** Total tokens (prompt + candidates) */
  totalTokens: number;
  /** Number of API calls made */
  callCount: number;
}

/**
 * Aggregated token usage totals across all processors
 */
export interface TokenUsageTotals {
  /** Total prompt tokens across all processors */
  promptTokens: number;
  /** Total candidate tokens across all processors */
  candidatesTokens: number;
  /** Total tokens (prompt + candidates) */
  totalTokens: number;
}

/**
 * Summary of token usage with per-processor breakdown and totals
 */
export interface TokenUsageSummary {
  /** Per-processor token usage entries */
  entries: TokenUsage[];
  /** Aggregated totals */
  totals: TokenUsageTotals;
}

/**
 * Gemini pricing per model (USD per 1M tokens)
 * Source: https://ai.google.dev/pricing
 * Updated: 2026-01
 */
export const GEMINI_PRICING: Record<string, { prompt: number; candidates: number }> = {
  'gemini-2.0-flash': { prompt: 0.00001875, candidates: 0.000075 },
  'gemini-2.0-flash-exp': { prompt: 0, candidates: 0 }, // Free during preview
  'gemini-2.5-flash': { prompt: 0.00001875, candidates: 0.000075 },
  'gemini-2.5-flash-image': { prompt: 0.00001875, candidates: 0.000075 },
  'gemini-1.5-flash': { prompt: 0.0000375, candidates: 0.00015 },
  'gemini-1.5-pro': { prompt: 0.00125, candidates: 0.005 },
};

/**
 * Calculate estimated cost for token usage
 * @param usage - Token usage entry
 * @returns Estimated cost in USD, or null if model pricing not available
 */
export function estimateCost(usage: TokenUsage): number | null {
  const pricing = GEMINI_PRICING[usage.model];
  if (!pricing) return null;

  const promptCost = (usage.promptTokens / 1_000_000) * pricing.prompt;
  const candidatesCost = (usage.candidatesTokens / 1_000_000) * pricing.candidates;

  return promptCost + candidatesCost;
}

/**
 * Tracks Gemini API token consumption across processors during a pipeline run.
 *
 * Each pipeline execution gets its own tracker instance via `ProcessorContext.tokenUsage`.
 * Processors pass the tracker to their providers, which record usage after API calls.
 *
 * @example
 * ```typescript
 * const tracker = new TokenUsageTracker();
 *
 * // Record usage from Gemini API response
 * tracker.record('gemini-2.0-flash', 'gemini-classify', 100, 50);
 *
 * // Get summary
 * const summary = tracker.getSummary();
 * console.log(summary.totals.totalTokens); // 150
 *
 * // Log formatted summary
 * tracker.logSummary('job-123');
 * ```
 *
 * **Note on reusability**: If the same tracker instance is reused across multiple
 * stack executions (via `context.tokenUsage`), token counts will accumulate.
 * Call `reset()` to clear accumulated data between runs if needed.
 */
export class TokenUsageTracker {
  private entries: Map<string, TokenUsage> = new Map();

  /**
   * Record token usage for a processor+model combination.
   *
   * Multiple calls with the same processor+model are accumulated automatically.
   * This method is safe to call from within try-catch blocks - tracking failures
   * should not break processing.
   *
   * @param model - Gemini model name (e.g., 'gemini-2.0-flash')
   * @param processor - Processor name (e.g., 'gemini-classify')
   * @param promptTokens - Number of prompt tokens consumed
   * @param candidatesTokens - Number of candidate/output tokens generated
   *
   * @example
   * ```typescript
   * if (tokenUsage && response.usageMetadata) {
   *   tokenUsage.record(
   *     'gemini-2.0-flash',
   *     'gemini-classify',
   *     response.usageMetadata.promptTokenCount ?? 0,
   *     response.usageMetadata.candidatesTokenCount ?? 0
   *   );
   * }
   * ```
   */
  record(model: string, processor: string, promptTokens: number, candidatesTokens: number): void {
    const key = `${processor}:${model}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.promptTokens += promptTokens;
      existing.candidatesTokens += candidatesTokens;
      existing.totalTokens += promptTokens + candidatesTokens;
      existing.callCount += 1;
    } else {
      this.entries.set(key, {
        model,
        processor,
        promptTokens,
        candidatesTokens,
        totalTokens: promptTokens + candidatesTokens,
        callCount: 1,
      });
    }
  }

  /**
   * Get a summary of all recorded token usage.
   *
   * Returns entries for each processor+model combination along with aggregated totals.
   * The returned entries are live references to internal state - do not mutate them.
   *
   * @returns Summary with per-processor entries and totals
   */
  getSummary(): TokenUsageSummary {
    const entries = [...this.entries.values()];
    const totals = entries.reduce<TokenUsageTotals>(
      (acc, e) => ({
        promptTokens: acc.promptTokens + e.promptTokens,
        candidatesTokens: acc.candidatesTokens + e.candidatesTokens,
        totalTokens: acc.totalTokens + e.totalTokens,
      }),
      { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 },
    );
    return { entries, totals };
  }

  /**
   * Log a formatted summary table of token usage via pino logger.
   *
   * Includes per-processor breakdown with call counts and token totals,
   * plus estimated costs where pricing is available. No-op if no entries recorded.
   *
   * @param jobId - Optional job ID to include in log context
   *
   * @example
   * ```typescript
   * tracker.logSummary('job-abc-123');
   * // Logs table like:
   * // | Processor          | Model            | Calls | Prompt | Candidates | Total  | Cost ($) |
   * // |--------------------|------------------|-------|--------|------------|--------|----------|
   * // | gemini-classify    | gemini-2.0-flash | 3     | 1200   | 800        | 2000   | 0.000082 |
   * // | gemini-audio       | gemini-2.0-flash | 1     | 500    | 300        | 800    | 0.000032 |
   * // | TOTAL              |                  | 4     | 1700   | 1100       | 2800   | 0.000114 |
   * ```
   */
  logSummary(jobId?: string): void {
    const { entries, totals } = this.getSummary();
    if (entries.length === 0) return;

    const rows = entries.map((e) => {
      const cost = estimateCost(e);
      return {
        Processor: e.processor,
        Model: e.model,
        Calls: e.callCount,
        Prompt: e.promptTokens,
        Candidates: e.candidatesTokens,
        Total: e.totalTokens,
        'Cost ($)': cost !== null ? cost.toFixed(6) : 'N/A',
      };
    });

    const totalCost = entries.reduce((sum, e) => {
      const cost = estimateCost(e);
      return cost !== null ? sum + cost : sum;
    }, 0);

    rows.push({
      Processor: 'TOTAL',
      Model: '',
      Calls: entries.reduce((s, e) => s + e.callCount, 0),
      Prompt: totals.promptTokens,
      Candidates: totals.candidatesTokens,
      Total: totals.totalTokens,
      'Cost ($)': totalCost > 0 ? totalCost.toFixed(6) : 'N/A',
    });

    logger.info({ tokenUsage: rows, ...(jobId ? { jobId } : {}) }, 'Gemini Token Usage Summary');
  }

  /**
   * Clear all accumulated token usage entries.
   *
   * Useful when reusing a tracker instance across multiple pipeline runs.
   */
  reset(): void {
    this.entries.clear();
  }
}

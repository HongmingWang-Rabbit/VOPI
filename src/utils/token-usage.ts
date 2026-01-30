import { createChildLogger } from './logger.js';

const logger = createChildLogger({ service: 'token-usage' });

export interface TokenUsage {
  model: string;
  processor: string;
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  callCount: number;
}

export interface TokenUsageTotals {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
}

export interface TokenUsageSummary {
  entries: TokenUsage[];
  totals: TokenUsageTotals;
}

export class TokenUsageTracker {
  private entries: Map<string, TokenUsage> = new Map();

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

  logSummary(jobId?: string): void {
    const { entries, totals } = this.getSummary();
    if (entries.length === 0) return;

    const rows = entries.map((e) => ({
      Processor: e.processor,
      Model: e.model,
      Calls: e.callCount,
      Prompt: e.promptTokens,
      Candidates: e.candidatesTokens,
      Total: e.totalTokens,
    }));

    rows.push({
      Processor: 'TOTAL',
      Model: '',
      Calls: entries.reduce((s, e) => s + e.callCount, 0),
      Prompt: totals.promptTokens,
      Candidates: totals.candidatesTokens,
      Total: totals.totalTokens,
    });

    logger.info({ tokenUsage: rows, ...(jobId ? { jobId } : {}) }, 'Gemini Token Usage Summary');
  }

  reset(): void {
    this.entries.clear();
  }
}

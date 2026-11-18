import {
  budgetNoticeKey,
  dayKey,
  monthKey,
  SENDER_LIMIT_NOTICE_KEY,
  type LlmBudgetPeriod,
  type LlmCallRecord,
  type LlmRecordResult,
  type LlmSpendPeriods,
  type LlmSpendStore,
  type LlmSpendTotals,
  type LlmTurnRequest,
  type LlmTurnVerdict,
} from '../domain/llm-spend';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

interface PeriodRow {
  usd: number;
  warned80: boolean;
  exhausted: boolean;
}

/**
 * Process-local LlmSpendStore with the PostgreSQL store's semantics. For
 * tests and harnesses only: production binds PostgresLlmSpendStore so the
 * caps and limits survive restarts and hold across processes.
 */
export class InMemoryLlmSpendStore implements LlmSpendStore {
  private readonly periods = new Map<string, PeriodRow>();
  private readonly turns = new Map<string, number[]>();
  private readonly notices = new Set<string>();

  record(call: LlmCallRecord): Promise<LlmRecordResult> {
    const warned80: LlmBudgetPeriod[] = [];
    const reached100: LlmBudgetPeriod[] = [];
    const book = (period: LlmBudgetPeriod, key: string, cap: number) => {
      const row = this.periods.get(key) ?? {
        usd: 0,
        warned80: false,
        exhausted: false,
      };
      row.usd += call.usd;
      if (!row.warned80 && row.usd >= cap * 0.8) {
        row.warned80 = true;
        warned80.push(period);
      }
      if (!row.exhausted && row.usd >= cap) {
        row.exhausted = true;
        reached100.push(period);
      }
      this.periods.set(key, row);
      return row.usd;
    };
    const dayUsd = book('day', dayKey(call.periods), call.caps.dayUsd);
    const monthUsd = book('month', monthKey(call.periods), call.caps.monthUsd);
    return Promise.resolve({ dayUsd, monthUsd, warned80, reached100 });
  }

  totals(periods: LlmSpendPeriods): Promise<LlmSpendTotals> {
    return Promise.resolve(this.readTotals(periods));
  }

  admitTurn(request: LlmTurnRequest): Promise<LlmTurnVerdict> {
    const now = request.at.getTime();
    const spend = this.readTotals(request.periods);
    const budget: LlmBudgetPeriod | null =
      spend.monthUsd >= request.caps.monthUsd
        ? 'month'
        : spend.dayUsd >= request.caps.dayUsd
          ? 'day'
          : null;
    const kept = (this.turns.get(request.senderId) ?? []).filter(
      (at) => at > now - DAY_MS,
    );
    const hour = kept.filter((at) => at > now - HOUR_MS).length;
    const window: 'hour' | 'day' | null =
      hour >= request.limits.perHour
        ? 'hour'
        : kept.length >= request.limits.perDay
          ? 'day'
          : null;
    const limitNotice = `${request.senderId}|${SENDER_LIMIT_NOTICE_KEY}`;
    if (budget === null && window === null) {
      kept.push(now);
      this.turns.set(request.senderId, kept);
      this.notices.delete(limitNotice);
      return Promise.resolve({ kind: 'allowed' });
    }
    this.turns.set(request.senderId, kept);
    const notice =
      budget === null
        ? limitNotice
        : `${request.senderId}|${budgetNoticeKey(budget, request.periods)}`;
    const firstNotice = !this.notices.has(notice);
    this.notices.add(notice);
    return Promise.resolve(
      budget !== null
        ? { kind: 'budget_exhausted', period: budget, firstNotice }
        : { kind: 'sender_limited', window: window!, firstNotice },
    );
  }

  private readTotals(periods: LlmSpendPeriods): LlmSpendTotals {
    return {
      dayUsd: this.periods.get(dayKey(periods))?.usd ?? 0,
      monthUsd: this.periods.get(monthKey(periods))?.usd ?? 0,
    };
  }
}

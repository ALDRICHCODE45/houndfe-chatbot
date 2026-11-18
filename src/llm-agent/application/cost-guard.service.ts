import { Injectable, Logger } from '@nestjs/common';
import { describeError } from '../../common/log-safe';
import {
  estimateLlmUsd,
  llmSpendPeriods,
  type LlmBudgetPeriod,
  type LlmCallSource,
  type LlmRecordResult,
  type LlmSpendPeriods,
  type LlmSpendStore,
  type LlmSpendTotals,
  type LlmTurnVerdict,
} from '../domain/llm-spend';

export interface CostGuardSettings {
  /** USD per million input tokens (default: gpt-4o-mini list price). */
  priceInputUsdPerMtok: number;
  /** USD per million output tokens (default: gpt-4o-mini list price). */
  priceOutputUsdPerMtok: number;
  /** Cap per calendar day in America/Mexico_City. */
  dailyBudgetUsd: number;
  /** Cap per calendar month in America/Mexico_City. */
  monthlyBudgetUsd: number;
  /** LLM-using turns per sender in a rolling hour. */
  senderLimitPerHour: number;
  /** LLM-using turns per sender in a rolling 24 h. */
  senderLimitPerDay: number;
}

export const DEFAULT_COST_GUARD_SETTINGS: Readonly<CostGuardSettings> =
  Object.freeze({
    priceInputUsdPerMtok: 0.15,
    priceOutputUsdPerMtok: 0.6,
    dailyBudgetUsd: 10,
    monthlyBudgetUsd: 200,
    senderLimitPerHour: 40,
    senderLimitPerDay: 120,
  });

export type CostGuardOptions = Partial<CostGuardSettings> & {
  /** The shared ledger; absent (test harnesses) = allow all, count tokens. */
  store?: LlmSpendStore;
  clock?: () => Date;
};

const PERIOD_LABEL: Record<LlmBudgetPeriod, string> = {
  day: 'daily',
  month: 'monthly',
};

/**
 * Cost protection phase 1 (odd/tasks/cost-and-abuse-phase1.md S2/S5).
 *
 *   - `record` books every LLM call (tokens + estimated USD) in the shared
 *     Postgres ledger, off the reply path, and logs one warn per period at
 *     80% and at 100% of the daily/monthly budget.
 *   - `admitTurn` is the ONE store call per LLM-using customer turn: budget
 *     totals + the sender's rolling windows, counting the turn when allowed.
 *   - `llmAllowed` (one primary-key read) gates calls outside a turn
 *     (receipt vision, product photos, the RESTOCK classifier, ops resume);
 *     `llmAllowedNow` (no I/O) gates the extra calls inside an admitted turn.
 *
 * Every ledger failure fails OPEN for the customer and logs `error`.
 */
@Injectable()
export class CostGuardService {
  private readonly logger = new Logger(CostGuardService.name);
  readonly settings: Readonly<CostGuardSettings>;
  private readonly store?: LlmSpendStore;
  private readonly clock: () => Date;
  private aggregate = 0;
  private readonly pending = new Set<Promise<void>>();
  /** Period keys (`day:…` / `month:…`) this process saw spent. */
  private readonly spent = new Set<string>();

  /**
   * A bare number is the retired token ceiling (LLM_MONTHLY_TOKEN_CEILING),
   * still passed by older harnesses and scripts: it is ignored, and without
   * a store the guard allows everything and only counts tokens.
   */
  constructor(options: CostGuardOptions | number = {}) {
    const { store, clock, ...overrides } =
      typeof options === 'number' ? {} : options;
    this.settings = Object.freeze({
      ...DEFAULT_COST_GUARD_SETTINGS,
      ...Object.fromEntries(
        Object.entries(overrides).filter(([, value]) => value !== undefined),
      ),
    });
    for (const [name, value] of Object.entries(this.settings))
      if (!Number.isFinite(value) || value < 0)
        throw new Error(`CostGuardService: invalid ${name} ${value}`);
    this.store = store;
    this.clock = clock ?? (() => new Date());
  }

  /** Books one call. Never throws and never delays the caller. */
  record(
    usage: { promptTokens: number; completionTokens: number },
    source: LlmCallSource = 'agent_turn',
  ): void {
    const inputTokens = safeTokens(usage.promptTokens);
    const outputTokens = safeTokens(usage.completionTokens);
    this.aggregate += inputTokens + outputTokens;
    if (this.store === undefined) return;
    const write = this.persist(source, inputTokens, outputTokens);
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));
  }

  /** Waits for the ledger writes started so far (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /** Tokens booked by this process (diagnostics and tests). */
  get currentAggregate(): number {
    return this.aggregate;
  }

  /** No I/O: false once this process saw the current period spent. */
  llmAllowedNow(): boolean {
    return !this.spentNow(llmSpendPeriods(this.clock()));
  }

  /** One primary-key read of the period totals; fails open. */
  async llmAllowed(): Promise<boolean> {
    if (this.store === undefined) return true;
    const periods = llmSpendPeriods(this.clock());
    if (this.spentNow(periods)) return false;
    try {
      const totals = await this.store.totals(periods);
      this.noteTotals(periods, totals);
      return !this.spentNow(periods);
    } catch (error) {
      this.logger.error(
        `LLM spend ledger unreadable; allowing the call: ${describeError(error)}`,
      );
      return true;
    }
  }

  /** The single per-turn admission (budget + per-number limit); fails open. */
  async admitTurn(senderId: string): Promise<LlmTurnVerdict> {
    if (this.store === undefined) return { kind: 'allowed' };
    const at = this.clock();
    const periods = llmSpendPeriods(at);
    try {
      const verdict = await this.store.admitTurn({
        senderId,
        at,
        periods,
        caps: this.caps(),
        limits: {
          perHour: this.settings.senderLimitPerHour,
          perDay: this.settings.senderLimitPerDay,
        },
      });
      if (verdict.kind === 'budget_exhausted')
        this.spent.add(periodKey(verdict.period, periods));
      return verdict;
    } catch (error) {
      this.logger.error(
        `LLM turn admission failed; allowing the turn: ${describeError(error)}`,
      );
      return { kind: 'allowed' };
    }
  }

  private async persist(
    source: LlmCallSource,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    const at = this.clock();
    const periods = llmSpendPeriods(at);
    let result: LlmRecordResult;
    try {
      result = await this.store!.record({
        source,
        inputTokens,
        outputTokens,
        usd: estimateLlmUsd(
          { inputTokens, outputTokens },
          {
            inputUsdPerMtok: this.settings.priceInputUsdPerMtok,
            outputUsdPerMtok: this.settings.priceOutputUsdPerMtok,
          },
        ),
        at,
        periods,
        caps: this.caps(),
      });
    } catch (error) {
      this.logger.error(
        `LLM spend ledger write failed (${source}): ${describeError(error)}`,
      );
      return;
    }
    this.noteTotals(periods, result);
    const spentOf = (period: LlmBudgetPeriod) =>
      period === 'day' ? result.dayUsd : result.monthUsd;
    const capOf = (period: LlmBudgetPeriod) =>
      period === 'day'
        ? this.settings.dailyBudgetUsd
        : this.settings.monthlyBudgetUsd;
    for (const period of result.warned80)
      this.logger.warn(
        `LLM spend >=80% of the ${PERIOD_LABEL[period]} budget: $${spentOf(period).toFixed(4)} of $${capOf(period)} (${periods[period]})`,
      );
    for (const period of result.reached100)
      this.logger.warn(
        `LLM spend >=100% of the ${PERIOD_LABEL[period]} budget: $${spentOf(period).toFixed(4)} of $${capOf(period)} (${periods[period]}); no new LLM calls until the period ends`,
      );
  }

  private caps() {
    return {
      dayUsd: this.settings.dailyBudgetUsd,
      monthUsd: this.settings.monthlyBudgetUsd,
    };
  }

  private noteTotals(periods: LlmSpendPeriods, totals: LlmSpendTotals): void {
    if (totals.dayUsd >= this.settings.dailyBudgetUsd)
      this.spent.add(periodKey('day', periods));
    if (totals.monthUsd >= this.settings.monthlyBudgetUsd)
      this.spent.add(periodKey('month', periods));
  }

  private spentNow(periods: LlmSpendPeriods): boolean {
    return (
      this.spent.has(periodKey('day', periods)) ||
      this.spent.has(periodKey('month', periods))
    );
  }
}

const periodKey = (period: LlmBudgetPeriod, periods: LlmSpendPeriods) =>
  `${period}:${periods[period]}`;

const safeTokens = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;

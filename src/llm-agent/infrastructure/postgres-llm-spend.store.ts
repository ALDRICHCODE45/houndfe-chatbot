import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
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

/**
 * One call: the ledger row plus both period totals (upsert). The 80% / 100%
 * marks are set once per period inside the same upsert; `= now()` in
 * RETURNING tells whether THIS statement set them.
 */
const RECORD = `
WITH call AS (
  INSERT INTO llm_usage_ledger
    (created_at, source, input_tokens, output_tokens, usd, day_key)
  VALUES ($9::timestamptz, $1::text, $2::int, $3::int, $4::numeric, $10::text)
)
INSERT INTO llm_spend_periods AS p
  (period_key, usd, input_tokens, output_tokens, calls, cap_usd,
   warned_80_at, exhausted_at, updated_at)
VALUES
  ($5::text, $4::numeric, $2::bigint, $3::bigint, 1, $7::numeric,
   CASE WHEN $4::numeric >= 0.8 * $7::numeric THEN now() END,
   CASE WHEN $4::numeric >= $7::numeric THEN now() END, now()),
  ($6::text, $4::numeric, $2::bigint, $3::bigint, 1, $8::numeric,
   CASE WHEN $4::numeric >= 0.8 * $8::numeric THEN now() END,
   CASE WHEN $4::numeric >= $8::numeric THEN now() END, now())
ON CONFLICT (period_key) DO UPDATE SET
  usd = p.usd + EXCLUDED.usd,
  input_tokens = p.input_tokens + EXCLUDED.input_tokens,
  output_tokens = p.output_tokens + EXCLUDED.output_tokens,
  calls = p.calls + 1,
  cap_usd = EXCLUDED.cap_usd,
  warned_80_at = COALESCE(p.warned_80_at,
    CASE WHEN p.usd + EXCLUDED.usd >= 0.8 * EXCLUDED.cap_usd THEN now() END),
  exhausted_at = COALESCE(p.exhausted_at,
    CASE WHEN p.usd + EXCLUDED.usd >= EXCLUDED.cap_usd THEN now() END),
  updated_at = now()
RETURNING period_key, usd,
  (warned_80_at IS NOT NULL AND warned_80_at = now()) AS warned_now,
  (exhausted_at IS NOT NULL AND exhausted_at = now()) AS exhausted_now`;

const TOTALS = `
SELECT period_key, usd FROM llm_spend_periods WHERE period_key IN ($1, $2)`;

/**
 * The single per-turn admission (performance first): budget totals by
 * primary key, the sender's rolling hour/day by (sender_id, admitted_at),
 * then — in the same statement — count the turn when allowed (and reset the
 * limit notice), or claim the first notice when refused. Turns older than
 * 24 h of this sender are pruned on the way.
 */
const ADMIT = `
WITH spend AS (
  SELECT
    COALESCE(MAX(usd) FILTER (WHERE period_key = $3::text), 0) AS day_usd,
    COALESCE(MAX(usd) FILTER (WHERE period_key = $4::text), 0) AS month_usd
  FROM llm_spend_periods WHERE period_key IN ($3::text, $4::text)
), turns AS (
  SELECT
    COUNT(*) FILTER (
      WHERE admitted_at > $2::timestamptz - interval '1 hour') AS hour_count,
    COUNT(*) AS day_count
  FROM llm_sender_turns
  WHERE sender_id = $1::text
    AND admitted_at > $2::timestamptz - interval '24 hours'
), verdict AS (
  SELECT
    CASE WHEN spend.month_usd >= $6::numeric THEN 'month'
         WHEN spend.day_usd >= $5::numeric THEN 'day' END AS budget_period,
    CASE WHEN turns.hour_count >= $7::int THEN 'hour'
         WHEN turns.day_count >= $8::int THEN 'day' END AS limit_window
  FROM spend, turns
), admitted AS (
  INSERT INTO llm_sender_turns (sender_id, admitted_at)
  SELECT $1::text, $2::timestamptz FROM verdict
   WHERE budget_period IS NULL AND limit_window IS NULL
), pruned AS (
  DELETE FROM llm_sender_turns
   WHERE sender_id = $1::text
     AND admitted_at <= $2::timestamptz - interval '24 hours'
), cleared AS (
  DELETE FROM llm_guard_notices n USING verdict v
   WHERE n.sender_id = $1::text AND n.notice_key = '${SENDER_LIMIT_NOTICE_KEY}'
     AND v.budget_period IS NULL AND v.limit_window IS NULL
), noticed AS (
  INSERT INTO llm_guard_notices (sender_id, notice_key, created_at)
  SELECT $1::text,
         CASE v.budget_period WHEN 'month' THEN $10::text
                              WHEN 'day' THEN $9::text
                              ELSE '${SENDER_LIMIT_NOTICE_KEY}' END,
         $2::timestamptz
    FROM verdict v
   WHERE v.budget_period IS NOT NULL OR v.limit_window IS NOT NULL
  ON CONFLICT (sender_id, notice_key) DO NOTHING
  RETURNING 1
)
SELECT v.budget_period, v.limit_window,
       (SELECT count(*) FROM noticed)::int AS noticed
  FROM verdict v`;

interface AdmitRow {
  budget_period: LlmBudgetPeriod | null;
  limit_window: 'hour' | 'day' | null;
  noticed: number;
}

interface PeriodRow {
  period_key: string;
  usd: string | number;
  warned_now?: boolean;
  exhausted_now?: boolean;
}

/** LlmSpendStore over migration 5100 (llm_* tables). */
@Injectable()
export class PostgresLlmSpendStore implements LlmSpendStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(call: LlmCallRecord): Promise<LlmRecordResult> {
    const day = dayKey(call.periods);
    const month = monthKey(call.periods);
    const { rows } = await this.pool.query<PeriodRow>(RECORD, [
      call.source,
      Math.round(call.inputTokens),
      Math.round(call.outputTokens),
      call.usd,
      day,
      month,
      call.caps.dayUsd,
      call.caps.monthUsd,
      call.at.toISOString(),
      call.periods.day,
    ]);
    const result: LlmRecordResult = {
      ...totalsOf(rows, call.periods),
      warned80: [],
      reached100: [],
    };
    for (const row of rows) {
      const period: LlmBudgetPeriod = row.period_key === day ? 'day' : 'month';
      if (row.warned_now === true) result.warned80.push(period);
      if (row.exhausted_now === true) result.reached100.push(period);
    }
    const order = (list: LlmBudgetPeriod[]) =>
      list.sort((a, b) => (a === b ? 0 : a === 'day' ? -1 : 1));
    order(result.warned80);
    order(result.reached100);
    return result;
  }

  async totals(periods: LlmSpendPeriods): Promise<LlmSpendTotals> {
    const { rows } = await this.pool.query<PeriodRow>(TOTALS, [
      dayKey(periods),
      monthKey(periods),
    ]);
    return totalsOf(rows, periods);
  }

  async admitTurn(request: LlmTurnRequest): Promise<LlmTurnVerdict> {
    const { rows } = await this.pool.query<AdmitRow>(ADMIT, [
      request.senderId,
      request.at.toISOString(),
      dayKey(request.periods),
      monthKey(request.periods),
      request.caps.dayUsd,
      request.caps.monthUsd,
      request.limits.perHour,
      request.limits.perDay,
      budgetNoticeKey('day', request.periods),
      budgetNoticeKey('month', request.periods),
    ]);
    const row = rows[0];
    if (row === undefined)
      throw new Error('LLM turn admission returned no row');
    const firstNotice = Number(row.noticed) > 0;
    if (row.budget_period !== null)
      return {
        kind: 'budget_exhausted',
        period: row.budget_period,
        firstNotice,
      };
    if (row.limit_window !== null)
      return { kind: 'sender_limited', window: row.limit_window, firstNotice };
    return { kind: 'allowed' };
  }
}

function totalsOf(
  rows: readonly PeriodRow[],
  periods: LlmSpendPeriods,
): LlmSpendTotals {
  const usd = (key: string) => {
    const row = rows.find((candidate) => candidate.period_key === key);
    return row === undefined ? 0 : Number(row.usd);
  };
  return { dayUsd: usd(dayKey(periods)), monthUsd: usd(monthKey(periods)) };
}

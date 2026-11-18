/**
 * Cost protection phase 1 (odd/tasks/cost-and-abuse-phase1.md S2/S4/S5):
 * the pure rules of the persistent LLM spend cap and the per-number limit.
 *
 *   - Spend is booked per LLM call in USD = tokens × configured price per
 *     million tokens, summed per calendar day and month in
 *     America/Mexico_City.
 *   - Every LLM-using customer turn asks for ONE admission: the budget and
 *     the sender's rolling hour/day windows are read, and the turn is
 *     counted, in a single store call.
 */

/** Every production LLM call site. */
export type LlmCallSource =
  | 'agent_turn'
  | 'agent_retry'
  | 'agent_render'
  | 'restock_classifier'
  | 'receipt_vision'
  | 'product_image'
  | 'ops_resume';

export const LLM_CALL_SOURCES: readonly LlmCallSource[] = [
  'agent_turn',
  'agent_retry',
  'agent_render',
  'restock_classifier',
  'receipt_vision',
  'product_image',
  'ops_resume',
];

/** Calendar keys: day `YYYY-MM-DD`, month `YYYY-MM` (Mexico City). */
export interface LlmSpendPeriods {
  day: string;
  month: string;
}

export interface LlmBudgetCaps {
  dayUsd: number;
  monthUsd: number;
}

export interface LlmSenderLimits {
  perHour: number;
  perDay: number;
}

export interface LlmCallRecord {
  source: LlmCallSource;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  at: Date;
  periods: LlmSpendPeriods;
  caps: LlmBudgetCaps;
}

export interface LlmSpendTotals {
  dayUsd: number;
  monthUsd: number;
}

export type LlmBudgetPeriod = 'day' | 'month';

export interface LlmRecordResult extends LlmSpendTotals {
  /** Periods whose 80% threshold this call crossed (once per period). */
  warned80: LlmBudgetPeriod[];
  /** Periods whose cap this call reached (once per period). */
  reached100: LlmBudgetPeriod[];
}

export interface LlmTurnRequest {
  senderId: string;
  at: Date;
  periods: LlmSpendPeriods;
  caps: LlmBudgetCaps;
  limits: LlmSenderLimits;
}

export type LlmTurnVerdict =
  | { kind: 'allowed' }
  | {
      kind: 'budget_exhausted';
      period: LlmBudgetPeriod;
      /** First refusal for this sender in this period: notify the team. */
      firstNotice: boolean;
    }
  | {
      kind: 'sender_limited';
      window: 'hour' | 'day';
      /** First refusal since the sender was last served: reply + team. */
      firstNotice: boolean;
    };

/**
 * The shared ledger. `admitTurn` is the one per-turn read: budget totals by
 * primary key + the sender's rolling windows by (sender_id, admitted_at),
 * counting the turn only when it is allowed.
 */
export interface LlmSpendStore {
  record(call: LlmCallRecord): Promise<LlmRecordResult>;
  totals(periods: LlmSpendPeriods): Promise<LlmSpendTotals>;
  admitTurn(request: LlmTurnRequest): Promise<LlmTurnVerdict>;
  /**
   * Gives back a notice claimed by `admitTurn` (the team request it stood
   * for could not be created), so the next refusal is a first notice again.
   * Releasing a notice that is not claimed is a no-op.
   */
  releaseNotice(senderId: string, noticeKey: string): Promise<void>;
}

export const LLM_SPEND_STORE = Symbol('LLM_SPEND_STORE');

/** Store keys of a period and of the per-period budget notice. */
export const dayKey = (periods: LlmSpendPeriods) => `day:${periods.day}`;
export const monthKey = (periods: LlmSpendPeriods) => `month:${periods.month}`;
export const budgetNoticeKey = (
  period: LlmBudgetPeriod,
  periods: LlmSpendPeriods,
) => `budget:${period === 'day' ? dayKey(periods) : monthKey(periods)}`;
export const SENDER_LIMIT_NOTICE_KEY = 'sender_limit';

/** The notice key a refusal claimed; `null` for an allowed turn. */
export function noticeKeyOf(
  verdict: LlmTurnVerdict,
  periods: LlmSpendPeriods,
): string | null {
  switch (verdict.kind) {
    case 'allowed':
      return null;
    case 'budget_exhausted':
      return budgetNoticeKey(verdict.period, periods);
    case 'sender_limited':
      return SENDER_LIMIT_NOTICE_KEY;
  }
}

const MEXICO_CITY_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar day and month of `at` in America/Mexico_City. */
export function llmSpendPeriods(at: Date): LlmSpendPeriods {
  const parts = Object.fromEntries(
    MEXICO_CITY_DAY.formatToParts(at).map((part) => [part.type, part.value]),
  );
  const month = `${parts.year}-${parts.month}`;
  return { day: `${month}-${parts.day}`, month };
}

const tokens = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;

/** Estimated USD of one call from per-million-token prices. */
export function estimateLlmUsd(
  usage: { inputTokens: number; outputTokens: number },
  prices: { inputUsdPerMtok: number; outputUsdPerMtok: number },
): number {
  return (
    (tokens(usage.inputTokens) * prices.inputUsdPerMtok +
      tokens(usage.outputTokens) * prices.outputUsdPerMtok) /
    1_000_000
  );
}

/**
 * S4: customer text longer than `max` UTF-16 units is cut to it before any
 * LLM use, never leaving half of a surrogate pair (an emoji) at the end.
 */
export function capInboundText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** S2: budget spent (usd copy; tú pair in customer-style). */
export const LLM_BUDGET_EXHAUSTED_REPLY =
  'En este momento no puedo atenderle por aquí; ya le avisé al equipo y le escriben en cuanto puedan.';

/** S5: the first refusal of a rate-limited number (usted default). */
export const SENDER_LIMIT_REPLY =
  'Estamos revisando sus mensajes; en un momento le atiende alguien del equipo.';

/** Staff summaries of the team requests these refusals create. */
export function budgetTeamSummary(period: LlmBudgetPeriod): string {
  return `Se alcanzó el tope ${period === 'day' ? 'diario' : 'mensual'} de gasto del bot; el bot no puede atender a este cliente por ahora.`;
}

export function senderLimitTeamSummary(
  window: 'hour' | 'day',
  limits: LlmSenderLimits,
): string {
  return window === 'hour'
    ? `El número superó el límite de mensajes del bot (${limits.perHour} por hora); el bot dejó de responderle por ahora.`
    : `El número superó el límite de mensajes del bot (${limits.perDay} por día); el bot dejó de responderle por ahora.`;
}

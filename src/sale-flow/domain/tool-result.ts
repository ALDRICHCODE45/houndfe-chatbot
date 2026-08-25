/**
 * Stable error envelope every sale-flow tool returns on failure.
 *
 * The model must phrase a friendly reply from a small vocabulary; the
 * spec deep-equals these exact two-field shapes. `retryable: true` means
 * a transient backend / rate-limit issue — the model may retry; false
 * means the request is unfixable and the model should surface it to the
 * customer (or fall through to the refusal phrase).
 *
 * The eleven `kind` literals partition into two shapes:
 *   - The 10 "simple" kinds carry exactly `{ kind, retryable }`.
 *   - The `promoReQuote` kind carries the three numeric cents fields the
 *     model needs to re-confirm with the customer (Q2 / R13).
 * The discriminated union below encodes both shapes verbatim.
 */
export type ToolErrorKind =
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'rateLimit'
  | 'upstream'
  | 'validation'
  | 'noActivePaymentDetail'
  | 'promoReQuote'
  | 'idempotencyInFlight'
  | 'idempotencyConflict'
  | 'priceOutOfDate';

export interface SimpleToolError {
  kind: Exclude<ToolErrorKind, 'promoReQuote'>;
  retryable: boolean;
}

export interface PromoReQuoteToolError {
  kind: 'promoReQuote';
  retryable: false;
  recomputedTotalCents: number;
  expectedTotalCents: number;
  discountCents: number;
}

export type ToolError = SimpleToolError | PromoReQuoteToolError;

export interface ToolErrorResult {
  ok: false;
  error: ToolError;
}

export type ToolSuccess<T> = { ok: true } & T;
export type ToolResult<T> = ToolSuccess<T> | ToolErrorResult;

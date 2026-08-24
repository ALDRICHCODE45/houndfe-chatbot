/**
 * Stable error envelope every sale-flow tool returns on failure.
 *
 * The model must phrase a friendly reply from a small vocabulary; the
 * spec deep-equals these exact two-field shapes. `retryable: true` means
 * a transient backend / rate-limit issue — the model may retry; false
 * means the request is unfixable and the model should surface it to the
 * customer (or fall through to the refusal phrase).
 */
export type ToolErrorKind =
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'rateLimit'
  | 'upstream'
  | 'validation';

export interface ToolErrorResult {
  ok: false;
  error: { kind: ToolErrorKind; retryable: boolean };
}

export type ToolSuccess<T> = { ok: true } & T;
export type ToolResult<T> = ToolSuccess<T> | ToolErrorResult;

import {
  AuthError,
  ChatbotApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { mapChatbotError } from './error-mapping';

/**
 * Unit tests for the pinned error envelope mapping.
 *
 * Spec contract (deep-equal exact shapes):
 *   - AuthError(401)        -> { ok: false, error: { kind: 'auth',      retryable: false } }
 *   - ForbiddenError(403)   -> { ok: false, error: { kind: 'forbidden', retryable: false } }
 *   - NotFoundError(404)    -> { ok: false, error: { kind: 'notFound',  retryable: false } }
 *   - RateLimitError(429)   -> { ok: false, error: { kind: 'rateLimit', retryable: true  } }
 *   - UpstreamError(4xx)    -> { ok: false, error: { kind: 'validation',retryable: false } }
 *   - UpstreamError(5xx)    -> { ok: false, error: { kind: 'upstream',  retryable: true  } }
 *   - ChatbotApiError(4xx)  -> { ok: false, error: { kind: 'validation',retryable: false } }
 *   - ChatbotApiError(5xx)  -> { ok: false, error: { kind: 'upstream',  retryable: true  } }
 *   - Unknown / non-ChatbotApiError -> rethrow
 */
describe('mapChatbotError', () => {
  function apiError(
    statusCode: number | null,
    responseBody: unknown,
    errorCode: string | null,
  ): ChatbotApiError {
    return new ChatbotApiError('x', statusCode, responseBody, errorCode);
  }

  it('PROMO_RE_QUOTE (409 + well-formed payload) → {promoReQuote, retryable:false, 3 numeric fields}', () => {
    const err = apiError(
      409,
      {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      },
      'PROMO_RE_QUOTE',
    );
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: {
        kind: 'promoReQuote',
        retryable: false,
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      },
    });
  });

  it('NO_ACTIVE_PAYMENT_DETAIL (404) → {noActivePaymentDetail, false}', () => {
    const err = apiError(
      404,
      { error: 'NO_ACTIVE_PAYMENT_DETAIL' },
      'NO_ACTIVE_PAYMENT_DETAIL',
    );
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'noActivePaymentDetail', retryable: false },
    });
  });

  it('IDEMPOTENCY_KEY_IN_FLIGHT (409) → {idempotencyInFlight, true}', () => {
    const err = apiError(
      409,
      { error: 'IDEMPOTENCY_KEY_IN_FLIGHT' },
      'IDEMPOTENCY_KEY_IN_FLIGHT',
    );
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'idempotencyInFlight', retryable: true },
    });
  });

  it('IDEMPOTENCY_KEY_CONFLICT (409) → {idempotencyConflict, false}', () => {
    const err = apiError(
      409,
      { error: 'IDEMPOTENCY_KEY_CONFLICT' },
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'idempotencyConflict', retryable: false },
    });
  });

  it('PRICE_OUT_OF_DATE (409) → {priceOutOfDate, false}', () => {
    const err = apiError(
      409,
      { error: 'PRICE_OUT_OF_DATE' },
      'PRICE_OUT_OF_DATE',
    );
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'priceOutOfDate', retryable: false },
    });
  });

  it('INVALID_IDEMPOTENCY_KEY (400) → {validation, false}', () => {
    const err = apiError(
      400,
      { error: 'INVALID_IDEMPOTENCY_KEY' },
      'INVALID_IDEMPOTENCY_KEY',
    );
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
  });

  it('legacy backend: 422 with errorCode=null → {validation, false}', () => {
    const err = apiError(422, { message: 'Validation failed' }, null);
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
  });

  it('PROMO_RE_QUOTE with a malformed payload falls through to status mapping', () => {
    const err = apiError(
      409,
      { error: 'PROMO_RE_QUOTE', recomputedTotalCents: 'not-a-number' },
      'PROMO_RE_QUOTE',
    );
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
  });

  it('PROMO_RE_QUOTE with a missing payload falls through to status mapping', () => {
    const err = apiError(409, { error: 'PROMO_RE_QUOTE' }, 'PROMO_RE_QUOTE');
    expect(mapChatbotError(err)).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
  });

  it('rethrows a non-ChatbotApi error (BranchMismatchError etc.)', () => {
    class BranchMismatchError extends Error {}
    const err = new BranchMismatchError('boom');
    expect(() => mapChatbotError(err)).toThrow(BranchMismatchError);
  });

  it('rethrows a plain Error', () => {
    expect(() => mapChatbotError(new Error('boom'))).toThrow(Error);
  });

  it('maps AuthError to {auth, false}', () => {
    expect(mapChatbotError(new AuthError('x', 401))).toEqual({
      ok: false,
      error: { kind: 'auth', retryable: false },
    });
  });

  it('maps ForbiddenError to {forbidden, false}', () => {
    expect(mapChatbotError(new ForbiddenError('x', 403))).toEqual({
      ok: false,
      error: { kind: 'forbidden', retryable: false },
    });
  });

  it('maps NotFoundError to {notFound, false}', () => {
    expect(mapChatbotError(new NotFoundError('x', 404))).toEqual({
      ok: false,
      error: { kind: 'notFound', retryable: false },
    });
  });

  it('maps RateLimitError to {rateLimit, true}', () => {
    expect(mapChatbotError(new RateLimitError(30))).toEqual({
      ok: false,
      error: { kind: 'rateLimit', retryable: true },
    });
  });

  it('maps UpstreamError(400) to {validation, false}', () => {
    expect(mapChatbotError(new UpstreamError('bad', 400))).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
  });

  it('maps UpstreamError(422) to {validation, false}', () => {
    expect(mapChatbotError(new UpstreamError('bad', 422))).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
  });

  it('maps UpstreamError(500) to {upstream, true}', () => {
    expect(mapChatbotError(new UpstreamError('bad', 500))).toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });

  it('maps UpstreamError(503) to {upstream, true}', () => {
    expect(mapChatbotError(new UpstreamError('bad', 503))).toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });

  it('maps UpstreamError with null statusCode to {upstream, true} (network failure path)', () => {
    expect(mapChatbotError(new UpstreamError('boom', null))).toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });

  it('maps a generic ChatbotApiError(400) to {validation, false}', () => {
    expect(mapChatbotError(new ChatbotApiError('x', 400))).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
  });

  it('maps a generic ChatbotApiError(500) to {upstream, true}', () => {
    expect(mapChatbotError(new ChatbotApiError('x', 500))).toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });

  it('rethrows a non-ChatbotApi error (BranchMismatchError etc.)', () => {
    class BranchMismatchError extends Error {}
    const err = new BranchMismatchError('boom');
    expect(() => mapChatbotError(err)).toThrow(BranchMismatchError);
  });

  it('rethrows a plain Error', () => {
    expect(() => mapChatbotError(new Error('boom'))).toThrow(Error);
  });
});

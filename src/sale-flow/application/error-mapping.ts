import {
  AuthError,
  ChatbotApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
} from '../../chatbot-api/domain/errors';
import type { ToolErrorResult } from '../domain/tool-result';

/**
 * Read the three numeric cents fields off a PROMO_RE_QUOTE error body.
 * Returns `null` when any field is missing or not a non-negative integer,
 * so the caller can fall through to status mapping instead of fabricating
 * numbers (R-D2 / ADR-5).
 */
function readPromoPayload(err: ChatbotApiError): {
  recomputedTotalCents: number;
  expectedTotalCents: number;
  discountCents: number;
} | null {
  const body = err.responseBody;
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  const r = candidate.recomputedTotalCents;
  const e = candidate.expectedTotalCents;
  const d = candidate.discountCents;
  if (
    typeof r !== 'number' ||
    !Number.isInteger(r) ||
    r < 0 ||
    typeof e !== 'number' ||
    !Number.isInteger(e) ||
    e < 0 ||
    typeof d !== 'number' ||
    !Number.isInteger(d) ||
    d < 0
  ) {
    return null;
  }
  return { recomputedTotalCents: r, expectedTotalCents: e, discountCents: d };
}

/**
 * Map a thrown `ChatbotApiError` (or subclass) into the stable error envelope
 * tools return to the model.
 *
 * Contract (pinned by spec scenarios, errorCode-first per ADR-3):
 *
 *   errorCode === 'PROMO_RE_QUOTE' (409)         -> { promoReQuote, false, 3 cents }
 *   errorCode === 'NO_ACTIVE_PAYMENT_DETAIL' (404) -> { noActivePaymentDetail, false }
 *   errorCode === 'IDEMPOTENCY_KEY_IN_FLIGHT' (409) -> { idempotencyInFlight, true }
 *   errorCode === 'IDEMPOTENCY_KEY_CONFLICT' (409)  -> { idempotencyConflict, false }
 *   errorCode === 'PRICE_OUT_OF_DATE' (409)       -> { priceOutOfDate, false }
 *   errorCode === 'INVALID_IDEMPOTENCY_KEY' (400) -> { validation, false }
 *   errorCode === null (legacy) ->
 *      AuthError(401)         -> { auth,     false }
 *      ForbiddenError(403)    -> { forbidden, false }
 *      NotFoundError(404)     -> { notFound,  false }
 *      RateLimitError(429)    -> { rateLimit, true  }
 *      UpstreamError(4xx)     -> { validation,false }
 *      UpstreamError(5xx)     -> { upstream,  true  }
 *      UpstreamError(null)    -> { upstream,  true  }
 *      ChatbotApiError(4xx)   -> { validation,false }
 *      ChatbotApiError(5xx)   -> { upstream,  true  }
 *   anything else          -> rethrow (infra / config defect)
 */
export function mapChatbotError(err: unknown): ToolErrorResult {
  if (err instanceof ChatbotApiError) {
    // errorCode FIRST — a NO_ACTIVE_PAYMENT_DETAIL is a 404 (would map to
    // notFound via NotFoundError) and PROMO_RE_QUOTE is a 409 (would map
    // to validation via UpstreamError 4xx); the discriminator must win.
    switch (err.errorCode) {
      case 'PROMO_RE_QUOTE': {
        const payload = readPromoPayload(err);
        if (payload) {
          return {
            ok: false,
            error: {
              kind: 'promoReQuote',
              retryable: false,
              ...payload,
            },
          };
        }
        // Malformed payload — fall through to the status mapping.
        break;
      }
      case 'NO_ACTIVE_PAYMENT_DETAIL':
        return {
          ok: false,
          error: { kind: 'noActivePaymentDetail', retryable: false },
        };
      case 'IDEMPOTENCY_KEY_IN_FLIGHT':
        return {
          ok: false,
          error: { kind: 'idempotencyInFlight', retryable: true },
        };
      case 'IDEMPOTENCY_KEY_CONFLICT':
        return {
          ok: false,
          error: { kind: 'idempotencyConflict', retryable: false },
        };
      case 'PRICE_OUT_OF_DATE':
        return {
          ok: false,
          error: { kind: 'priceOutOfDate', retryable: false },
        };
      case 'INVALID_IDEMPOTENCY_KEY':
        return {
          ok: false,
          error: { kind: 'validation', retryable: false },
        };
      default:
        break;
    }
    // Subclass / status fallback (legacy backend without `errorCode`).
    if (err instanceof AuthError) {
      return { ok: false, error: { kind: 'auth', retryable: false } };
    }
    if (err instanceof ForbiddenError) {
      return { ok: false, error: { kind: 'forbidden', retryable: false } };
    }
    if (err instanceof NotFoundError) {
      return { ok: false, error: { kind: 'notFound', retryable: false } };
    }
    if (err instanceof RateLimitError) {
      return { ok: false, error: { kind: 'rateLimit', retryable: true } };
    }
    const status = err.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { ok: false, error: { kind: 'validation', retryable: false } };
    }
    return { ok: false, error: { kind: 'upstream', retryable: true } };
  }
  // BranchMismatchError, ConversationStore write failures, etc. — config /
  // infrastructure defect; do not paper over with a model-friendly envelope.
  throw err;
}

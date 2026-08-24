import {
  AuthError,
  ChatbotApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import type { ToolErrorResult } from '../domain/tool-result';

/**
 * Map a thrown `ChatbotApiError` (or subclass) into the stable two-field
 * error envelope tools return to the model.
 *
 * Contract (pinned by spec scenarios):
 *
 *   AuthError          -> { auth,     false }
 *   ForbiddenError     -> { forbidden, false }
 *   NotFoundError      -> { notFound,  false }
 *   RateLimitError     -> { rateLimit, true  }
 *   UpstreamError(4xx) -> { validation,false }   // bad payload / bad state
 *   UpstreamError(5xx) -> { upstream,  true  }
 *   UpstreamError(null)-> { upstream,  true  }   // network failure
 *   ChatbotApiError(4xx) -> { validation,false }
 *   ChatbotApiError(5xx) -> { upstream,  true  }
 *   anything else      -> rethrow                 // infra / config defect
 */
export function mapChatbotError(err: unknown): ToolErrorResult {
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
  if (err instanceof UpstreamError) {
    const status = err.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { ok: false, error: { kind: 'validation', retryable: false } };
    }
    // 5xx, null (network), or anything else upstream -> retryable upstream
    return { ok: false, error: { kind: 'upstream', retryable: true } };
  }
  if (err instanceof ChatbotApiError) {
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

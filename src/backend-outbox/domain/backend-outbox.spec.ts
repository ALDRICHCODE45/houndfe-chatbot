import {
  BACKEND_OUTBOX_KINDS,
  BACKOFF_MAX_MS,
  RETRY_AFTER_MAX_MS,
  backoffDelayMs,
  classifyBackendResponse,
  conversationRefFor,
  isConversationRef,
  laneForKind,
  parseRetryAfterMs,
} from './backend-outbox';

describe('laneForKind', () => {
  it('puts transcript facts in MIRROR and request/session facts in CONTROL', () => {
    expect(
      Object.fromEntries(BACKEND_OUTBOX_KINDS.map((k) => [k, laneForKind(k)])),
    ).toEqual({
      MESSAGE_MIRROR: 'MIRROR',
      MESSAGE_STATUS: 'MIRROR',
      REQUEST_CREATE: 'CONTROL',
      REQUEST_CANCEL: 'CONTROL',
      SESSION_ACK: 'CONTROL',
      DELIVERY_OUTCOME: 'CONTROL',
    });
  });

  it('throws on an unknown kind', () => {
    expect(() => laneForKind('NOPE' as never)).toThrow(RangeError);
  });
});

describe('backoffDelayMs', () => {
  it('doubles from ~1 s with equal jitter', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(500);
    expect(backoffDelayMs(1, () => 1)).toBe(1_000);
    expect(backoffDelayMs(2, () => 1)).toBe(2_000);
    expect(backoffDelayMs(4, () => 0.5)).toBe(6_000);
  });

  it('caps at 5 minutes for any attempt count', () => {
    expect(backoffDelayMs(9, () => 1)).toBe(256_000);
    expect(backoffDelayMs(10, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(10_000, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(10_000, () => 0)).toBe(BACKOFF_MAX_MS / 2);
  });
});

describe('classifyBackendResponse', () => {
  it('2xx and already-recorded 409s are delivered', () => {
    expect(classifyBackendResponse(201)).toEqual({ outcome: 'DELIVERED' });
    expect(
      classifyBackendResponse(409, { code: 'OUTCOME_ALREADY_RECORDED' }),
    ).toEqual({ outcome: 'DELIVERED' });
    expect(classifyBackendResponse(409, { code: 'ALREADY_RESOLVED' })).toEqual({
      outcome: 'DELIVERED',
    });
  });

  it('408, 429 and 5xx retry, honoring Retry-After', () => {
    expect(classifyBackendResponse(503)).toEqual({
      outcome: 'RETRY',
      error: '503',
    });
    expect(classifyBackendResponse(408).outcome).toBe('RETRY');
    expect(
      classifyBackendResponse(429, {
        code: 'RATE_LIMITED',
        retryAfter: '7',
      }),
    ).toEqual({
      outcome: 'RETRY',
      error: '429 RATE_LIMITED',
      retryAfterMs: 7_000,
    });
  });

  it('other 4xx (including conflicting 409s) are permanent', () => {
    expect(
      classifyBackendResponse(409, { code: 'IDEMPOTENCY_CONFLICT' }),
    ).toEqual({ outcome: 'PERMANENT', error: '409 IDEMPOTENCY_CONFLICT' });
    expect(classifyBackendResponse(400).outcome).toBe('PERMANENT');
    expect(classifyBackendResponse(404).outcome).toBe('PERMANENT');
  });
});

describe('parseRetryAfterMs', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');

  it('reads delta-seconds and HTTP dates, bounded', () => {
    expect(parseRetryAfterMs('3', now)).toBe(3_000);
    expect(parseRetryAfterMs('Mon, 09 Nov 2026 12:00:30 GMT', now)).toBe(
      30_000,
    );
    expect(parseRetryAfterMs('Mon, 09 Nov 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('999999', now)).toBe(RETRY_AFTER_MAX_MS);
  });

  it('ignores missing or malformed values', () => {
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs('', now)).toBeUndefined();
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
  });
});

describe('conversationRef', () => {
  it('is wa:<raw wa_id>', () => {
    expect(conversationRefFor('5215550001111')).toBe('wa:5215550001111');
    expect(isConversationRef('wa:5215550001111')).toBe(true);
    expect(isConversationRef('5215550001111')).toBe(false);
    expect(isConversationRef('wa:+52155')).toBe(false);
  });
});

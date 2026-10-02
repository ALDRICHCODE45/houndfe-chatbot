import type { Pool } from 'pg';
import type { ExpirationIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import { PostgresExpirationPostClaimStore } from './postgres-expiration-post-claim.store';

const SENDER = 'whatsapp:+5215500000001';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const UPPER = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
const DECISION = '99999999-9999-4999-8999-999999999999';
const attempt = new Date('2026-06-22T12:00:00.000Z');

const intake = (
  over: Partial<ExpirationIntakeInput> = {},
): ExpirationIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: null,
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  sender_id: SENDER,
  route: 'EXPIRATION',
  request_key: SOURCE,
  status: 'ACTIVE',
  post_state: 'RESERVED',
  intake: intake(),
  backend_decision_id: null,
  post_attempted_at: null,
  receipt_recorded_at: null,
  unknown_observed_at: null,
  ...over,
});
const one = (r: unknown) => ({ rows: [r], rowCount: 1 });
const empty = { rows: [], rowCount: 0 };

function store(query: jest.Mock) {
  return new PostgresExpirationPostClaimStore({
    query,
  } as unknown as Pool);
}
const expected = {
  senderId: SENDER,
  sourceRequestId: SOURCE,
  intake: intake(),
};

describe('PostgresExpirationPostClaimStore.preparePost (mock SQL, not PG proof)', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['missing key', { senderId: SENDER, sourceRequestId: SOURCE }],
    ['extra key', { ...expected, extra: 1 }],
    ['invalid source uuid', { ...expected, sourceRequestId: 'not-a-uuid' }],
    [
      'intake source mismatch',
      { ...expected, intake: intake({ sourceRequestId: OTHER }) },
    ],
    ['blank sender', { ...expected, senderId: '  ' }],
    [
      'intake extra key',
      {
        ...expected,
        intake: { ...intake(), extra: 1 } as unknown as ExpirationIntakeInput,
      },
    ],
  ])('fails closed on %s without querying', async (_name, input) => {
    const query = jest.fn();
    await expect(store(query).preparePost(input)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed on an accessor or throwing getter without reading it twice', async () => {
    const hostile = {
      ...expected,
      get intake() {
        return intake();
      },
    };
    const query = jest.fn();
    await expect(store(query).preparePost(hostile)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(query).not.toHaveBeenCalled();

    const throwing = {
      ...expected,
      get senderId(): string {
        throw new Error('private');
      },
    };
    await expect(store(query).preparePost(throwing)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['lowercase source', SOURCE],
    ['uppercase source (case preserved)', UPPER],
  ])(
    'prepares via one fenced CAS with exact %s bytes, never normalized',
    async (_name, source) => {
      const exact = intake({ sourceRequestId: source });
      const query = jest
        .fn()
        .mockResolvedValue(one(row({ request_key: source, intake: exact })));
      await expect(
        store(query).preparePost({
          senderId: SENDER,
          sourceRequestId: source,
          intake: exact,
        }),
      ).resolves.toEqual({ action: 'prepared' });
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("route = 'EXPIRATION'");
      expect(sql).toContain("status = 'ACTIVE'");
      expect(sql).toContain('post_state IS NULL');
      expect(sql).toContain('intake = $3::jsonb');
      expect(params).toEqual([SENDER, source, JSON.stringify(exact)]);
    },
  );

  it.each([
    ['wrong sender', { sender_id: 'whatsapp:+5200000000000' }],
    ['null state', { post_state: null }],
    ['substituted intake', { intake: intake({ productId: OTHER }) }],
  ])('throws on an unexpected CAS projection (%s)', async (_name, over) => {
    const query = jest.fn().mockResolvedValue(one(row(over)));
    await expect(store(query).preparePost(expected)).rejects.toThrow(
      'expiration prepare CAS returned an unexpected projection',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rowCount mismatch', { rows: [row()], rowCount: 0 }],
    ['two rows', { rows: [row(), row()], rowCount: 2 }],
    ['non-record row', { rows: [1], rowCount: 1 }],
  ])('throws on a driver anomaly (%s)', async (_name, result) => {
    const query = jest.fn().mockResolvedValue(result);
    await expect(store(query).preparePost(expected)).rejects.toThrow(
      'inconsistent expiration prepare read',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing_row', empty],
    ['unknown_row', one(row({ status: 'CLOSED' }))],
    ['unknown_row', one(row({ route: 'RESTOCK' }))],
    ['unknown_row', one(row({ post_state: 'POST_IN_FLIGHT' }))],
    ['unknown_row', one(row({ post_state: null }))],
    ['intake_mismatch', one(row({ intake: intake({ variantId: VARIANT }) }))],
  ])(
    'classifies a persisted zero-row re-read as %s',
    async (reason, result) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce(empty)
        .mockResolvedValueOnce(result);
      await expect(store(query).preparePost(expected)).resolves.toEqual({
        action: 'blocked',
        reason,
      });
      expect(query).toHaveBeenCalledTimes(2);
    },
  );

  it('reports an already-prepared row without re-authorizing or retrying', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(one(row({ post_state: 'RESERVED' })));
    await expect(store(query).preparePost(expected)).resolves.toEqual({
      action: 'already_prepared',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not retry a database error', async () => {
    const query = jest.fn().mockRejectedValue(new Error('private database'));
    await expect(store(query).preparePost(expected)).rejects.toThrow(
      'private database',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresExpirationPostClaimStore.beginPost (mock SQL, not PG proof)', () => {
  it.each([
    ['null', null],
    ['extra key', { ...expected, extra: 1 }],
    [
      'unbound intake',
      { ...expected, intake: intake({ sourceRequestId: OTHER }) },
    ],
  ])('fails closed on %s without querying', async (_name, value) => {
    const query = jest.fn();
    await expect(store(query).beginPost(value)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['lowercase source', SOURCE],
    ['uppercase source (case preserved)', UPPER],
  ])(
    'authorizes via one fenced CAS with exact %s bytes, never normalized',
    async (_name, source) => {
      const exact = intake({ sourceRequestId: source });
      const query = jest.fn().mockResolvedValue(
        one(
          row({
            request_key: source,
            intake: exact,
            post_state: 'POST_IN_FLIGHT',
            post_attempted_at: attempt,
          }),
        ),
      );
      await expect(
        store(query).beginPost({
          senderId: SENDER,
          sourceRequestId: source,
          intake: exact,
        }),
      ).resolves.toEqual({ action: 'authorize_post' });
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("route = 'EXPIRATION'");
      expect(sql).toContain("status = 'ACTIVE'");
      expect(sql).toContain("post_state = 'RESERVED'");
      expect(sql).toContain('intake = $3::jsonb');
      expect(sql).toContain('backend_decision_id IS NULL');
      expect(sql).toContain('post_attempted_at IS NULL');
      expect(sql).toContain('receipt_recorded_at IS NULL');
      expect(sql).toContain('unknown_observed_at IS NULL');
      expect(params).toEqual([SENDER, source, JSON.stringify(exact)]);
    },
  );

  it.each([
    ['wrong sender', { sender_id: 'whatsapp:+5200000000000' }],
    ['wrong key', { request_key: OTHER }],
    ['null state', { post_state: null }],
    ['wrong state', { post_state: 'RESERVED' }],
    ['substituted intake', { intake: intake({ productId: OTHER }) }],
    ['null attempt timestamp', { post_attempted_at: null }],
    ['invalid attempt timestamp', { post_attempted_at: new Date(Number.NaN) }],
    ['leftover backend id', { backend_decision_id: DECISION }],
    ['leftover receipt timestamp', { receipt_recorded_at: attempt }],
    ['leftover unknown timestamp', { unknown_observed_at: attempt }],
  ])('throws on an unexpected CAS projection (%s)', async (_name, over) => {
    const query = jest.fn().mockResolvedValue(
      one(
        row({
          post_state: 'POST_IN_FLIGHT',
          post_attempted_at: attempt,
          ...over,
        }),
      ),
    );
    await expect(store(query).beginPost(expected)).rejects.toThrow(
      'expiration begin CAS returned an unexpected projection',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throws on an ambiguous read and never retries a database error', async () => {
    const anomaly = jest.fn().mockResolvedValue({ rows: [row()], rowCount: 0 });
    await expect(store(anomaly).beginPost(expected)).rejects.toThrow(
      'inconsistent expiration prepare read',
    );
    expect(anomaly).toHaveBeenCalledTimes(1);
    const failing = jest.fn().mockRejectedValue(new Error('private database'));
    await expect(store(failing).beginPost(expected)).rejects.toThrow(
      'private database',
    );
    expect(failing).toHaveBeenCalledTimes(1);
  });

  const state = (post_state: unknown, over: Record<string, unknown> = {}) =>
    one(row({ post_state, ...over }));
  it.each([
    ['missing_row', empty, { action: 'blocked', reason: 'missing_row' }],
    ['unprepared', state(null), { action: 'blocked', reason: 'malformed_row' }],
    [
      'closed',
      one(row({ status: 'CLOSED' })),
      { action: 'blocked', reason: 'unknown_row' },
    ],
    [
      'intake',
      one(row({ intake: intake({ variantId: VARIANT }) })),
      { action: 'blocked', reason: 'intake_mismatch' },
    ],
    [
      'in flight',
      state('POST_IN_FLIGHT', { post_attempted_at: attempt }),
      { action: 'hold', reason: 'post_in_flight' },
    ],
    [
      'unknown',
      state('UNKNOWN', { unknown_observed_at: attempt }),
      { action: 'hold', reason: 'unknown_state' },
    ],
    [
      'historical',
      state('RECEIPT_RECORDED', {
        backend_decision_id: DECISION,
        post_attempted_at: attempt,
        receipt_recorded_at: attempt,
      }),
      { action: 'historical_receipt', backendDecisionId: DECISION },
    ],
    [
      'still reserved',
      state('RESERVED'),
      { action: 'blocked', reason: 'unknown_state' },
    ],
  ])(
    'classifies a persisted zero-row re-read as %s',
    async (_name, result, expectedDecision) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce(empty)
        .mockResolvedValueOnce(result);
      await expect(store(query).beginPost(expected)).resolves.toEqual(
        expectedDecision,
      );
      expect(query).toHaveBeenCalledTimes(2);
    },
  );
});

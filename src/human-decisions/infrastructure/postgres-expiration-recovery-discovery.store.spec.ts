import type { Pool } from 'pg';
import {
  PostgresExpirationRecoveryDiscoveryStore,
  type ExpirationRecoveryDiscoveryQuery,
} from './postgres-expiration-recovery-discovery.store';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const NIL = '00000000-0000-0000-0000-000000000000';
const CURSOR = '00000000-0000-4000-8000-000000000000';
const FIRST = `SELECT sender_id, request_key FROM human_decision_reservations WHERE route = 'EXPIRATION' AND status = 'ACTIVE' AND post_state = 'RECEIPT_RECORDED' ORDER BY request_key LIMIT $1`;
const NEXT = `SELECT sender_id, request_key FROM human_decision_reservations WHERE route = 'EXPIRATION' AND status = 'ACTIVE' AND post_state = 'RECEIPT_RECORDED' AND request_key > $2 ORDER BY request_key LIMIT $1`;
const hint = (senderId: string, requestKey: string) => ({
  sender_id: senderId,
  request_key: requestKey,
});

function setup(rows: unknown[] = [], rowCount: unknown = rows.length) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount });
  const store = new PostgresExpirationRecoveryDiscoveryStore({
    query,
  } as Pick<Pool, 'query'>);
  return {
    query,
    discover: (input?: ExpirationRecoveryDiscoveryQuery) =>
      store.discoverRecordedHints(input),
  };
}

describe('EXPIRATION recovery discovery (read-only)', () => {
  it('returns a frozen first page through one exact keyset SELECT', async () => {
    const { query, discover } = setup([hint('sender-a', A)], 1);
    const result = await discover({ limit: 10 });
    expect(result).toEqual({
      action: 'page',
      hints: [{ senderId: 'sender-a', requestKey: A }],
      nextCursor: null,
    });
    expect(query.mock.calls).toEqual([[FIRST, [11]]]);
    if (result.action !== 'page') throw new Error('expected a page');
    expect(Object.isFrozen(result.hints[0])).toBe(true);
    expect(Object.isFrozen(result.hints)).toBe(true);
  });

  it('resumes from an exclusive request_key cursor with LIMIT limit + 1', async () => {
    const { query, discover } = setup(
      [hint('a', A), hint('b', B), hint('c', C)],
      3,
    );
    await expect(
      discover({
        limit: 2,
        afterRequestKey: CURSOR,
      }),
    ).resolves.toEqual({
      action: 'page',
      hints: [
        { senderId: 'a', requestKey: A },
        { senderId: 'b', requestKey: B },
      ],
      nextCursor: B,
    });
    expect(query.mock.calls).toEqual([[NEXT, [3, CURSOR]]]);
  });

  it.each([
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { limit: null },
    { afterRequestKey: 'nope' },
    { afterRequestKey: NIL },
  ])('holds invalid input %j without any I/O', async (input) => {
    const { query, discover } = setup();
    await expect(
      discover(input as unknown as ExpirationRecoveryDiscoveryQuery),
    ).resolves.toEqual({ action: 'hold' });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    [hint('sender', 'not-a-uuid')],
    [hint('sender', NIL)],
    [hint('', A)],
    [hint('  padded', A)],
    [hint(42 as unknown as string, A)],
    [Object.assign(Object.create({}) as object, hint('sender', A))],
    [null],
  ])('holds a corrupt row %# instead of emitting a hint', async (row) => {
    await expect(setup([row], 1).discover()).resolves.toEqual({
      action: 'hold',
    });
  });

  it.each([
    [[], 1],
    [[hint('a', A)], 0],
    [[hint('a', A), hint('b', B)], 1],
    [[hint('a', A), hint('b', B), hint('a', A), hint('c', C)], 4],
    [null, 0],
  ])('throws on inconsistent driver result %#', async (rows, count) => {
    await expect(
      setup(rows as unknown[], count).discover({ limit: 2 }),
    ).rejects.toThrow('inconsistent');
  });

  it('returns an empty terminal page and leaves SQL failures untouched', async () => {
    await expect(setup([], 0).discover()).resolves.toEqual({
      action: 'page',
      hints: [],
      nextCursor: null,
    });
    const { query, discover } = setup();
    const failure = new Error('database unavailable');
    query.mockRejectedValue(failure);
    await expect(discover()).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

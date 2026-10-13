import { Pool, type PoolConfig, type QueryResult } from 'pg';
import type { ConversationStore } from '../domain/conversation-store';
import { PostgresConversationStore } from './postgres-conversation.store';
import {
  CHECKOUT_SENDER,
  CHECKOUT_TIME,
  checkoutDraft,
  runMinimalCheckoutDraftStoreContract,
} from './minimal-checkout-draft-store.contract';

/**
 * T2B2 — PostgreSQL checkout-draft persistence.
 *
 * Two surfaces, deliberately separated:
 *   1. Offline query seam: the public adapter method, one parameterized
 *      guarded statement, invalid/conflict/non-comparable fail-closed paths.
 *      No database, no connection, no Docker.
 *   2. Gated disposable PostgreSQL proof: the SAME reusable public contract
 *      from B1 plus restart, competing-CAS and forced stale-update race proof.
 *      Runs only when the parent supplies RUN_CHECKOUT_DRAFT_DB_TESTS=1 and a
 *      CHECKOUT_TEST_PG_PORT for its own newly-created disposable container.
 *      This file never starts, inspects or tears down a container itself.
 */

const LATER = '2026-10-13T11:00:00.000Z';
const CART = { items: [], idempotencyKey: '', expectedTotalCents: 0 };
const POINTER = {
  receiptMediaId: 'receipt-a',
  saleId: 'sale-a',
  receiptVersion: '9007199254740993',
};

/** The port with the optional checkout capability narrowed to required. */
type CheckoutCapable = ConversationStore &
  Required<Pick<ConversationStore, 'commitMinimalCheckoutDraft'>>;

/**
 * Capability claim, never a stub. Before the adapter grew the member the cast
 * compiled but the call failed naturally with a TypeError; with the member
 * present the same narrowing is plain assignability, so a future removal stops
 * the suite from compiling instead of silently degrading.
 */
function asCheckout(store: PostgresConversationStore): CheckoutCapable {
  return store;
}

const commitDraft = (
  store: CheckoutCapable,
  expected: unknown,
  next: unknown,
  time: string,
  sender: string,
): Promise<boolean> =>
  store.commitMinimalCheckoutDraft(sender, expected, next, time);

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** Records the exact statements/bindings the public adapter sends. */
class QuerySeam {
  readonly calls: RecordedQuery[] = [];
  private index = 0;

  constructor(
    private readonly results: Array<{ rows: unknown[]; rowCount: number }>,
  ) {}

  query(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ sql, params });
    const result = this.results[this.index] ?? { rows: [], rowCount: 0 };
    this.index += 1;
    return Promise.resolve(result);
  }

  store(): PostgresConversationStore {
    return new PostgresConversationStore(this as unknown as Pool);
  }

  get sql(): string {
    return this.calls[0].sql;
  }

  get params(): unknown[] {
    return this.calls[0].params;
  }
}

const rowFixture = (data: Record<string, unknown>) => ({
  sender_id: CHECKOUT_SENDER,
  last_message_at: new Date(CHECKOUT_TIME),
  data,
});

describe('PostgresConversationStore checkout draft SQL seam (offline)', () => {
  it('absent expectation uses one guarded first-contact UPSERT', async () => {
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    const draft = checkoutDraft();
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        undefined,
        draft,
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    expect(seam.calls).toHaveLength(1);
    const { sql, params } = seam.calls[0];
    expect(sql).toMatch(/^\s*INSERT INTO conversation_state\b/i);
    expect(sql).toMatch(/ON CONFLICT \(sender_id\) DO UPDATE/i);
    expect(sql).toContain(
      "NOT (conversation_state.data ? 'minimalCheckoutDraft')",
    );
    expect(sql).toContain(
      "jsonb_build_object('minimalCheckoutDraft', $3::jsonb)",
    );
    expect(sql).toContain('data = conversation_state.data ||');
    expect(sql).toContain(
      'GREATEST(conversation_state.last_message_at, $2::timestamptz)',
    );
    expect(sql).not.toMatch(/\bSELECT\b/i);
    expect(params).toHaveLength(3);
    expect(params[0]).toBe(CHECKOUT_SENDER);
    expect(params[1]).toBe(CHECKOUT_TIME);
    expect(typeof params[2]).toBe('string');
    expect(JSON.parse(params[2] as string)).toEqual(draft);
  });

  it('present expectation uses UPDATE-only with the raw expected binding', async () => {
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        checkoutDraft(),
        checkoutDraft(1),
        LATER,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    expect(seam.calls).toHaveLength(1);
    const { sql, params } = seam.calls[0];
    expect(sql).toMatch(/^\s*UPDATE conversation_state\b/i);
    expect(sql).not.toMatch(/INSERT|ON\s+CONFLICT/i);
    expect(sql).toContain(
      "conversation_state.data->'minimalCheckoutDraft' = $4::jsonb",
    );
    // A present expectation never takes the first-contact UPSERT branch.
    expect(sql).not.toContain(
      "NOT (conversation_state.data ? 'minimalCheckoutDraft')",
    );
    expect(params).toHaveLength(4);
    expect(params[0]).toBe(CHECKOUT_SENDER);
    expect(params[1]).toBe(LATER);
    expect(sql).toContain('WHERE sender_id = $1');
    expect(params[3]).toBe(JSON.stringify(checkoutDraft()));
    expect(JSON.parse(params[2] as string)).toEqual(checkoutDraft(1));
  });

  it.each([
    [1, true],
    [0, false],
  ] as const)(
    'maps rowCount %i to %s with a single statement and no retry',
    async (rowCount, expected) => {
      const seam = new QuerySeam([
        { rows: [], rowCount },
        { rows: [], rowCount },
      ]);
      const store = asCheckout(seam.store());
      expect(
        await commitDraft(
          store,
          undefined,
          checkoutDraft(),
          CHECKOUT_TIME,
          CHECKOUT_SENDER,
        ),
      ).toBe(expected);
      expect(
        await commitDraft(
          store,
          checkoutDraft(),
          checkoutDraft(1),
          CHECKOUT_TIME,
          CHECKOUT_SENDER,
        ),
      ).toBe(expected);
      expect(seam.calls).toHaveLength(2);
    },
  );

  it('compares a corrupt raw expected slot verbatim without normalizing it', async () => {
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    const corrupt = { corrupt: true };
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        corrupt,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    expect(seam.calls[0].params[3]).toBe('{"corrupt":true}');
  });

  it('accepts JSON null as a present comparable expectation, not absence', async () => {
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        null,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    expect(seam.calls).toHaveLength(1);
    expect(seam.calls[0].sql).toContain(
      "conversation_state.data->'minimalCheckoutDraft' = $4::jsonb",
    );
    expect(seam.calls[0].params[3]).toBe('null');
  });

  it('detaches the committed draft from later caller mutations', async () => {
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    const draft = checkoutDraft();
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        undefined,
        draft,
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    draft.customer.firstName = 'caller mutation';
    draft.revision = 42;
    expect(JSON.parse(seam.calls[0].params[2] as string)).toEqual(
      checkoutDraft(),
    );
  });

  it.each([
    ['null next', CHECKOUT_SENDER, undefined, null, CHECKOUT_TIME],
    ['empty object next', CHECKOUT_SENDER, undefined, {}, CHECKOUT_TIME],
    [
      'foreign sender-bound next',
      CHECKOUT_SENDER,
      undefined,
      { ...checkoutDraft(), senderId: '5215599999999' },
      CHECKOUT_TIME,
    ],
    [
      'own-undefined next',
      CHECKOUT_SENDER,
      undefined,
      { ...checkoutDraft(), customer: undefined },
      CHECKOUT_TIME,
    ],
    ['blank sender', '', undefined, checkoutDraft(), CHECKOUT_TIME],
    ['blank timestamp', CHECKOUT_SENDER, undefined, checkoutDraft(), ''],
    [
      'whitespace timestamp',
      CHECKOUT_SENDER,
      undefined,
      checkoutDraft(),
      '   ',
    ],
    [
      'unparseable timestamp',
      CHECKOUT_SENDER,
      undefined,
      checkoutDraft(),
      'not-a-time',
    ],
  ] as const)(
    'rejects %s before any query and cannot create a row',
    async (_label, sender, expected, next, time) => {
      const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
      expect(
        await commitDraft(
          asCheckout(seam.store()),
          expected,
          next,
          time,
          sender,
        ),
      ).toBe(false);
      expect(seam.calls).toHaveLength(0);
    },
  );

  it.each([
    ['bigint', 9007199254740993n],
    ['function', () => 'expected'],
    ['symbol', Symbol('expected')],
    ['nested undefined', { revision: 0, extra: undefined }],
    ['NaN', { revision: Number.NaN }],
    ['Infinity', { revision: Number.POSITIVE_INFINITY }],
    ['Date object', new Date(CHECKOUT_TIME)],
    [
      'class instance',
      new (class Draftish {
        readonly revision = 0;
      })(),
    ],
    [
      'circular',
      (() => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        return cycle;
      })(),
    ],
  ] as const)(
    'fails closed on non-comparable expected value %s without querying',
    async (_label, expected) => {
      const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
      expect(
        await commitDraft(
          asCheckout(seam.store()),
          expected,
          checkoutDraft(),
          CHECKOUT_TIME,
          CHECKOUT_SENDER,
        ),
      ).toBe(false);
      expect(seam.calls).toHaveLength(0);
    },
  );

  // The existing lossless / fail-closed rule, exercised through the PUBLIC
  // method on documents whose JSON projection is NOT the caller's raw value.
  it.each([
    [
      'array hole',
      (() => {
        const sparse: unknown[] = new Array(2);
        sparse[1] = 'raw';
        return sparse;
      })(),
    ],
    [
      'array extra own property',
      (() => {
        const withExtra: unknown[] = ['raw'];
        (withExtra as unknown as Record<string, unknown>).extra = 'dropped';
        return withExtra;
      })(),
    ],
    [
      'array symbol own property',
      (() => {
        const withSymbol: unknown[] = ['raw'];
        Object.defineProperty(withSymbol, Symbol('dropped'), {
          enumerable: true,
          value: 'x',
        });
        return withSymbol;
      })(),
    ],
    [
      'non-enumerable object property',
      Object.defineProperty({ revision: 0 }, 'hidden', {
        enumerable: false,
        value: 'dropped',
      }),
    ],
  ] as const)(
    'refuses the non-lossless expected document %s without querying',
    async (_label, expected) => {
      const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
      expect(
        await commitDraft(
          asCheckout(seam.store()),
          expected,
          checkoutDraft(),
          CHECKOUT_TIME,
          CHECKOUT_SENDER,
        ),
      ).toBe(false);
      expect(seam.calls).toHaveLength(0);
    },
  );

  it('refuses an array subclass whose inherited toJSON would rewrite the document', async () => {
    const toJSONSpy = jest.fn(() => '{"revision":99}');
    class ToJsonArray extends Array<unknown> {
      toJSON(): unknown {
        return toJSONSpy();
      }
    }
    const hostile = new ToJsonArray();
    hostile.push({ revision: 0 }, 'raw');
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        hostile,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(false);
    expect(toJSONSpy).not.toHaveBeenCalled();
    expect(seam.calls).toHaveLength(0);
  });

  it('refuses an indexed accessor array without invoking its getter', async () => {
    const read = jest.fn(() => checkoutDraft());
    const expected: unknown[] = Object.defineProperty(['raw'], '0', {
      enumerable: true,
      get: read,
    });
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        expected,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(seam.calls).toHaveLength(0);
  });

  it('compares an acyclic shared-reference document by value, not as a cycle', async () => {
    const shared = checkoutDraft(3);
    const expected = { a: shared, b: shared };
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        expected,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    expect(seam.calls[0].params[3]).toBe(JSON.stringify(expected));
  });

  it('binds the captured document of a transparent proxy, never a later read', async () => {
    let reads = 0;
    const target = { revision: 0, schemaVersion: 1 };
    const proxy = new Proxy(target, {
      get(received, key): unknown {
        if (key === 'revision') {
          reads += 1;
        }
        const value: unknown = Reflect.get(received, key);
        return value;
      },
    });
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        proxy,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    expect(reads).toBe(0);
    target.revision = 5;
    expect(seam.calls[0].params[3]).toBe('{"revision":0,"schemaVersion":1}');
  });

  it('returns false for a revoked proxy instead of rejecting', async () => {
    const revoked = Proxy.revocable({ a: 1 }, {});
    revoked.revoke();
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    await expect(
      commitDraft(
        asCheckout(seam.store()),
        revoked.proxy,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).resolves.toBe(false);
    expect(seam.calls).toHaveLength(0);
  });

  it('compares a corrupt JSON array slot verbatim, like the memory adapter', async () => {
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    const corrupt = [checkoutDraft(7), null, 3, 'raw'];
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        corrupt,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(true);
    expect(seam.calls[0].params[3]).toBe(JSON.stringify(corrupt));
  });

  it('fails closed on an accessor expected slot without reading it', async () => {
    const read = jest.fn(() => checkoutDraft());
    const expected = Object.defineProperty({}, 'revision', {
      enumerable: true,
      get: read,
    });
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    expect(
      await commitDraft(
        asCheckout(seam.store()),
        expected,
        checkoutDraft(),
        CHECKOUT_TIME,
        CHECKOUT_SENDER,
      ),
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(seam.calls).toHaveLength(0);
  });

  it('keeps every other owned key out of the checkout statement', async () => {
    const seam = new QuerySeam([{ rows: [], rowCount: 1 }]);
    await commitDraft(
      asCheckout(seam.store()),
      undefined,
      checkoutDraft(),
      CHECKOUT_TIME,
      CHECKOUT_SENDER,
    );
    await commitDraft(
      asCheckout(seam.store()),
      checkoutDraft(),
      checkoutDraft(1),
      CHECKOUT_TIME,
      CHECKOUT_SENDER,
    );
    for (const call of seam.calls) {
      expect(call.sql).not.toMatch(
        /minimalCart|receiptAmountPointer|pendingHumanRequest|agentRevision|shippingApproval/,
      );
    }
  });

  it('generic update strips the incoming checkout draft from the row payload', async () => {
    const live = rowFixture({
      sibling: 'live',
      minimalCheckoutDraft: checkoutDraft(),
      minimalCart: CART,
      receiptAmountPointer: POINTER,
      pendingHumanRequest: null,
    });
    const seam = new QuerySeam([
      { rows: [live], rowCount: 1 },
      { rows: [live], rowCount: 1 },
    ]);
    await seam.store().update(CHECKOUT_SENDER, {
      lastMessageAt: LATER,
      data: {
        sibling: 'patched',
        minimalCheckoutDraft: checkoutDraft(9),
        minimalCart: { ...CART, expectedTotalCents: 1 },
      },
    });
    expect(seam.calls).toHaveLength(2);
    const { sql, params } = seam.calls[1];
    const sent = JSON.parse(params[2] as string) as Record<string, unknown>;
    expect(Object.hasOwn(sent, 'minimalCheckoutDraft')).toBe(false);
    expect(sent.sibling).toBe('patched');
    // Pre-existing carve-outs stay carved out.
    expect(Object.hasOwn(sent, 'minimalCart')).toBe(false);
    expect(Object.hasOwn(sent, 'receiptAmountPointer')).toBe(false);
    expect(Object.hasOwn(sent, 'pendingHumanRequest')).toBe(false);
    expect(sql).toMatch(/WHERE key IN \([^)]*'minimalCheckoutDraft'[^)]*\)/);
    expect(sql).toMatch(/WHERE key IN \([^)]*'minimalCart'[^)]*\)/);
    expect(sql).toMatch(/-\s*'receiptAmountPointer'/);
    expect(sql).toMatch(/jsonb_build_object\(\s*'pendingHumanRequest'/);
  });

  it('generic update cannot insert a checkout draft on a first-contact row', async () => {
    const created = rowFixture({ sibling: 'patched' });
    const seam = new QuerySeam([
      { rows: [], rowCount: 0 },
      { rows: [created], rowCount: 1 },
    ]);
    const returned = await seam.store().update(CHECKOUT_SENDER, {
      lastMessageAt: CHECKOUT_TIME,
      data: { sibling: 'patched', minimalCheckoutDraft: checkoutDraft() },
    });
    const sent = JSON.parse(seam.calls[1].params[2] as string) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(sent, 'minimalCheckoutDraft')).toBe(false);
    expect(returned.data.sibling).toBe('patched');
  });

  it('generic update re-applies the live draft under the row lock, not the read one', async () => {
    // The app-side read is deliberately stale (revision 0); the SQL must
    // re-read the owned key from the locked row (conversation_state.data).
    const staleRead = rowFixture({
      sibling: 'live',
      minimalCheckoutDraft: checkoutDraft(),
    });
    const seam = new QuerySeam([
      { rows: [staleRead], rowCount: 1 },
      { rows: [staleRead], rowCount: 1 },
    ]);
    await seam
      .store()
      .update(CHECKOUT_SENDER, { data: { sibling: 'patched' } });
    const { sql } = seam.calls[1];
    expect(sql).toContain('jsonb_each(conversation_state.data)');
    expect(sql).toMatch(/WHERE key IN \([^)]*'minimalCheckoutDraft'[^)]*\)/);
    // No app-side compare-and-set or retry loop for the owned key.
    expect(seam.calls).toHaveLength(2);
  });
});

const DB_GATE_ENV = 'RUN_CHECKOUT_DRAFT_DB_TESTS';
const DB_PORT_ENV = 'CHECKOUT_TEST_PG_PORT';

/** The generic update() existing-row read: the only statement the seam holds. */
const UPDATE_READ_SQL =
  /^\s*SELECT\s+sender_id, last_message_at, data FROM conversation_state\b/i;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Manual barrier for deterministic interleaving; never a timed sleep. */
function deferred<T>(): Deferred<T> {
  let capturedResolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolved) => {
    capturedResolve = resolved;
  });
  return { promise, resolve: (value) => capturedResolve(value) };
}

type RaceQuery = (sql: string, params: unknown[]) => Promise<QueryResult>;

/** Shared by offline lifecycle probes and the real stale-read interleaving. */
async function runStaleUpdateRace(
  query: RaceQuery,
  afterRead: (captured: QueryResult) => Promise<void>,
  cleanup: () => Promise<void>,
  readPattern = UPDATE_READ_SQL,
): Promise<Awaited<ReturnType<PostgresConversationStore['update']>>> {
  const readCompleted = deferred<QueryResult>();
  const releaseRead = deferred<void>();
  const seam = {
    async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
      if (readPattern.test(sql)) {
        const result = await query(sql, params);
        readCompleted.resolve(result);
        await releaseRead.promise;
        return result;
      }
      return query(sql, params);
    },
  };
  const racer = new PostgresConversationStore(seam as unknown as Pool);
  let racing: ReturnType<PostgresConversationStore['update']> | undefined;
  try {
    racing = racer.update(CHECKOUT_SENDER, {
      data: {
        sibling: 'from-stale-read',
        minimalCheckoutDraft: checkoutDraft(9),
      },
    });
    // Observe the update immediately: a failed SELECT or a missed matcher
    // must reject this wait so finally releases/settles before closing pools.
    const captured = await Promise.race([
      readCompleted.promise,
      racing.then(() => {
        throw new Error(
          'Generic update completed without reaching the read barrier',
        );
      }),
    ]);
    await afterRead(captured);
    releaseRead.resolve();
    return await racing;
  } finally {
    releaseRead.resolve();
    if (racing !== undefined) {
      await racing.catch(() => undefined);
    }
    await cleanup();
  }
}

describe('Checkout stale-read barrier lifecycle (offline)', () => {
  const result = (revision: number): QueryResult => ({
    rows: [
      rowFixture({
        sibling: 'from-stale-read',
        minimalCheckoutDraft: checkoutDraft(revision),
      }),
    ],
    rowCount: 1,
    command: 'SELECT',
    oid: 0,
    fields: [],
  });

  it('propagates a failed public update SELECT and cleans up without a timeout', async () => {
    const failure = new Error('forced SELECT failure');
    const query = jest.fn<ReturnType<RaceQuery>, Parameters<RaceQuery>>();
    query.mockRejectedValue(failure);
    const afterRead = jest.fn(async () => undefined);
    const cleanup = jest.fn(async () => undefined);
    const failures: unknown[] = [];
    const completed = runStaleUpdateRace(query, afterRead, cleanup).catch(
      (error: unknown) => failures.push(error),
    );
    // One event-loop turn flushes the immediately rejected query chain. No
    // timer, polling, or Jest timeout is used to unwind a pending test.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failures).toEqual([failure]);
    await completed;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([
      expect.stringMatching(UPDATE_READ_SQL),
      [CHECKOUT_SENDER],
    ]);
    expect(afterRead).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('fails and cleans up if the public update completes without the barrier', async () => {
    const query = jest.fn<ReturnType<RaceQuery>, Parameters<RaceQuery>>();
    query.mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(1));
    const afterRead = jest.fn(async () => undefined);
    const cleanup = jest.fn(async () => undefined);
    const failures: unknown[] = [];
    const completed = runStaleUpdateRace(
      query,
      afterRead,
      cleanup,
      /never-matches/,
    ).catch((error: unknown) => failures.push(error));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failures).toEqual([
      new Error('Generic update completed without reaching the read barrier'),
    ]);
    await completed;
    expect(query).toHaveBeenCalledTimes(2);
    expect(afterRead).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('releases and settles the held public update before cleanup on assertion failure', async () => {
    const failure = new Error('forced rival assertion failure');
    const events: string[] = [];
    const query: RaceQuery = async (sql) => {
      events.push(UPDATE_READ_SQL.test(sql) ? 'read' : 'write');
      return result(UPDATE_READ_SQL.test(sql) ? 0 : 1);
    };
    const afterRead = jest.fn(async () => {
      events.push('assertion');
      throw failure;
    });
    const cleanup = jest.fn(async () => {
      events.push('cleanup');
    });
    await expect(runStaleUpdateRace(query, afterRead, cleanup)).rejects.toBe(
      failure,
    );
    expect(events).toEqual(['read', 'assertion', 'write', 'cleanup']);
    expect(afterRead).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains captured revision zero before returning revision one and cleaning up', async () => {
    const events: string[] = [];
    const query: RaceQuery = async (sql) => {
      events.push(UPDATE_READ_SQL.test(sql) ? 'read' : 'write');
      return result(UPDATE_READ_SQL.test(sql) ? 0 : 1);
    };
    const afterRead = jest.fn(async (captured: QueryResult) => {
      expect(captured.rows).toEqual(result(0).rows);
      events.push('rival');
    });
    const cleanup = jest.fn(async () => {
      events.push('cleanup');
    });
    const returned = await runStaleUpdateRace(query, afterRead, cleanup);
    expect(returned.data).toEqual({
      sibling: 'from-stale-read',
      minimalCheckoutDraft: checkoutDraft(1),
    });
    expect(returned.lastMessageAt).toBe(CHECKOUT_TIME);
    expect(events).toEqual(['read', 'rival', 'write', 'cleanup']);
    expect(afterRead).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

/**
 * Explicit loopback test-only configuration. No configured URL, no production
 * DATABASE_URL, no fallback: the gate is re-checked and the port validated
 * before the Pool constructor runs.
 */
function checkoutTestPoolConfig(): PoolConfig {
  if (process.env[DB_GATE_ENV] !== '1') {
    throw new Error(`${DB_GATE_ENV}=1 is required for the DB proof`);
  }
  const raw = process.env[DB_PORT_ENV];
  if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) {
    throw new Error(`${DB_PORT_ENV} must be a numeric port in 1..65535`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`${DB_PORT_ENV} must be in 1..65535`);
  }
  return {
    host: '127.0.0.1',
    port,
    database: 'checkout_test',
    user: 'postgres',
    password: 'checkout_test',
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  };
}

const dbDescribe = process.env[DB_GATE_ENV] === '1' ? describe : describe.skip;

dbDescribe(
  'Minimal checkout draft durable PostgreSQL proof (disposable)',
  () => {
    jest.setTimeout(30_000);

    let pool: Pool;
    let tableCreated = false;

    const emptyTestRows = async (): Promise<void> => {
      // Scoped to this suite's own table: created inline below and dropped in
      // afterAll, inside the disposable `checkout_test` database only.
      await pool.query('DELETE FROM conversation_state');
    };

    beforeAll(async () => {
      pool = new Pool(checkoutTestPoolConfig());
      const readiness = await pool.connect();
      try {
        await readiness.query('SELECT 1');
      } finally {
        readiness.release();
      }
      process.stderr.write(
        `[checkout-draft-db] ready 127.0.0.1:${String(
          process.env[DB_PORT_ENV],
        )} database=checkout_test\n`,
      );
      await pool.query(
        'CREATE TABLE conversation_state (' +
          'sender_id text PRIMARY KEY, ' +
          'last_message_at timestamptz NOT NULL, ' +
          'data jsonb NOT NULL)',
      );
      tableCreated = true;
    });

    afterAll(async () => {
      if (!pool) {
        return;
      }
      try {
        if (tableCreated) {
          await pool.query('DROP TABLE IF EXISTS conversation_state');
        }
      } finally {
        // A failed DROP must never leak the connections this suite opened.
        try {
          await pool.end();
        } finally {
          process.stderr.write('[checkout-draft-db] pool closed\n');
        }
      }
    });

    runMinimalCheckoutDraftStoreContract('postgres disposable', async () => ({
      store: new PostgresConversationStore(pool),
      cleanup: emptyTestRows,
    }));

    describe('durable CAS and legacy race proof', () => {
      beforeEach(emptyTestRows);

      it('committed draft survives a fresh adapter and a second client', async () => {
        const writer = asCheckout(new PostgresConversationStore(pool));
        const first = checkoutDraft();
        expect(
          await commitDraft(
            writer,
            undefined,
            first,
            CHECKOUT_TIME,
            CHECKOUT_SENDER,
          ),
        ).toBe(true);

        const otherPool = new Pool(checkoutTestPoolConfig());
        try {
          const reader = asCheckout(new PostgresConversationStore(otherPool));
          expect(await reader.get(CHECKOUT_SENDER)).toEqual({
            senderId: CHECKOUT_SENDER,
            lastMessageAt: CHECKOUT_TIME,
            data: { minimalCheckoutDraft: first },
          });
          // An absent-key expectation can no longer win, and never overwrites.
          expect(
            await commitDraft(
              reader,
              undefined,
              checkoutDraft(1),
              LATER,
              CHECKOUT_SENDER,
            ),
          ).toBe(false);
          expect(await reader.get(CHECKOUT_SENDER)).toEqual({
            senderId: CHECKOUT_SENDER,
            lastMessageAt: CHECKOUT_TIME,
            data: { minimalCheckoutDraft: first },
          });
          expect(
            await commitDraft(
              reader,
              first,
              checkoutDraft(1),
              LATER,
              CHECKOUT_SENDER,
            ),
          ).toBe(true);
          expect(await reader.get(CHECKOUT_SENDER)).toEqual({
            senderId: CHECKOUT_SENDER,
            lastMessageAt: LATER,
            data: { minimalCheckoutDraft: checkoutDraft(1) },
          });
        } finally {
          await otherPool.end();
        }
      });

      it('permits exactly one competing CAS across clients and leaves the loser unchanged', async () => {
        const store = asCheckout(new PostgresConversationStore(pool));
        expect(
          await commitDraft(
            store,
            undefined,
            checkoutDraft(),
            CHECKOUT_TIME,
            CHECKOUT_SENDER,
          ),
        ).toBe(true);
        const expected = checkoutDraft();

        const otherPool = new Pool(checkoutTestPoolConfig());
        try {
          const rival = asCheckout(new PostgresConversationStore(otherPool));
          const results = await Promise.all([
            commitDraft(
              store,
              expected,
              checkoutDraft(1),
              LATER,
              CHECKOUT_SENDER,
            ),
            commitDraft(
              rival,
              expected,
              checkoutDraft(2),
              LATER,
              CHECKOUT_SENDER,
            ),
          ]);
          expect(results.filter(Boolean)).toHaveLength(1);
          const after = await store.get(CHECKOUT_SENDER);
          expect(after?.data.minimalCheckoutDraft).toEqual(
            checkoutDraft(results[0] ? 1 : 2),
          );
          expect(after?.lastMessageAt).toBe(LATER);

          // The stale expectation is refused with no data or timestamp change.
          expect(
            await commitDraft(
              rival,
              expected,
              checkoutDraft(3),
              CHECKOUT_TIME,
              CHECKOUT_SENDER,
            ),
          ).toBe(false);
          expect(await store.get(CHECKOUT_SENDER)).toEqual(after);
        } finally {
          await otherPool.end();
        }
      });

      it('stale generic update racing a newer checkout commit keeps the live draft', async () => {
        const store = asCheckout(new PostgresConversationStore(pool));
        expect(
          await commitDraft(
            store,
            undefined,
            checkoutDraft(),
            CHECKOUT_TIME,
            CHECKOUT_SENDER,
          ),
        ).toBe(true);
        await store.update(CHECKOUT_SENDER, { data: { sibling: 'seed' } });

        const slowClient = new Pool(checkoutTestPoolConfig());
        const otherPool = new Pool(checkoutTestPoolConfig());
        const rival = asCheckout(new PostgresConversationStore(otherPool));
        const returned = await runStaleUpdateRace(
          (sql, params) => slowClient.query(sql, params),
          async (captured) => {
            // Real revision 0 is held until rival revision 1 commits.
            const capturedRow = captured.rows[0] as {
              data: { minimalCheckoutDraft?: unknown };
            };
            expect(capturedRow.data.minimalCheckoutDraft).toEqual(
              checkoutDraft(),
            );
            expect(
              await commitDraft(
                rival,
                checkoutDraft(),
                checkoutDraft(1),
                CHECKOUT_TIME,
                CHECKOUT_SENDER,
              ),
            ).toBe(true);
          },
          async () => {
            await Promise.all([slowClient.end(), otherPool.end()]);
          },
        );
        expect(returned.data.minimalCheckoutDraft).toEqual(checkoutDraft(1));
        expect(await store.get(CHECKOUT_SENDER)).toEqual({
          senderId: CHECKOUT_SENDER,
          lastMessageAt: CHECKOUT_TIME,
          data: {
            sibling: 'from-stale-read',
            minimalCheckoutDraft: checkoutDraft(1),
          },
        });
      });

      it('JSON null legacy slot blocks an absent expectation but compares as present', async () => {
        const store = asCheckout(new PostgresConversationStore(pool));
        await store.create(CHECKOUT_SENDER, {
          lastMessageAt: CHECKOUT_TIME,
          data: { minimalCheckoutDraft: null, sibling: 'kept' },
        });
        expect(
          await commitDraft(
            store,
            undefined,
            checkoutDraft(),
            LATER,
            CHECKOUT_SENDER,
          ),
        ).toBe(false);
        expect(await store.get(CHECKOUT_SENDER)).toEqual({
          senderId: CHECKOUT_SENDER,
          lastMessageAt: CHECKOUT_TIME,
          data: { minimalCheckoutDraft: null, sibling: 'kept' },
        });
        expect(
          await commitDraft(
            store,
            null,
            checkoutDraft(),
            LATER,
            CHECKOUT_SENDER,
          ),
        ).toBe(true);
        // The generic update keeps the JSON null slot when it is the live value.
        await store.create('5215500000000', {
          lastMessageAt: CHECKOUT_TIME,
          data: { minimalCheckoutDraft: null, sibling: 'kept' },
        });
        await store.update('5215500000000', { data: { sibling: 'patched' } });
        expect(await store.get('5215500000000')).toEqual({
          senderId: '5215500000000',
          lastMessageAt: CHECKOUT_TIME,
          data: { minimalCheckoutDraft: null, sibling: 'patched' },
        });
      });
    });
  },
);

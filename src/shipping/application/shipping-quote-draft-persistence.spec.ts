import type {
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  buildShippingQuoteDraftRecord,
  SHIPPING_QUOTE_DRAFT_KEY as KEY,
  SHIPPING_QUOTE_DRAFT_TTL_MS as TTL,
  type ShippingQuoteDraftRecord,
} from './shipping-quote-draft-record';
import {
  buildShippingQuoteDraftContext,
  SHIPPING_QUOTE_DRAFT_CONTEXT_KEY as CXT_KEY,
  type ShippingQuoteDraftContext,
} from './shipping-quote-draft-context';
import {
  clearShippingQuoteDraft,
  persistShippingQuoteDraft,
  persistShippingQuoteDraftWithContext,
  readShippingQuoteDraft,
  readShippingQuoteDraftContext,
} from './shipping-quote-draft-persistence';
import type { ShippingQuoteDraft } from './shipping-quote-draft';

const NOW = '2026-06-23T12:00:00.000Z';
const MS = Date.parse(NOW);
const SEC = 'svc_secret';
const CAP = '2026-06-23T12:10:00.000Z';
const SIBLINGS = { messages: [], cart: { items: [] } };
const DATA_KEYS = ['cart', 'messages', KEY].sort().join();
const RECORD_KEYS = 'createdAt,draft,expiresAt,schemaVersion';

const BASE: ShippingQuoteDraft = {
  quoteId: 'q1',
  selectedRate: {
    rateId: 'r1',
    carrierName: 'C',
    serviceName: 'S',
    priceCents: 12_900,
    currency: 'MXN',
    estimatedDeliveryDays: 2,
    validUntil: null,
  },
  providerExpiresAt: null,
  bestRateCents: 12_900,
  totalCreditCents: 12_000,
  appliedCreditCents: 12_000,
  unusedCreditCents: 0,
  qualifyingUnitCount: 1,
  customerPaysCents: 900,
};
const DRAFT_KEYS = Object.keys(BASE).sort().join();
const draft = (o: Partial<ShippingQuoteDraft> = {}): ShippingQuoteDraft => ({
  ...BASE,
  ...o,
});
const record = (
  o: Partial<ShippingQuoteDraft> = {},
): ShippingQuoteDraftRecord => buildShippingQuoteDraftRecord(draft(o), MS)!;
const TTL_EXCEEDED = {
  ...record(),
  expiresAt: new Date(MS + TTL + 1).toISOString(),
};
const TAMPERED = { ...record(), draft: { ...BASE, customerPaysCents: 1 } };
const CUST = '11111111-1111-1111-1111-111111111111';
const ADDR = '22222222-2222-2222-2222-222222222222';
const PROD = '33333333-3333-3333-3333-333333333333';
const DEST = {
  zipCode: '06700',
  state: 'CDMX',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
};
const context = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  customerId: CUST,
  shippingAddressId: ADDR,
  cart: [
    { productId: PROD, variantId: null, quantity: 1, unitPriceCents: 12_900 },
  ],
  destination: { ...DEST },
  ...overrides,
});
const builtContext = (createdAt = NOW): ShippingQuoteDraftContext =>
  buildShippingQuoteDraftContext(context(), createdAt)!;
const CXT_KEYS =
  'cart,customerId,destination,draftCreatedAt,schemaVersion,shippingAddressId';
const FULL_KEYS = ['cart', 'messages', KEY, CXT_KEY].sort().join();
const stateOf = (
  stored: unknown,
  data: Record<string, unknown> = {},
): ConversationState => ({
  senderId: 's',
  lastMessageAt: NOW,
  data: { ...data, [KEY]: stored },
});

type Patch = { lastMessageAt?: string; data: Record<string, unknown> };
const okStore = (): [ConversationStore, jest.Mock] => {
  const update = jest.fn(
    (senderId: string, patch: Partial<Omit<ConversationState, 'senderId'>>) =>
      Promise.resolve({ senderId, ...patch } as ConversationState),
  );
  return [{ update } as unknown as ConversationStore, update];
};
const call = (update: jest.Mock): [string, Patch] =>
  update.mock.calls[0] as [string, Patch];

const throwingGet = (): never => {
  throw new Error('hostile get');
};
const hostileStored = new Proxy({}, { get: throwingGet });
const hostile = (): ConversationState[] => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return [
    proxy,
    new Proxy({}, { get: throwingGet }),
    {
      senderId: 's',
      lastMessageAt: NOW,
      get data(): never {
        return throwingGet();
      },
    },
    { senderId: 's', lastMessageAt: NOW, data: null },
    { senderId: 's', lastMessageAt: '', data: {} },
  ] as unknown as ConversationState[];
};
const CLOCKS = [NaN, Infinity, -1, 1.5, null, {}, 'now'] as number[];

describe('shipping-quote-draft-persistence', () => {
  describe('readShippingQuoteDraft', () => {
    it('returns a fresh frozen record inside the window without mutation', () => {
      const stored = record();
      const state = stateOf(stored, SIBLINGS);
      const before = structuredClone(state);
      const got = readShippingQuoteDraft(state, MS);
      expect(got).toEqual(stored);
      expect([got === stored, got?.draft === stored.draft]).toEqual([
        false,
        false,
      ]);
      expect(Object.isFrozen(got) && Object.isFrozen(got?.draft)).toBe(true);
      expect(state).toEqual(before);
      const capped = record({ providerExpiresAt: CAP });
      expect(readShippingQuoteDraft(stateOf(capped), MS + 599_999)).toEqual(
        capped,
      );
    });

    it.each<[string, unknown, number]>([
      ['pre-created', record(), MS - 1],
      ['at expiry', record(), MS + TTL],
      ['past provider cap', record({ providerExpiresAt: CAP }), MS + 600_000],
      ['missing', undefined, MS],
      ['malformed', 'x', MS],
      ['schema v2', { ...record(), schemaVersion: 2 }, MS],
      ['ttl exceeded', TTL_EXCEEDED, MS],
      ['tampered draft', TAMPERED, MS],
      ['hostile stored', hostileStored, MS],
    ])('returns null for %s', (_label, stored, now) => {
      expect(readShippingQuoteDraft(stateOf(stored), now)).toBeNull();
    });

    it.each(CLOCKS)('returns null for clock %p', (now) => {
      expect(readShippingQuoteDraft(stateOf(record()), now)).toBeNull();
    });

    it('fails closed for hostile states and getters', () => {
      const out = hostile().map((v) => readShippingQuoteDraft(v, MS));
      expect(out).toEqual(hostile().map(() => null));
    });
  });

  describe('persistShippingQuoteDraft', () => {
    it('writes one validated record preserving siblings and lastMessageAt', async () => {
      const [store, update] = okStore();
      const state = stateOf(undefined, { ...SIBLINGS });
      const result = await persistShippingQuoteDraft(
        store,
        's',
        state,
        draft(),
        MS,
      );
      expect(update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = call(update);
      expect([senderId, patch.lastMessageAt]).toEqual(['s', NOW]);
      expect(Object.keys(patch.data).sort().join()).toBe(DATA_KEYS);
      expect(patch.data.cart).toEqual(SIBLINGS.cart);
      const persisted = patch.data[KEY] as ShippingQuoteDraftRecord;
      expect(persisted).toEqual(record());
      expect(Object.keys(persisted).sort().join()).toBe(RECORD_KEYS);
      expect(Object.isFrozen(persisted.draft.selectedRate)).toBe(true);
      expect(Object.keys(persisted.draft).sort().join()).toBe(DRAFT_KEYS);
      expect(result).toMatchObject({ senderId: 's', lastMessageAt: NOW });
      expect(result!.data).toBe(patch.data);
      expect(patch.data === state.data).toBe(false);
    });

    it('returns null and never reads state or store for invalid input', async () => {
      const [store, update] = okStore();
      let reads = 0;
      const spy = new Proxy(stateOf(record()), {
        get: (target, key) => {
          if (key === 'data') reads += 1;
          return Reflect.get(target, key) as unknown;
        },
      });
      const results = await Promise.all([
        persistShippingQuoteDraft(store, 's', null, { token: SEC }, MS),
        persistShippingQuoteDraft(store, 's', null, draft(), NaN),
        persistShippingQuoteDraft(
          store,
          's',
          null,
          draft({ providerExpiresAt: NOW }),
          MS,
        ),
        persistShippingQuoteDraft(store, 's', spy, { token: SEC }, MS),
        ...hostile().map((v) =>
          persistShippingQuoteDraft(store, 's', v, draft(), MS),
        ),
      ]);
      expect(results).toEqual(results.map(() => null));
      expect(update).not.toHaveBeenCalled();
      expect(reads).toBe(0);
    });

    it('uses record createdAt when state is null and strips raw extras', async () => {
      const [store, update] = okStore();
      const raw = {
        ...draft(),
        token: SEC,
        customerAddress: SEC,
        parcel: SEC,
        providerResponse: SEC,
      };
      await persistShippingQuoteDraft(store, 's', null, raw, MS);
      const [, patch] = call(update);
      const persisted = patch.data[KEY] as ShippingQuoteDraftRecord;
      expect(patch.lastMessageAt).toBe(NOW);
      expect(Object.keys(patch.data).join()).toBe(KEY);
      expect(JSON.stringify(call(update))).not.toContain(SEC);
      expect(Object.is(persisted, raw)).toBe(false);
      expect(Object.keys(persisted).sort().join()).toBe(RECORD_KEYS);
    });

    it('writes only the exact senderId argument and propagates rejection', async () => {
      const [store, update] = okStore();
      const state = { ...stateOf(undefined), senderId: 'other' };
      await persistShippingQuoteDraft(store, 'target', state, draft(), MS);
      const [senderId, patch] = call(update);
      expect(senderId).toBe('target');
      expect(Object.hasOwn(patch.data, 'senderId')).toBe(false);
      const failing = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(
        persistShippingQuoteDraft(
          { update: failing } as unknown as ConversationStore,
          's',
          null,
          draft(),
          MS,
        ),
      ).rejects.toThrow('db down');
      expect(failing).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearShippingQuoteDraft', () => {
    it('deletes the key preserving siblings and lastMessageAt', async () => {
      const [store, update] = okStore();
      const state = { ...stateOf(record(), SIBLINGS), senderId: 'other' };
      const before = structuredClone(state);
      const result = await clearShippingQuoteDraft(store, 'target', state, NaN);
      expect(update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = call(update);
      expect([senderId, patch.lastMessageAt]).toEqual(['target', NOW]);
      expect(Object.hasOwn(patch.data, KEY)).toBe(false);
      expect(KEY in patch.data).toBe(false);
      expect(patch.data.cart).toEqual(SIBLINGS.cart);
      expect(patch.data.messages).toEqual(SIBLINGS.messages);
      expect(patch.data === state.data).toBe(false);
      expect(state).toEqual(before);
      expect(result).toMatchObject({ senderId: 'target', lastMessageAt: NOW });
      expect(result!.data).toBe(patch.data);
    });

    it('falls back to the injected clock and propagates rejection', async () => {
      const [store, update] = okStore();
      await clearShippingQuoteDraft(store, 's', null, MS);
      const [, patch] = call(update);
      expect([patch.lastMessageAt, patch.data]).toEqual([NOW, {}]);
      const failing = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(
        clearShippingQuoteDraft(
          { update: failing } as unknown as ConversationStore,
          's',
          null,
          MS,
        ),
      ).rejects.toThrow('db down');
      expect(failing).toHaveBeenCalledTimes(1);
    });

    it('removes both the draft and its context in one update', async () => {
      const [store, update] = okStore();
      const state = stateOf(record(), {
        ...SIBLINGS,
        [CXT_KEY]: builtContext(),
      });
      const result = await clearShippingQuoteDraft(store, 'target', state, NaN);
      expect(update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = call(update);
      expect([senderId, patch.lastMessageAt]).toEqual(['target', NOW]);
      expect(KEY in patch.data).toBe(false);
      expect(CXT_KEY in patch.data).toBe(false);
      expect(patch.data.cart).toEqual(SIBLINGS.cart);
      expect(patch.data.messages).toEqual(SIBLINGS.messages);
      expect(result).toMatchObject({ senderId: 'target', lastMessageAt: NOW });
    });

    it('removes an orphan context when no draft key is present', async () => {
      const [store, update] = okStore();
      const state = stateOf(undefined, {
        ...SIBLINGS,
        [CXT_KEY]: builtContext(),
      });
      await clearShippingQuoteDraft(store, 's', state, MS);
      const [, patch] = call(update);
      expect(CXT_KEY in patch.data).toBe(false);
      expect(KEY in patch.data).toBe(false);
      expect(patch.data.cart).toEqual(SIBLINGS.cart);
    });

    it('returns null without writing for invalid fallback clock or hostile state', async () => {
      const [store, update] = okStore();
      const results = await Promise.all([
        ...CLOCKS.map((now) => clearShippingQuoteDraft(store, 's', null, now)),
        ...hostile().map((v) => clearShippingQuoteDraft(store, 's', v, MS)),
      ]);
      expect(results).toEqual(results.map(() => null));
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('persistShippingQuoteDraftWithContext', () => {
    it('atomically writes draft and context preserving siblings and lastMessageAt', async () => {
      const [store, update] = okStore();
      const state = stateOf(undefined, { ...SIBLINGS });
      const result = await persistShippingQuoteDraftWithContext(
        store,
        's',
        state,
        draft(),
        context(),
        MS,
      );
      expect(update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = call(update);
      expect([senderId, patch.lastMessageAt]).toEqual(['s', NOW]);
      expect(Object.keys(patch.data).sort().join()).toBe(FULL_KEYS);
      expect(patch.data.cart).toEqual(SIBLINGS.cart);
      expect(patch.data.messages).toEqual(SIBLINGS.messages);
      expect(patch.data[KEY]).toEqual(record());
      expect(patch.data[CXT_KEY]).toEqual(builtContext());
      expect(result).toMatchObject({ senderId: 's', lastMessageAt: NOW });
      expect(patch.data === state.data).toBe(false);
    });

    it('pins context to the draft createdAt and rejects raw context extras', async () => {
      const [store, update] = okStore();
      await persistShippingQuoteDraftWithContext(
        store,
        's',
        null,
        draft(),
        context(),
        MS,
      );
      const [, patch] = call(update);
      const persisted = patch.data[CXT_KEY] as ShippingQuoteDraftContext;
      expect(patch.lastMessageAt).toBe(NOW);
      expect(Object.keys(patch.data).sort().join()).toBe(
        [KEY, CXT_KEY].sort().join(),
      );
      expect(persisted.draftCreatedAt).toBe(NOW);
      expect(Object.keys(persisted).sort().join()).toBe(CXT_KEYS);

      const [extraStore, extraUpdate] = okStore();
      const extra = await persistShippingQuoteDraftWithContext(
        extraStore,
        's',
        null,
        draft(),
        { ...context(), token: SEC },
        MS,
      );
      expect(extra).toBeNull();
      expect(extraUpdate).not.toHaveBeenCalled();
    });

    it('returns null and never reads state or store when draft or context is invalid', async () => {
      const [store, update] = okStore();
      let reads = 0;
      const spy = new Proxy(stateOf(record()), {
        get: (target, key) => {
          if (key === 'data') reads += 1;
          return Reflect.get(target, key) as unknown;
        },
      });
      const results = await Promise.all([
        persistShippingQuoteDraftWithContext(
          store,
          's',
          null,
          draft(),
          { customerId: 'x' },
          MS,
        ),
        persistShippingQuoteDraftWithContext(
          store,
          's',
          null,
          { token: SEC },
          context(),
          MS,
        ),
        persistShippingQuoteDraftWithContext(
          store,
          's',
          null,
          draft(),
          context(),
          NaN,
        ),
        persistShippingQuoteDraftWithContext(
          store,
          's',
          spy,
          draft(),
          { customerId: 'x' },
          MS,
        ),
        ...hostile().map((v) =>
          persistShippingQuoteDraftWithContext(
            store,
            's',
            v,
            draft(),
            context(),
            MS,
          ),
        ),
      ]);
      expect(results).toEqual(results.map(() => null));
      expect(update).not.toHaveBeenCalled();
      expect(reads).toBe(0);
    });
  });

  describe('readShippingQuoteDraftContext', () => {
    it('returns the exact pinned context for a fresh matching draft', () => {
      const built = builtContext();
      const state = stateOf(record(), { ...SIBLINGS, [CXT_KEY]: built });
      const got = readShippingQuoteDraftContext(state, MS);
      expect(got).toEqual(built);
      expect(got === built).toBe(false);
    });

    it.each<[string, ConversationState, number]>([
      ['absent context', stateOf(record(), { ...SIBLINGS }), MS],
      [
        'context without draft',
        stateOf(undefined, { ...SIBLINGS, [CXT_KEY]: builtContext() }),
        MS,
      ],
      [
        'mismatched pin',
        stateOf(record(), {
          ...SIBLINGS,
          [CXT_KEY]: builtContext('2026-06-23T11:00:00.000Z'),
        }),
        MS,
      ],
      [
        'expired draft',
        stateOf(record(), { ...SIBLINGS, [CXT_KEY]: builtContext() }),
        MS + TTL,
      ],
      [
        'malformed context',
        stateOf(record(), {
          ...SIBLINGS,
          [CXT_KEY]: { schemaVersion: 2 },
        }),
        MS,
      ],
    ])('returns null for %s', (_label, state, now) => {
      expect(readShippingQuoteDraftContext(state, now)).toBeNull();
    });

    it('fails closed for hostile states and invalid clocks', () => {
      const state = stateOf(record(), {
        ...SIBLINGS,
        [CXT_KEY]: builtContext(),
      });
      const hostileOut = hostile().map((v) =>
        readShippingQuoteDraftContext(v, MS),
      );
      expect(hostileOut).toEqual(hostile().map(() => null));
      const clockOut = CLOCKS.map((now) =>
        readShippingQuoteDraftContext(state, now),
      );
      expect(clockOut).toEqual(CLOCKS.map(() => null));
    });
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
// prettier-ignore
import type { ConversationState, ConversationStore } from '../../conversation/domain/conversation-store';
// prettier-ignore
import type { HumanHandoffResolution, ShippingApprovedResolution, ShippingExpiredResolution, ShippingRejectedResolution } from '../domain/human-handoff.types';
// prettier-ignore
import type { ShippingApprovalDecisionKind, ShippingApprovalStaleKind } from '../domain/shipping-approval-policy.port';
// prettier-ignore
import { clearShippingApprovalMarker, readShippingApprovalMarker, setShippingApprovalMarker, SHIPPING_APPROVAL_KEY as KEY } from './shipping-approval-persistence';

/** SQ-5C2b: exact structured shipping resolutions + the bounded
 *  `shippingApproval` marker read/set/clear lifecycle. Offline; sole I/O is
 *  the injected `store.update`. */
const T0 = '2026-06-23T12:00:00.000Z';
const T1 = '2026-06-23T12:05:00.000Z';
// prettier-ignore
const SIB = { cart: { items: [], idempotencyKey: 'k' }, messages: [{ role: 'user', content: 'hola' }], shippingQuoteDraft: { schemaVersion: 1 }, pendingHumanRequest: { requestId: 'ffffffffffff' }, unknownSibling: 'x' };
// prettier-ignore
const base = { requestId: 'abcdef123456', draftCreatedAt: T0, decision: 'SHIPPING_APPROVED', decidedAt: T1 };
// prettier-ignore
const stateOf = (stored: unknown, data: Record<string, unknown> = {}): ConversationState => ({ senderId: 's', lastMessageAt: T0, data: { ...data, [KEY]: stored } });
type Patch = { lastMessageAt?: string; data: Record<string, unknown> };
// prettier-ignore
const okStore = (): [ConversationStore, jest.Mock] => { const update = jest.fn((senderId: string, patch: Partial<Omit<ConversationState, 'senderId'>>) => Promise.resolve({ senderId, ...patch } as ConversationState)); return [{ update } as unknown as ConversationStore, update]; };
// prettier-ignore
const call = (u: jest.Mock): [string, Patch] => u.mock.calls[0] as [string, Patch];
const boom = (): never => {
  throw new Error('hostile get');
};
// prettier-ignore
const revoked = (): unknown => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
// prettier-ignore
const hostileStates = (): ConversationState[] => [revoked(), new Proxy({}, { get: boom }), { get data(): never { return boom(); } }, { senderId: 's', lastMessageAt: T0, data: null }] as unknown as ConversationState[];
// prettier-ignore
const hostileMarkers = (): unknown[] => [revoked(), new Proxy({}, { get: boom }), { get requestId(): never { return boom(); } }];
// prettier-ignore
const INVALID: Array<[string, unknown]> = [
  ['extra key', { ...base, priceCents: 1 }],
  ['missing decidedAt', { ...base, decidedAt: undefined }],
  ['missing requestId', { ...base, requestId: undefined }],
  ['uppercase id', { ...base, requestId: 'ABCDEF123456' }],
  ['short id', { ...base, requestId: 'abcdef12345' }],
  ['long id', { ...base, requestId: 'abcdef1234567' }],
  ['nonhex id', { ...base, requestId: 'abcdef12345g' }],
  ['empty id', { ...base, requestId: '' }],
  ['numeric id', { ...base, requestId: 123456789012 }],
  ['noncanonical draft', { ...base, draftCreatedAt: '2026-06-23T12:00:00Z' }],
  ['date-only draft', { ...base, draftCreatedAt: '2026-06-23' }],
  ['invalid decidedAt', { ...base, decidedAt: 'not-a-date' }],
  ['negative epoch', { ...base, draftCreatedAt: '1969-12-31T23:59:59.999Z' }],
  ['invalid decision', { ...base, decision: 'SHIPPING_EXPIRED' }],
  ['null decision', { ...base, decision: null }],
  ['decided before draft', { ...base, decidedAt: '2026-06-23T11:59:59.999Z' }],
  ['null raw', null],
  ['undefined raw', undefined],
  ['string raw', 'x'],
  ['array raw', [base]],
];

describe('shipping-approval-persistence', () => {
  // prettier-ignore
  it('exposes the exact key and finite port unions', () => {
    expect(KEY).toBe('shippingApproval');
    const stale: ShippingApprovalStaleKind[] = ['invalid_clock', 'draft_missing', 'draft_expired', 'draft_pin_mismatch'];
    const decisions: ShippingApprovalDecisionKind[] = ['SHIPPING_APPROVED', 'SHIPPING_REJECTED'];
    expect([...stale, ...decisions]).toHaveLength(6);
  });

  // prettier-ignore
  it('typechecks standalone structured resolutions with exact, money-free keys', () => {
    const approved: ShippingApprovedResolution = { decision: 'SHIPPING_APPROVED', draftCreatedAt: T0 };
    const rejected: ShippingRejectedResolution = { decision: 'SHIPPING_REJECTED', draftCreatedAt: T0 };
    const expired: ShippingExpiredResolution = { decision: 'SHIPPING_EXPIRED', draftCreatedAt: T0, reason: 'draft_expired' };
    const all: Array<ShippingApprovedResolution | ShippingRejectedResolution | ShippingExpiredResolution> = [approved, rejected, expired];
    expect(all).toHaveLength(3);
    expect(Object.keys(approved).sort()).toEqual(['decision', 'draftCreatedAt']);
    expect(Object.keys(expired).sort()).toEqual(['decision', 'draftCreatedAt', 'reason']);
    type Extra = Exclude<keyof (typeof all)[number], 'decision' | 'draftCreatedAt' | 'reason'>;
    const none: Extra[] = [];
    void none;
  });

  // prettier-ignore
  it('keeps the shipping shapes inactive in HumanHandoffResolution until C2c', () => {
    const union: HumanHandoffResolution[] = [{ decision: 'NO_RESTOCK' }];
    type ShippingInUnion = Extract<HumanHandoffResolution, { decision: 'SHIPPING_APPROVED' }>;
    type Inactive = ShippingInUnion extends never ? true : never;
    const inactive: Inactive = true;
    expect([union, inactive]).toEqual([[{ decision: 'NO_RESTOCK' }], true]);
  });

  // prettier-ignore
  it('reads a fresh frozen exact marker for approved/rejected boundaries', () => {
    const equal = { ...base, decidedAt: T0 };
    const approved = readShippingApprovalMarker(stateOf(equal));
    expect(approved).toEqual(equal);
    expect(readShippingApprovalMarker(stateOf({ ...base, decision: 'SHIPPING_REJECTED' }))).toEqual({ ...base, decision: 'SHIPPING_REJECTED' });
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.keys(approved!).sort()).toEqual(['decidedAt', 'decision', 'draftCreatedAt', 'requestId']);
    expect(readShippingApprovalMarker({ data: { [KEY]: base } })).toEqual(base);
    expect(readShippingApprovalMarker({ data: { [KEY]: undefined } })).toBeNull();
    expect(readShippingApprovalMarker({ data: [base] })).toBeNull();
    expect(readShippingApprovalMarker(null)).toBeNull();
  });

  it.each([...INVALID])('reads null for %s', (_label, raw) => {
    expect(readShippingApprovalMarker(stateOf(raw))).toBeNull();
  });

  // prettier-ignore
  it('never throws on hostile input and snapshots each field once', () => {
    expect(hostileStates().map((s) => readShippingApprovalMarker(s))).toEqual(hostileStates().map(() => null));
    for (const marker of hostileMarkers()) expect(readShippingApprovalMarker(stateOf(marker))).toBeNull();
    let reads = 0;
    const raw = Object.defineProperties({}, {
      requestId: { get: () => { reads += 1; return reads === 1 ? base.requestId : boom(); }, enumerable: true },
      draftCreatedAt: { get: () => base.draftCreatedAt, enumerable: true },
      decision: { get: () => (reads++ === 1 ? 'BOGUS' : base.decision), enumerable: true },
      decidedAt: { get: () => base.decidedAt, enumerable: true },
    });
    expect(readShippingApprovalMarker(stateOf(raw))).toBeNull();
    expect(reads).toBe(2);
  });

  // prettier-ignore
  it('is immune to source mutation and retains no source refs', () => {
    const raw = { ...base };
    const state = stateOf(raw);
    const got = readShippingApprovalMarker(state);
    raw.requestId = 'ffffffffffff';
    raw.decision = 'SHIPPING_REJECTED';
    state.data[KEY] = null;
    expect(got).toEqual(base);
    expect(got).not.toBe(raw);
  });

  // prettier-ignore
  it('writes one fresh exact marker preserving siblings and timestamp', async () => {
    const [store, update] = okStore();
    const state = { ...stateOf(undefined, { ...SIB }), senderId: 'other' };
    const rawMarker = { ...base };
    const before = structuredClone(state);
    const result = await setShippingApprovalMarker(store, 'target', state, rawMarker, T1);
    expect(update).toHaveBeenCalledTimes(1);
    const [senderId, patch] = call(update);
    expect([senderId, patch.lastMessageAt]).toEqual(['target', T1]);
    expect(Object.keys(patch.data).sort()).toEqual([...Object.keys(SIB), KEY].sort());
    const stored = patch.data[KEY] as typeof base;
    expect(stored).toEqual(base);
    expect(stored).not.toBe(rawMarker);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.keys(stored).sort()).toEqual(['decidedAt', 'decision', 'draftCreatedAt', 'requestId']);
    expect(state).toEqual(before);
    expect(patch.data === state.data).toBe(false);
    rawMarker.requestId = 'ffffffffffff';
    expect(stored.requestId).toBe(base.requestId);
    expect(result).toMatchObject({ senderId: 'target', lastMessageAt: T1 });
    expect(result!.data).toBe(patch.data);
  });

  // prettier-ignore
  it('handles null state and fails closed without store I/O', async () => {
    const [store, update] = okStore();
    await setShippingApprovalMarker(store, 's', null, base, T1);
    expect(call(update)[1].data).toEqual({ [KEY]: base });
    update.mockClear();
    const results = await Promise.all([
      ...INVALID.map(([, raw]) => setShippingApprovalMarker(store, 's', null, raw, T1)),
      ...hostileMarkers().map((m) => setShippingApprovalMarker(store, 's', null, m, T1)),
      ...hostileStates().map((s) => setShippingApprovalMarker(store, 's', s, base, T1)),
      setShippingApprovalMarker(store, 's', null, base, '2026-06-23T12:00:00Z'),
      setShippingApprovalMarker(store, 's', null, base, 'not-a-date'),
    ]);
    expect(results).toEqual(results.map(() => null));
    expect(update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('propagates store rejection for set and clear', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('db down'));
    const failingStore = { update: failing } as unknown as ConversationStore;
    await expect(setShippingApprovalMarker(failingStore, 's', null, base, T1)).rejects.toThrow('db down');
    await expect(clearShippingApprovalMarker(failingStore, 's', null)).rejects.toThrow('db down');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  // prettier-ignore
  it('clears to explicit null preserving siblings and lastMessageAt', async () => {
    const [store, update] = okStore();
    const state = { ...stateOf(base, { ...SIB }), senderId: 'other' };
    const before = structuredClone(state);
    const result = await clearShippingApprovalMarker(store, 'target', state);
    expect(update).toHaveBeenCalledTimes(1);
    const [senderId, patch] = call(update);
    expect([senderId, patch.lastMessageAt]).toEqual(['target', T0]);
    expect(patch.data[KEY]).toBeNull();
    expect(Object.keys(patch.data).sort()).toEqual([...Object.keys(SIB), KEY].sort());
    expect(patch.data.cart).toEqual(SIB.cart);
    expect(state).toEqual(before);
    expect(result).toMatchObject({ senderId: 'target', lastMessageAt: T0 });
  });

  // prettier-ignore
  it('clears null state with a fresh canonical ISO fallback', async () => {
    const [store, update] = okStore();
    await clearShippingApprovalMarker(store, 's', null);
    const [, patch] = call(update);
    expect(patch.data).toEqual({ [KEY]: null });
    expect(new Date(patch.lastMessageAt!).toISOString()).toBe(patch.lastMessageAt);
  });

  // prettier-ignore
  it('returns null without store I/O for corrupt/hostile non-null state', async () => {
    const [store, update] = okStore();
    const results = await Promise.all(hostileStates().map((s) => clearShippingApprovalMarker(store, 's', s)));
    expect(results).toEqual(hostileStates().map(() => null));
    expect(update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('has no network, DB, provider, or Nest production dependency', () => {
    const src = fs.readFileSync(path.resolve(__dirname, './shipping-approval-persistence.ts'), 'utf8');
    expect([...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort()).toEqual([
      '../../conversation/domain/conversation-store',
      '../domain/shipping-approval-policy.port',
    ]);
    expect(/@nestjs|\bfetch\(|axios|openai|pg\./i.test(src)).toBe(false);
  });
});

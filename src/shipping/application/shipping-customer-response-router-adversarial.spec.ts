/**
 * SCA-4b2: adversarial test-only matrix for the deterministic customer-response
 * router — the guard, dedup-replay and cancellation cases moved out of the b1
 * core spec plus the boundary inputs (invalid identity, old/expired YES, invalid
 * timestamp, price drift, accepted-replay rejection, late-NO cancellation,
 * decline replay, malformed-offer no-clear, pending human, store failure).
 * Consumes the shared b0 fixture and b1 harness; adds no production behavior.
 */
import type {
  ConversationState,
  ConversationStateData,
} from '../../conversation/domain/conversation-store';
import {
  ACCEPT_KEY,
  APPROVAL,
  CONTEXT,
  DRAFT,
  EXPIRES,
  IN_ID,
  NOW,
  OFFER_KEY,
  OFFERED,
  OTHER_REQ,
  PIN,
  PENDING,
  RECEIPT_KEY,
  RECEIPT_POINTER,
  SENDER,
  SIBLINGS,
  TOTAL,
  YES,
  acceptance,
  base,
  cart,
  context,
  input,
  offer,
  receipt,
  stateOf,
} from '../../../test/fixtures/shipping-customer-response-router-fixture';
import {
  failingConversations,
  route,
  setup,
} from '../../../test/fixtures/shipping-customer-response-router-harness';
import {
  ShippingCustomerResponseRouter as Router,
  type ShippingCustomerResponseConversations,
} from './shipping-customer-response-router';

describe('ShippingCustomerResponseRouter (adversarial)', () => {
  it('fences an invalid identity without touching the store', async () => {
    const ctx = setup(base());
    const out = await ctx.router.route({
      senderId: '',
      text: 'SÍ',
      sourceWebhookMessageId: IN_ID,
      inboundTimestamp: YES,
    });
    expect(out).toEqual({ kind: 'fenced' });
    expect(ctx.conversations.get).not.toHaveBeenCalled();
  });

  it('blocks a pending human request on an active offer', async () => {
    const r = await route(base({ pendingHumanRequest: PENDING }));
    expect(r.out).toEqual({ kind: 'blocked' });
    expect(r.updates).toHaveLength(0);
  });

  it('blocks a malformed offer or orphan/drifted acceptance without a write', async () => {
    const malformed = await route(
      base({ [OFFER_KEY]: offer({ expectedTotalCents: TOTAL + 1 }) }),
      { text: 'NO' },
    );
    expect(malformed.out).toEqual({ kind: 'blocked' });
    expect(malformed.updates).toHaveLength(0);
    const orphan = await route(
      base({ [OFFER_KEY]: null, [ACCEPT_KEY]: acceptance() }),
    );
    expect(orphan.out).toEqual({ kind: 'blocked' });
    expect(orphan.updates).toHaveLength(0);
    const drifted = await route(
      base({ [ACCEPT_KEY]: acceptance({ requestId: OTHER_REQ }) }),
    );
    expect(drifted.out).toEqual({ kind: 'blocked' });
    expect(drifted.updates).toHaveLength(0);
  });

  it('marks malformed active-offer text unrecognized with no write', async () => {
    const r = await route(base(), { text: 'quizás' });
    expect(r.out).toEqual({ kind: 'unrecognized' });
    expect(r.updates).toHaveLength(0);
  });

  it('blocks YES at or before the offer and after expiry', async () => {
    expect((await route(base(), { inboundTimestamp: OFFERED })).out).toEqual({
      kind: 'blocked',
    });
    expect((await route(base(), { inboundTimestamp: PIN })).out).toEqual({
      kind: 'blocked',
    });
    expect((await route(base(), {}, EXPIRES)).out).toEqual({ kind: 'blocked' });
  });

  it('blocks an invalid timestamp or a server-side price drift', async () => {
    expect(
      (await route(base(), { inboundTimestamp: 'not-a-time' })).out,
    ).toEqual({ kind: 'blocked' });
    const drifted = base({ [CONTEXT]: context(59_000), cart: cart(59_000) });
    expect((await route(drifted)).out).toEqual({ kind: 'blocked' });
  });

  it('blocks an accepted replay when the flow expired, drifted or the time differs', async () => {
    const stored = base({ [ACCEPT_KEY]: acceptance() });
    const expired = await route(stored, {}, EXPIRES);
    expect(expired.out).toEqual({ kind: 'blocked' });
    expect(expired.updates).toHaveLength(0);
    const drifted = base({
      [ACCEPT_KEY]: acceptance(),
      [CONTEXT]: context(59_000),
      cart: cart(59_000),
    });
    const stale = await route(drifted);
    expect(stale.out).toEqual({ kind: 'blocked' });
    expect(stale.updates).toHaveLength(0);
    const later = await route(stored, {
      inboundTimestamp: '2026-06-23T12:08:00.000Z',
    });
    expect(later.out).toEqual({ kind: 'blocked' });
    expect(later.updates).toHaveLength(0);
  });

  it('cancels on a late NO after expiry and preserves unrelated siblings', async () => {
    const late = '2026-06-23T12:40:00.000Z';
    const r = await route(base(), { text: 'NO', inboundTimestamp: late }, late);
    expect(r.out.kind).toBe('declined');
    const patch = r.updates[0]?.data;
    expect(patch?.[OFFER_KEY]).toBeNull();
    expect(patch?.[ACCEPT_KEY]).toBeNull();
    expect(patch?.[APPROVAL]).toBeNull();
    expect(Object.hasOwn(patch ?? {}, DRAFT)).toBe(false);
    expect(Object.hasOwn(patch ?? {}, CONTEXT)).toBe(false);
    expect(patch?.keepMe).toEqual(SIBLINGS.keepMe);
    expect(patch?.messages).toEqual(SIBLINGS.messages);
  });

  it('replays an identical decline after the offer was cleared with no write', async () => {
    const cleared = base({
      [OFFER_KEY]: null,
      [ACCEPT_KEY]: null,
      [RECEIPT_KEY]: receipt(),
    });
    const r = await route(cleared, { text: 'cualquier cosa' });
    expect(r.out).toEqual({ kind: 'replayed_decline', receipt: receipt() });
    expect(r.updates).toHaveLength(0);
  });

  it('does not clear on a malformed offer', async () => {
    const r = await route(base({ [OFFER_KEY]: offer({ expiresAt: PIN }) }), {
      text: 'NO',
    });
    expect(r.out).toEqual({ kind: 'blocked' });
    expect(r.updates).toHaveLength(0);
  });

  it('propagates a read or write failure and never reports accepted', async () => {
    await expect(
      new Router(failingConversations('get', base()), () =>
        Date.parse(NOW),
      ).route(input()),
    ).rejects.toThrow('read-boom');
    await expect(
      new Router(failingConversations('update', base()), () =>
        Date.parse(NOW),
      ).route(input()),
    ).rejects.toThrow('write-boom');
  });
});

/**
 * SCA-4c: a non-null active shipping offer coexisting with a valid
 * `receiptAmountPointer` is a genuine two-flow collision. Bare SÍ/NO, a
 * preexisting acceptance and even a matching decline replay must not mutate
 * either flow; the router returns terminal `blocked` with zero writes, and it
 * must do so BEFORE the decline-tombstone replay. Only an absent offer fences
 * so the receipt flow can route. Dedicated human handoff remains pending.
 */
describe('ShippingCustomerResponseRouter (offer + receipt pointer collision)', () => {
  const collision = (over: Record<string, unknown> = {}) =>
    base({ receiptAmountPointer: RECEIPT_POINTER, ...over });

  it('blocks a fresh YES with no write', async () => {
    const r = await route(collision(), { text: 'SÍ' });
    expect(r.out).toEqual({ kind: 'blocked' });
    expect(r.updates).toHaveLength(0);
  });

  it('blocks NO with no write', async () => {
    const r = await route(collision(), { text: 'NO' });
    expect(r.out).toEqual({ kind: 'blocked' });
    expect(r.updates).toHaveLength(0);
  });

  it('blocks a preexisting acceptance with no write', async () => {
    const r = await route(collision({ [ACCEPT_KEY]: acceptance() }));
    expect(r.out).toEqual({ kind: 'blocked' });
    expect(r.updates).toHaveLength(0);
  });

  it('blocks a malformed offer with no write', async () => {
    const r = await route(
      collision({ [OFFER_KEY]: offer({ expiresAt: PIN }) }),
      { text: 'NO' },
    );
    expect(r.out).toEqual({ kind: 'blocked' });
    expect(r.updates).toHaveLength(0);
  });

  it('fences when the offer is absent so the receipt flow can route', async () => {
    const r = await route(collision({ [OFFER_KEY]: null }));
    expect(r.out).toEqual({ kind: 'fenced' });
    expect(r.updates).toHaveLength(0);
  });

  it('wins over a matching decline replay without a false replay', async () => {
    const r = await route(collision({ [RECEIPT_KEY]: receipt() }));
    expect(r.out).toEqual({ kind: 'blocked' });
    expect(r.updates).toHaveLength(0);
  });
});

/**
 * SCA-4b3: a present row whose `data` is not a plain object is malformed
 * durable state and must fail closed as a terminal `blocked` — never the
 * `fenced` fall-through that would hand the turn to the LLM. Only a genuinely
 * absent row (`get` → null) fences. A throwing `state.data` accessor must
 * propagate instead of being swallowed as a fence or block.
 */
const withState = (state: ConversationState) => {
  const conversations: ShippingCustomerResponseConversations = {
    get: jest.fn(async () => state),
    update: jest.fn(async () => stateOf(base())),
  };
  return {
    router: new Router(conversations, () => Date.parse(NOW)),
    conversations,
  };
};

const withData = (data: unknown) =>
  withState({
    senderId: SENDER,
    lastMessageAt: NOW,
    // SAFETY: casts deliberately-malformed bytes into the typed row the store
    // would hand back, so the router guard itself is what is exercised.
    data: data as ConversationStateData,
  });

describe('ShippingCustomerResponseRouter (malformed durable data)', () => {
  it('fences an absent row but blocks a present row with null data', async () => {
    const absent = await route(null);
    expect(absent.out).toEqual({ kind: 'fenced' });
    expect(absent.updates).toHaveLength(0);
    const present = withData(null);
    expect(await present.router.route(input())).toEqual({ kind: 'blocked' });
    expect(present.conversations.update).not.toHaveBeenCalled();
  });

  const TABLE: [string, unknown][] = [
    ['null', null],
    ['a string', 'not-an-object'],
    ['an array', ['malformed']],
    ['a class instance', new Set<number>([1])],
  ];
  it.each(TABLE)('blocks %s data with no write', async (_label, data) => {
    const ctx = withData(data);
    expect(await ctx.router.route(input())).toEqual({ kind: 'blocked' });
    expect(ctx.conversations.update).not.toHaveBeenCalled();
  });

  it('propagates a throwing data getter instead of fencing or blocking', async () => {
    const state: ConversationState = {
      senderId: SENDER,
      lastMessageAt: NOW,
      get data(): ConversationStateData {
        throw new Error('data-boom');
      },
    };
    const ctx = withState(state);
    await expect(ctx.router.route(input())).rejects.toThrow('data-boom');
    expect(ctx.conversations.update).not.toHaveBeenCalled();
  });
});

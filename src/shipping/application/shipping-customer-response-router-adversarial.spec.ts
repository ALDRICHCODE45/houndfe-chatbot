/**
 * SCA-4b2: adversarial test-only matrix for the deterministic customer-response
 * router — the guard, dedup-replay and cancellation cases moved out of the b1
 * core spec plus the boundary inputs (invalid identity, old/expired YES, invalid
 * timestamp, price drift, accepted-replay rejection, late-NO cancellation,
 * decline replay, malformed-offer no-clear, pending human, store failure).
 * Consumes the shared b0 fixture and b1 harness; adds no production behavior.
 */
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
} from '../../../test/fixtures/shipping-customer-response-router-fixture';
import {
  failingConversations,
  route,
  setup,
} from '../../../test/fixtures/shipping-customer-response-router-harness';
import { ShippingCustomerResponseRouter as Router } from './shipping-customer-response-router';

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
    expect(patch?.receiptAmountPointer).toEqual(SIBLINGS.receiptAmountPointer);
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

/**
 * SCA-4b1: core deterministic customer-response router contract tests (the send
 * surface, fenced fall-through, exact acceptance write, exact-replay/different-id
 * fence and declined-before-ack cancellation). Guard and adversarial cases live
 * in the sibling `shipping-customer-response-router-adversarial.spec.ts`; both
 * consume the test-only fixture (b0) and harness. No send, LLM, provider or
 * dispatcher wiring.
 */
import type { ConversationStateData } from '../../conversation/domain/conversation-store';
import {
  ACCEPT_KEY,
  APPROVAL,
  CONTEXT,
  DRAFT,
  OFFER_KEY,
  PIN,
  RECEIPT_KEY,
  REPLAY_ID,
  SENDER,
  acceptance,
  base,
  receipt,
} from '../../../test/fixtures/shipping-customer-response-router-fixture';
import { route } from '../../../test/fixtures/shipping-customer-response-router-harness';
import { ShippingCustomerResponseRouter as Router } from './shipping-customer-response-router';

describe('ShippingCustomerResponseRouter (core)', () => {
  it('exposes only route: no send surface', () => {
    expect(Object.getOwnPropertyNames(Router.prototype).sort()).toEqual([
      'constructor',
      'route',
    ]);
  });

  it('fences when no offer, acceptance or matching tombstone exists', async () => {
    const missing = await route(base({ [OFFER_KEY]: null }));
    expect(missing.out).toEqual({ kind: 'fenced' });
    expect(missing.updates).toHaveLength(0);
    expect((await route(null)).out).toEqual({ kind: 'fenced' });
    const stale = await route(
      base({
        [OFFER_KEY]: null,
        [ACCEPT_KEY]: null,
        [RECEIPT_KEY]: receipt({ inboundMessageId: REPLAY_ID }),
      }),
    );
    expect(stale.out).toEqual({ kind: 'fenced' });
    expect(stale.updates).toHaveLength(0);
  });

  it('records the exact acceptance in one write without a model or send', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const r = await route(base());
    expect(r.out).toEqual({ kind: 'accepted', acceptance: acceptance() });
    expect(r.conversations.update).toHaveBeenCalledWith(SENDER, {
      lastMessageAt: PIN,
      data: { ...base(), [ACCEPT_KEY]: acceptance() },
    });
    expect(r.updates).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('replays only an exact duplicate acceptance and blocks a different id', async () => {
    const stored = base({ [ACCEPT_KEY]: acceptance() });
    const same = await route(stored);
    expect(same.out).toEqual({
      kind: 'replayed_accept',
      acceptance: acceptance(),
    });
    expect(same.updates).toHaveLength(0);
    const other = await route(stored, { sourceWebhookMessageId: REPLAY_ID });
    expect(other.out).toEqual({ kind: 'blocked' });
    expect(other.updates).toHaveLength(0);
  });

  it('cancels offer, acceptance and approval and drops draft/context before returning', async () => {
    const r = await route(base({ [ACCEPT_KEY]: acceptance() }), { text: 'NO' });
    const expected: ConversationStateData = {
      ...base({ [ACCEPT_KEY]: acceptance() }),
      [OFFER_KEY]: null,
      [ACCEPT_KEY]: null,
      [APPROVAL]: null,
      [RECEIPT_KEY]: receipt(),
    };
    delete expected[DRAFT];
    delete expected[CONTEXT];
    expect(r.out).toEqual({ kind: 'declined', receipt: receipt() });
    expect(r.updates).toEqual([{ lastMessageAt: PIN, data: expected }]);
    expect(Object.hasOwn(expected, DRAFT)).toBe(false);
    expect(Object.hasOwn(expected, CONTEXT)).toBe(false);
  });
});

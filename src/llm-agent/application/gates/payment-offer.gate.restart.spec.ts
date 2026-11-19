import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import {
  DurablePaymentOffer,
  MINIMAL_PAYMENT_OFFER_TTL_MS,
} from './payment-offer.gate';

const SENDER = '5215550001111';
const SALE = '55555555-5555-4555-8555-555555555555';
const T0 = Date.parse('2026-11-16T12:00:00.000Z');

function world() {
  let now = T0;
  const clock = () => now;
  const store = new InMemoryConversationGateStore(() => new Date(now));
  const boot = () => {
    const gates = new ConversationGates(store, clock);
    return { gates, offers: new DurablePaymentOffer(gates) };
  };
  return {
    store,
    boot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('payment offer gate survives a restart', () => {
  it('restores the offered sale in a new process', async () => {
    const w = world();
    const first = w.boot();
    first.offers.offer(SENDER, SALE);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    expect(restarted.offers.read(SENDER)).toBeNull();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toEqual({ saleId: SALE });
  });

  it('is stored for five minutes and absent after that', async () => {
    const w = world();
    const first = w.boot();
    first.offers.offer(SENDER, SALE);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    await expect(w.store.get(SENDER, 'payment_offer')).resolves.toMatchObject({
      payload: { saleId: SALE },
      expiresAt: new Date(T0 + MINIMAL_PAYMENT_OFFER_TTL_MS),
    });
    expect(MINIMAL_PAYMENT_OFFER_TTL_MS).toBe(5 * 60 * 1000);
    w.advance(MINIMAL_PAYMENT_OFFER_TTL_MS);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toBeNull();
  });

  it('clearing deletes the durable row', async () => {
    const w = world();
    const first = w.boot();
    first.offers.offer(SENDER, SALE);
    first.gates.touch(SENDER);
    first.offers.clear(SENDER);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    await expect(w.store.get(SENDER, 'payment_offer')).resolves.toBeNull();
  });

  it.each([{ saleId: 'not-a-uuid' }, { saleId: SALE, extra: true }, {}])(
    'treats the malformed payload %j as absent and removes it',
    async (p) => {
      const w = world();
      await w.store.put({
        senderId: SENDER,
        kind: 'payment_offer',
        payload: p,
        expiresAt: new Date(T0 + 60_000),
      });
      const restarted = w.boot();
      await restarted.gates.begin(SENDER);
      expect(restarted.offers.read(SENDER)).toBeNull();
      await expect(w.store.get(SENDER, 'payment_offer')).resolves.toBeNull();
    },
  );
});

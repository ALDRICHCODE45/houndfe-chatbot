import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import {
  BACKORDER_OFFER_TTL_MS,
  DurableBackorderOffer,
  type BackorderOfferData,
} from './backorder-offer.gate';
import {
  BACKORDER_QUANTITY_TTL_MS,
  DurableBackorderQuantity,
} from './backorder-quantity.gate';

const SENDER = '5215550001111';
const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const OTHER = '77777777-7777-4777-8777-777777777777';
const VARIANT = '88888888-8888-4888-8888-888888888888';
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const OFFER: BackorderOfferData = {
  decisionId: DECISION,
  productId: PRODUCT,
  variantId: null,
  productName: 'Collar',
  estimatedAt: '2026-11-23T12:00:00.000Z',
  statedQuantity: null,
};

function world() {
  let now = T0;
  const clock = () => now;
  const store = new InMemoryConversationGateStore(() => new Date(now));
  const boot = () => {
    const gates = new ConversationGates(store, clock);
    return {
      gates,
      offers: new DurableBackorderOffer(gates),
      quantities: new DurableBackorderQuantity(gates),
    };
  };
  return {
    store,
    boot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('backorder offer gate survives a restart', () => {
  it('restores the armed offer in a new process', async () => {
    const w = world();
    const first = w.boot();
    first.offers.arm(SENDER, { ...OFFER, statedQuantity: 3 });
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    expect(restarted.offers.read(SENDER)).toBeNull();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toMatchObject({
      ...OFFER,
      statedQuantity: 3,
      stage: 'offer',
      quantity: null,
    });
  });

  it('is stored for 24 h with the documented payload and absent after that', async () => {
    const w = world();
    const first = w.boot();
    first.offers.arm(SENDER, OFFER);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    expect(BACKORDER_OFFER_TTL_MS).toBe(24 * 60 * 60 * 1000);
    await expect(w.store.get(SENDER, 'backorder_offer')).resolves.toMatchObject(
      {
        payload: { ...OFFER, stage: 'offer', quantity: null },
        expiresAt: new Date(T0 + BACKORDER_OFFER_TTL_MS),
      },
    );
    w.advance(BACKORDER_OFFER_TTL_MS);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toBeNull();
  });

  it('keeps the asked-quantity stage across a restart without moving the expiry', async () => {
    const w = world();
    const first = w.boot();
    first.offers.arm(SENDER, OFFER);
    first.gates.touch(SENDER);
    w.advance(60_000);
    first.offers.update(SENDER, { stage: 'ask_quantity' });
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toMatchObject({
      stage: 'ask_quantity',
      expiresAt: T0 + BACKORDER_OFFER_TTL_MS,
    });
  });

  it.each([
    [{ mode: 'existing', customerId: '22222222-2222-4222-8222-222222222222' }],
    [{ mode: 'createIfAbsent', firstName: 'Rosa' }],
  ] as const)(
    'keeps the retry stage with the first request’s count and customer %j across a restart (L11)',
    async (customer) => {
      const w = world();
      const first = w.boot();
      first.offers.arm(SENDER, OFFER);
      first.gates.touch(SENDER);
      first.offers.update(SENDER, {
        stage: 'retry',
        quantity: 3,
        customer: { ...customer },
      });
      first.gates.touch(SENDER);
      await first.gates.settle(SENDER);
      const restarted = w.boot();
      await restarted.gates.begin(SENDER);
      expect(restarted.offers.read(SENDER)).toMatchObject({
        stage: 'retry',
        quantity: 3,
        customer,
        expiresAt: T0 + BACKORDER_OFFER_TTL_MS,
      });
    },
  );

  it('a row written before the retry stage existed (no customer) still loads', async () => {
    const w = world();
    await w.store.put({
      senderId: SENDER,
      kind: 'backorder_offer',
      payload: { ...OFFER, stage: 'ask_quantity', quantity: null },
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toMatchObject({
      stage: 'ask_quantity',
      customer: null,
    });
  });

  it('claim spends the durable row once (a second process finds nothing)', async () => {
    const w = world();
    const first = w.boot();
    first.offers.arm(SENDER, OFFER);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    await expect(
      first.gates.claim(SENDER, 'backorder_offer', { decisionId: DECISION }),
    ).resolves.toBe(true);
    await expect(
      first.gates.claim(SENDER, 'backorder_offer', { decisionId: DECISION }),
    ).resolves.toBe(false);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toBeNull();
  });

  it('clearing deletes the durable row', async () => {
    const w = world();
    const first = w.boot();
    first.offers.arm(SENDER, OFFER);
    first.gates.touch(SENDER);
    first.offers.clear(SENDER);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    await expect(w.store.get(SENDER, 'backorder_offer')).resolves.toBeNull();
  });

  it.each([
    { ...OFFER, decisionId: 'not-a-uuid', stage: 'offer', quantity: null },
    { ...OFFER, stage: 'who-knows', quantity: null },
    { ...OFFER, statedQuantity: 0, stage: 'offer', quantity: null },
    { ...OFFER, stage: 'offer', quantity: null, extra: true },
    { decisionId: DECISION },
    { ...OFFER, stage: 'retry', quantity: 2, customer: { mode: 'other' } },
    {
      ...OFFER,
      stage: 'retry',
      quantity: 2,
      customer: { mode: 'existing', customerId: 'nope' },
    },
    {
      ...OFFER,
      stage: 'retry',
      quantity: 2,
      customer: { mode: 'createIfAbsent', firstName: 'Rosa', extra: 1 },
    },
  ])('treats the malformed payload %j as absent and removes it', async (p) => {
    const w = world();
    await w.store.put({
      senderId: SENDER,
      kind: 'backorder_offer',
      payload: p,
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.offers.read(SENDER)).toBeNull();
    await expect(w.store.get(SENDER, 'backorder_offer')).resolves.toBeNull();
  });
});

describe('backorder quantity note survives a restart', () => {
  it('restores the stated count per product/variant topic', async () => {
    const w = world();
    const first = w.boot();
    first.quantities.note(SENDER, PRODUCT, null, 3);
    first.quantities.note(SENDER, PRODUCT, VARIANT, 5);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.quantities.read(SENDER, PRODUCT, null)).toBe(3);
    expect(restarted.quantities.read(SENDER, PRODUCT, VARIANT)).toBe(5);
    expect(restarted.quantities.read(SENDER, OTHER, null)).toBeNull();
  });

  it('a newer note for the same topic replaces the older one; take removes it', () => {
    const first = world().boot();
    first.quantities.note(SENDER, PRODUCT, null, 3);
    first.quantities.note(SENDER, PRODUCT, null, 4);
    expect(first.quantities.read(SENDER, PRODUCT, null)).toBe(4);
    expect(first.quantities.take(SENDER, PRODUCT, null)).toBe(4);
    expect(first.quantities.read(SENDER, PRODUCT, null)).toBeNull();
  });

  it.each([0, 1, -2, 1.5, 1000, Number.NaN])(
    'refuses the count %p (only 2..999 is a stated count)',
    (count) => {
      const first = world().boot();
      first.quantities.note(SENDER, PRODUCT, null, count);
      expect(first.quantities.read(SENDER, PRODUCT, null)).toBeNull();
    },
  );

  it('lives 48 h and is absent after that', async () => {
    const w = world();
    const first = w.boot();
    first.quantities.note(SENDER, PRODUCT, null, 3);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    expect(BACKORDER_QUANTITY_TTL_MS).toBe(48 * 60 * 60 * 1000);
    w.advance(BACKORDER_QUANTITY_TTL_MS);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.quantities.read(SENDER, PRODUCT, null)).toBeNull();
  });

  it('treats a malformed payload as absent and removes it', async () => {
    const w = world();
    await w.store.put({
      senderId: SENDER,
      kind: 'backorder_quantity',
      payload: { items: [{ topic: 'nope', quantity: 3 }] },
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.quantities.read(SENDER, PRODUCT, null)).toBeNull();
    await expect(w.store.get(SENDER, 'backorder_quantity')).resolves.toBeNull();
  });
});

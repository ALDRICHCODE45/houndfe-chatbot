import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import type { MinimalCheckoutDraft } from '../../../conversation/domain/minimal-checkout-draft';
import {
  MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS,
  MINIMAL_CHECKOUT_CONFIRMED_REPLY,
  MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
} from '../../domain/minimal-checkout-confirmation';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_CONFIRMATION_TTL_MS,
  evaluateMinimalPickupOrder,
  renderMinimalOrderSummary,
  type MinimalOrderSnapshot,
} from '../../domain/minimal-order-confirmation';
import {
  DurableCheckoutConfirmation,
  MINIMAL_CHECKOUT_CONFIRMED_TTL_MS,
} from './checkout-confirmation.gate';
import { DurableOrderConfirmation } from './order-confirmation.gate';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-11-09T16:00:00.000Z');
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

/** One durable store shared by every "process" booted from it. */
function world() {
  let now = T0;
  const clock = () => now;
  const store = new InMemoryConversationGateStore(() => new Date(now));
  return {
    store,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    gates: () => new ConversationGates(store, clock),
  };
}

const pickupSnapshot = (): MinimalOrderSnapshot => {
  const verdict = evaluateMinimalPickupOrder({
    quote: {
      items: [
        {
          productId: PRODUCT,
          name: 'Croquetas',
          quantity: 2,
          unitPriceCents: 1500,
          finalPriceCents: 3000,
        },
      ],
      totalCents: 3000,
      promotionEvaluationStatus: 'fully_evaluated',
    },
    customerId: '',
    customer: { firstName: 'Ana', lastName: null },
  });
  if (!verdict.ok) throw new Error('expected an eligible pickup order');
  return verdict.snapshot;
};

const newAddressDraft = (): MinimalCheckoutDraft => ({
  schemaVersion: 1,
  senderId: SENDER,
  revision: 2,
  sourceCustomerId: null,
  customer: { firstName: 'Ana', lastName: 'Pérez' },
  address: {
    kind: 'new',
    fields: {
      label: null,
      street: 'Calle 5',
      exteriorNumber: 'S/N',
      interiorNumber: null,
      zipCode: '06700',
      neighborhood: 'Roma',
      municipality: null,
      city: 'CDMX',
      state: 'Ciudad de México',
      visualReferences: null,
      carrierPhone: null,
    },
  },
});

describe('order confirmation gate survives a restart (S4)', () => {
  const boot = (w: ReturnType<typeof world>) => {
    const gates = w.gates();
    return { gates, order: new DurableOrderConfirmation(gates) };
  };

  async function armedOffer(w: ReturnType<typeof world>) {
    const first = boot(w);
    const offer = first.order.prepare({
      senderId: SENDER,
      inboundEvent: EVENT('wamid.offer'),
      snapshot: pickupSnapshot(),
    });
    if (offer.kind !== 'offer') throw new Error('expected an offer');
    offer.onSent();
    await expect(first.gates.settle(SENDER)).resolves.toBe(true);
    return offer;
  }

  it('a new process restores the armed offer and SÍ yields the same candidate', async () => {
    const w = world();
    const offer = await armedOffer(w);
    const restarted = boot(w);
    await restarted.gates.begin(SENDER);
    expect(restarted.order.status(SENDER)).toEqual({
      reference: offer.reference,
      armed: true,
      expiresAt: T0 + MINIMAL_ORDER_CONFIRMATION_TTL_MS,
    });
    await expect(
      restarted.order.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT('wamid.yes'),
      }),
    ).resolves.toEqual({
      kind: 'candidate',
      reference: offer.reference,
      snapshot: pickupSnapshot(),
    });
  });

  it('the origin replay re-presents the identical summary after a restart', async () => {
    const w = world();
    await armedOffer(w);
    const restarted = boot(w);
    await restarted.gates.begin(SENDER);
    await expect(
      restarted.order.consume({
        senderId: SENDER,
        text: 'hacer pedido',
        inboundEvent: EVENT('wamid.offer'),
      }),
    ).resolves.toMatchObject({
      kind: 'reoffer',
      reply: renderMinimalOrderSummary(pickupSnapshot()),
    });
  });

  it('is absent after the five-minute TTL', async () => {
    const w = world();
    await armedOffer(w);
    w.advance(MINIMAL_ORDER_CONFIRMATION_TTL_MS);
    const restarted = boot(w);
    await restarted.gates.begin(SENDER);
    expect(restarted.order.status(SENDER)).toBeNull();
    await expect(
      restarted.order.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT('wamid.yes'),
      }),
    ).resolves.toBeNull();
  });

  it('is single-use across two processes that both loaded it', async () => {
    const w = world();
    await armedOffer(w);
    const a = boot(w);
    const b = boot(w);
    await Promise.all([a.gates.begin(SENDER), b.gates.begin(SENDER)]);
    const results = await Promise.all(
      [a, b].map((p, i) =>
        p.order.consume({
          senderId: SENDER,
          text: 'SÍ',
          inboundEvent: EVENT(`wamid.yes.${i}`),
        }),
      ),
    );
    expect(results.filter((r) => r?.kind === 'candidate')).toHaveLength(1);
    expect(results).toContainEqual({
      kind: 'handled',
      reply: MINIMAL_ORDER_AMBIGUOUS_REPLY,
    });
  });

  it('a decline is durable: a later SÍ after a restart creates nothing', async () => {
    const w = world();
    await armedOffer(w);
    const a = boot(w);
    await a.gates.begin(SENDER);
    await a.order.consume({
      senderId: SENDER,
      text: 'no',
      inboundEvent: EVENT('wamid.no'),
    });
    await a.gates.settle(SENDER);
    const b = boot(w);
    await b.gates.begin(SENDER);
    expect(b.order.status(SENDER)).toBeNull();
  });
});

describe('checkout confirmation gates survive a restart (S4)', () => {
  const boot = (w: ReturnType<typeof world>) => {
    const gates = w.gates();
    return { gates, checkout: new DurableCheckoutConfirmation(gates) };
  };

  async function armedOffer(w: ReturnType<typeof world>) {
    const first = boot(w);
    const offer = first.checkout.prepare({
      senderId: SENDER,
      inboundEvent: EVENT('wamid.offer'),
      draft: newAddressDraft(),
    });
    if (offer.kind !== 'offer') throw new Error('expected an offer');
    offer.onSent();
    await first.gates.settle(SENDER);
    return offer;
  }

  const confirm = async (p: ReturnType<typeof boot>, messageId: string) => {
    const candidate = p.checkout.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT(messageId),
      draft: newAddressDraft(),
    });
    if (candidate?.kind !== 'candidate') return candidate;
    return p.checkout.finalize({
      senderId: SENDER,
      candidate,
      committed: true,
    });
  };

  it('the pending offer and then the confirmation survive restarts', async () => {
    const w = world();
    const offer = await armedOffer(w);
    const b = boot(w);
    await b.gates.begin(SENDER);
    expect(b.checkout.status(SENDER)).toMatchObject({
      stage: 'pending',
      reference: offer.reference,
      armed: true,
      expiresAt: T0 + MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS,
    });
    await expect(confirm(b, 'wamid.yes')).resolves.toEqual({
      kind: 'confirmed',
      reply: MINIMAL_CHECKOUT_CONFIRMED_REPLY,
    });
    await b.gates.settle(SENDER);

    const c = boot(w);
    await c.gates.begin(SENDER);
    expect(c.checkout.status(SENDER)).toMatchObject({ stage: 'confirmed' });
    expect(c.checkout.confirmedDraft(SENDER, newAddressDraft())).toEqual(
      newAddressDraft(),
    );
  });

  it('the pending offer is absent after the five-minute TTL', async () => {
    const w = world();
    await armedOffer(w);
    w.advance(MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS);
    const b = boot(w);
    await b.gates.begin(SENDER);
    expect(b.checkout.status(SENDER)).toBeNull();
  });

  it('the confirmation expires after its own TTL', async () => {
    const w = world();
    await armedOffer(w);
    const b = boot(w);
    await b.gates.begin(SENDER);
    await confirm(b, 'wamid.yes');
    await b.gates.settle(SENDER);
    w.advance(MINIMAL_CHECKOUT_CONFIRMED_TTL_MS);
    const c = boot(w);
    await c.gates.begin(SENDER);
    expect(c.checkout.confirmedDraft(SENDER, newAddressDraft())).toBeNull();
  });

  it('only one of two processes finalizes the same pending', async () => {
    const w = world();
    await armedOffer(w);
    const a = boot(w);
    const b = boot(w);
    await Promise.all([a.gates.begin(SENDER), b.gates.begin(SENDER)]);
    const results = await Promise.all([
      confirm(a, 'wamid.yes.a'),
      confirm(b, 'wamid.yes.b'),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        { kind: 'confirmed', reply: MINIMAL_CHECKOUT_CONFIRMED_REPLY },
        { kind: 'not_confirmed', reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY },
      ]),
    );
  });
});

import type { StockCheckResponse } from '../../../chatbot-api/domain/dtos/catalog.dto';
import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import * as preflight from '../../../human-decisions/application/restock-request-preflight';
import { MinimalRestockRequestService } from '../minimal-restock-request.service';
import { BackorderGates } from './backorder.gates';

/**
 * Restock backorder S14: the RESTOCK request stores no quantity, so the count
 * the customer stated when asking waits in the `backorder_quantity` gate until
 * the estimate arrives. It is captured when the RESTOCK question is prepared
 * (it travels in the durable `restock_pending` row for the 5-minute question)
 * and written once the request is recorded.
 */
const SENDER = '5215550001111';
const PRODUCT = '00000000-0000-4000-8000-000000000001';
const VARIANT = '00000000-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-11-20T16:00:00.000Z');
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});
const INTAKE = {
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: 'Croquetas',
};
const stock = (withVariant: boolean): StockCheckResponse => ({
  productId: PRODUCT,
  name: 'Croquetas',
  stock: { status: 'out_of_stock', quantity: 0 },
  variants: withVariant
    ? [
        {
          variantId: VARIANT,
          name: 'Pollo',
          option: null,
          value: null,
          stock: { status: 'out_of_stock', quantity: 0 },
        },
      ]
    : [],
});

function world(withVariant = false) {
  const now = T0;
  const clock = () => now;
  const gateStore = new InMemoryConversationGateStore(() => new Date(now));
  const coordinate = jest.fn(() =>
    Promise.resolve({ decision: 'recorded', historicalPollId: 'POLL' }),
  );
  const boot = () => {
    const gates = new ConversationGates(gateStore, clock);
    const backorder = new BackorderGates(gates);
    const service = new MinimalRestockRequestService({
      chatbotApi: {
        getStock: jest.fn(() => Promise.resolve(stock(withVariant))),
      } as never,
      store: { get: jest.fn(() => Promise.resolve(null)) } as never,
      restock: {
        markers: {},
        coordinator: { coordinate },
        recovery: { recover: jest.fn() },
      } as never,
      clock,
      gates,
      backorderQuantities: backorder.quantities,
    });
    return { gates, service, quantities: backorder.quantities };
  };
  return { boot, coordinate, store: gateStore };
}

async function ask(
  b: ReturnType<ReturnType<typeof world>['boot']>,
  extra: Record<string, unknown> = {},
  variant = false,
) {
  const offer = await b.service.prepare({
    senderId: SENDER,
    inboundEvent: EVENT('wamid.question'),
    allowedProductIds: new Set([PRODUCT]),
    productId: PRODUCT,
    ...(variant ? { variantId: VARIANT } : {}),
    ...extra,
  });
  if (offer.kind !== 'offer') throw new Error('expected an offer');
  offer.onSent();
  await b.gates.settle(SENDER);
}
const yes = (b: ReturnType<ReturnType<typeof world>['boot']>) =>
  b.service.consume({
    senderId: SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('wamid.yes'),
  });

describe('the stated count is kept when the RESTOCK request is recorded (S14)', () => {
  beforeEach(() => {
    jest
      .spyOn(preflight, 'preflightRestockRequest')
      .mockResolvedValue({ route: 'restock', intake: INTAKE } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('notes the count for the product once the request is recorded', async () => {
    const w = world();
    const b = w.boot();
    await ask(b, { statedQuantity: 3 });
    // Nothing is noted while the question is still open.
    expect(b.quantities.read(SENDER, PRODUCT, null)).toBeNull();
    await yes(b);
    expect(w.coordinate).toHaveBeenCalledTimes(1);
    expect(b.quantities.read(SENDER, PRODUCT, null)).toBe(3);
    await b.gates.settle(SENDER);
    await expect(
      w.store.get(SENDER, 'backorder_quantity'),
    ).resolves.not.toBeNull();
  });

  it('notes the count for the exact variant topic', async () => {
    const w = world(true);
    const b = w.boot();
    await ask(b, { statedQuantity: 4 }, true);
    await yes(b);
    expect(b.quantities.read(SENDER, PRODUCT, VARIANT)).toBe(4);
    expect(b.quantities.read(SENDER, PRODUCT, null)).toBeNull();
  });

  it('survives the 5-minute question across a restart (it rides the restock_pending row)', async () => {
    const w = world();
    const first = w.boot();
    await ask(first, { statedQuantity: 5 });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    await yes(restarted);
    expect(restarted.quantities.read(SENDER, PRODUCT, null)).toBe(5);
  });

  it('survives a restart after the request too (the estimate comes hours later)', async () => {
    const w = world();
    const first = w.boot();
    await ask(first, { statedQuantity: 2 });
    await yes(first);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.quantities.read(SENDER, PRODUCT, null)).toBe(2);
  });

  it('no stated count notes nothing (the bot will ask)', async () => {
    const w = world();
    const b = w.boot();
    await ask(b);
    await yes(b);
    expect(w.coordinate).toHaveBeenCalledTimes(1);
    expect(b.quantities.read(SENDER, PRODUCT, null)).toBeNull();
  });

  it('a later request without a count never erases an earlier note', async () => {
    const w = world();
    const b = w.boot();
    await ask(b, { statedQuantity: 3 });
    await yes(b);
    await ask(b);
    await yes(b);
    expect(b.quantities.read(SENDER, PRODUCT, null)).toBe(3);
  });

  it('a declined question notes nothing', async () => {
    const w = world();
    const b = w.boot();
    await ask(b, { statedQuantity: 3 });
    await b.service.consume({
      senderId: SENDER,
      text: 'NO',
      inboundEvent: EVENT('wamid.no'),
    });
    expect(b.quantities.read(SENDER, PRODUCT, null)).toBeNull();
  });

  it('a request that was not recorded notes nothing', async () => {
    const w = world();
    w.coordinate.mockResolvedValue({ decision: 'hold' } as never);
    const b = w.boot();
    await ask(b, { statedQuantity: 3 });
    await yes(b);
    expect(b.quantities.read(SENDER, PRODUCT, null)).toBeNull();
  });

  it.each([1, 0, -3, 1000, 2.5])(
    'an invalid count (%p) is not a stated count',
    async (count) => {
      const w = world();
      const b = w.boot();
      await ask(b, { statedQuantity: count });
      await yes(b);
      expect(b.quantities.read(SENDER, PRODUCT, null)).toBeNull();
    },
  );

  it('works without the quantity gate wired (the question still records)', async () => {
    const gates = new ConversationGates(
      new InMemoryConversationGateStore(() => new Date(T0)),
      () => T0,
    );
    const service = new MinimalRestockRequestService({
      chatbotApi: {
        getStock: jest.fn(() => Promise.resolve(stock(false))),
      } as never,
      store: { get: jest.fn(() => Promise.resolve(null)) } as never,
      restock: {
        markers: {},
        coordinator: {
          coordinate: jest.fn(() =>
            Promise.resolve({ decision: 'recorded', historicalPollId: 'P' }),
          ),
        },
        recovery: { recover: jest.fn() },
      } as never,
      clock: () => T0,
      gates,
    });
    const offer = await service.prepare({
      senderId: SENDER,
      inboundEvent: EVENT('wamid.question'),
      allowedProductIds: new Set([PRODUCT]),
      productId: PRODUCT,
      statedQuantity: 3,
    });
    if (offer.kind !== 'offer') throw new Error('expected an offer');
    offer.onSent();
    await expect(
      service.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT('wamid.yes'),
      }),
    ).resolves.toMatchObject({ kind: 'handled' });
  });
});

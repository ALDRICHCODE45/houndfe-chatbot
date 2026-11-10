import type { StockCheckResponse } from '../../../chatbot-api/domain/dtos/catalog.dto';
import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import { CatalogSession } from '../../../conversation/domain/catalog-references';
import * as preflight from '../../../human-decisions/application/restock-request-preflight';
import {
  MINIMAL_RESTOCK_AMBIGUOUS_REPLY,
  MINIMAL_RESTOCK_CLARIFY_REPLY,
  MINIMAL_RESTOCK_PENDING_TTL_MS,
  MinimalRestockRequestService,
} from '../minimal-restock-request.service';

const SENDER = '5215550001111';
const PRODUCT = '00000000-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-11-09T16:00:00.000Z');
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
const CONFIRMED = {
  kind: 'handled',
  reply:
    '¡Listo! 😊 Ya quedó registrada su consulta sobre la reposición de «Croquetas». ¡Gracias!',
};
const stock: StockCheckResponse = {
  productId: PRODUCT,
  name: 'Croquetas',
  stock: { status: 'out_of_stock', quantity: 0 },
  variants: [],
};

function world() {
  let now = T0;
  const clock = () => now;
  const gateStore = new InMemoryConversationGateStore(() => new Date(now));
  const coordinate = jest.fn(() =>
    Promise.resolve({ decision: 'recorded', historicalPollId: 'POLL' }),
  );
  const boot = () => {
    const gates = new ConversationGates(gateStore, clock);
    const service = new MinimalRestockRequestService({
      chatbotApi: { getStock: jest.fn(() => Promise.resolve(stock)) } as never,
      store: { get: jest.fn(() => Promise.resolve(null)) } as never,
      restock: {
        markers: {},
        coordinator: { coordinate },
        recovery: { recover: jest.fn() },
      } as never,
      clock,
      gates,
    });
    return { gates, service };
  };
  return {
    boot,
    coordinate,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function armedQuestion(w: ReturnType<typeof world>) {
  const first = w.boot();
  const offer = await first.service.prepare({
    senderId: SENDER,
    inboundEvent: EVENT('wamid.question'),
    allowedProductIds: new Set([PRODUCT]),
    productId: PRODUCT,
  });
  if (offer.kind !== 'offer') throw new Error('expected an offer');
  offer.onSent();
  await first.gates.settle(SENDER);
  return offer;
}

const say = (
  p: ReturnType<ReturnType<typeof world>['boot']>,
  text: string,
  messageId: string,
  classify?: () => Promise<'accept' | 'decline' | 'unclear'>,
) =>
  p.service.consume({
    senderId: SENDER,
    text,
    inboundEvent: EVENT(messageId),
    ...(classify === undefined ? {} : { classify }),
  });

describe('pending RESTOCK question survives a restart (S4)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('an armed question asked before the restart accepts the SÍ once', async () => {
    const route = jest
      .spyOn(preflight, 'preflightRestockRequest')
      .mockResolvedValue({ route: 'restock', intake: INTAKE } as never);
    const w = world();
    await armedQuestion(w);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    await expect(say(restarted, 'SÍ', 'wamid.yes')).resolves.toEqual(CONFIRMED);
    const [input] = route.mock.calls[0];
    expect(input).toMatchObject({
      senderId: SENDER,
      digest: { productId: PRODUCT, name: 'Croquetas' },
    });
    expect(CatalogSession.is(input.catalogSession)).toBe(true);
    expect(w.coordinate).toHaveBeenCalledTimes(1);
  });

  it('the origin replay re-asks the identical question after a restart', async () => {
    const w = world();
    const offer = await armedQuestion(w);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    await expect(say(restarted, 'SÍ', 'wamid.question')).resolves.toMatchObject(
      { kind: 'handled', reply: offer.reply },
    );
  });

  it('a classified message id stays memoized across the restart', async () => {
    const w = world();
    await armedQuestion(w);
    const first = w.boot();
    await first.gates.begin(SENDER);
    await say(first, 'mmm quizá', 'wamid.maybe', () =>
      Promise.resolve('unclear'),
    );
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    const classify = jest.fn(() => Promise.resolve('accept' as const));
    await expect(
      say(restarted, 'mmm quizá', 'wamid.maybe', classify),
    ).resolves.toEqual({
      kind: 'handled',
      reply: MINIMAL_RESTOCK_CLARIFY_REPLY,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('is absent after the five-minute TTL', async () => {
    const w = world();
    await armedQuestion(w);
    w.advance(MINIMAL_RESTOCK_PENDING_TTL_MS);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    await expect(say(restarted, 'SÍ', 'wamid.yes')).resolves.toBeNull();
    expect(w.coordinate).not.toHaveBeenCalled();
  });

  it('is single-use across two processes that both loaded it', async () => {
    jest
      .spyOn(preflight, 'preflightRestockRequest')
      .mockResolvedValue({ route: 'restock', intake: INTAKE } as never);
    const w = world();
    await armedQuestion(w);
    const a = w.boot();
    const b = w.boot();
    await Promise.all([a.gates.begin(SENDER), b.gates.begin(SENDER)]);
    const results = await Promise.all([
      say(a, 'SÍ', 'wamid.yes.a'),
      say(b, 'SÍ', 'wamid.yes.b'),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        CONFIRMED,
        { kind: 'handled', reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY },
      ]),
    );
    expect(w.coordinate).toHaveBeenCalledTimes(1);
  });
});

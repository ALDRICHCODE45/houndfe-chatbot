import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { BackorderOfferRegistry } from '../../backorders/domain/backorder-offer';
import type {
  BackorderBot,
  BackorderClient,
  CreateBackorderInput,
  CreateBackorderResult,
} from '../../backorders/domain/backorder';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import { BackorderGates } from './gates/backorder.gates';
import { MinimalBackorderOfferService } from './minimal-backorder-offer.service';

const SENDER = '5215512349901';
const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_DECISION = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const VARIANT = '88888888-8888-4888-8888-888888888888';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const BACKORDER_ID = '8c1d0000-1111-4222-8333-444455556666';
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
// 27 Nov 03:00 UTC is still 26 Nov 21:00 in Mexico City.
const ESTIMATED_AT = '2026-11-27T03:00:00.000Z';
const SCHEDULE = `backorder:schedule:${DECISION}`;
const DECLINE = `backorder:decline:${DECISION}`;

const backorder = (overrides: Partial<BackorderBot> = {}): BackorderBot => ({
  id: BACKORDER_ID,
  folio: 'BO-000012',
  status: 'WAITING',
  productId: PRODUCT,
  productName: 'Croquetas Adulto 18 kg',
  variantId: null,
  variantName: null,
  quantity: 2,
  referencePriceCents: 114900,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: '2026-11-20T12:00:00.000Z',
  estimatedAt: ESTIMATED_AT,
  estimatedArrivalDays: 7,
  reservedAt: null,
  reservedUntil: null,
  reminderAt: null,
  queuePosition: 1,
  saleId: null,
  cancelledByKind: null,
  cancelReason: null,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
  ...overrides,
});
const replyOf = (turn: { kind: string; reply?: string } | null): string =>
  turn?.kind === 'reply' ? (turn.reply ?? '') : '';
const apiError = (status: number | null, code: string | null, body = {}) =>
  new ChatbotApiError('x', status, { error: code, ...body }, code);

const OFFER = {
  senderId: SENDER,
  decisionId: DECISION,
  productId: PRODUCT,
  variantId: null,
  productName: 'Croquetas Adulto 18 kg',
  estimatedAt: ESTIMATED_AT,
  statedQuantity: null as number | null,
};

function world(
  options: {
    customer?: unknown;
    profile?: { preferredName?: string; displayName?: string } | null;
  } = {},
) {
  let now = T0;
  const clock = () => now;
  const store = new InMemoryConversationGateStore(() => new Date(now));
  const created = backorder();
  const client = {
    createBackorder: jest
      .fn<Promise<CreateBackorderResult>, [CreateBackorderInput, string]>()
      .mockResolvedValue({ created: true, backorder: created }),
    getBackorder: jest.fn().mockResolvedValue(created),
    listBackorders: jest.fn().mockResolvedValue([]),
    cancelBackorder: jest.fn(),
  } satisfies Record<keyof BackorderClient, jest.Mock>;
  const api = {
    getCustomerCheckoutContext: jest.fn().mockResolvedValue(
      options.customer ?? {
        status: 'unique',
        customer: { customerId: CUSTOMER, firstName: 'Rosa', lastName: null },
        addresses: [],
        nextAfterAddressId: null,
      },
    ),
  };
  const profiles = {
    cached: jest.fn(() => options.profile ?? null),
    load: jest.fn(() => Promise.resolve(options.profile ?? null)),
    record: jest.fn().mockResolvedValue(undefined),
  };
  const boot = () => {
    const gates = new ConversationGates(store, clock);
    const service = new MinimalBackorderOfferService({
      backorders: client,
      chatbotApi: api,
      gates: new BackorderGates(gates),
      profiles: profiles as never,
      clock,
    });
    return { gates, service };
  };
  const first = boot();
  /** A customer turn: begin → handle → settle, like `tryHandle`. */
  const turn = async (
    b: ReturnType<typeof boot>,
    input: { text: string; interactiveReplyId?: string },
  ) => {
    await b.gates.begin(SENDER);
    const result = await b.service.handle({ senderId: SENDER, ...input });
    await b.gates.settle(SENDER);
    return result;
  };
  return {
    ...first,
    boot,
    store,
    client,
    api,
    profiles,
    turn: (input: { text: string; interactiveReplyId?: string }) =>
      turn(first, input),
    turnOn: turn,
    advance: (ms: number) => {
      now += ms;
    },
    arm: async (quantity: number | null = null) => {
      await expect(
        first.service.arm({ ...OFFER, statedQuantity: quantity }),
      ).resolves.toBe(true);
    },
  };
}

const SCHEDULED_REPLY =
  'Listo, quedó agendado su pedido BO-000012: 2 × Croquetas Adulto 18 kg a $1149.00 MXN c/u. Le aviso en cuanto llegue (aprox. el 26 de noviembre); no paga nada hasta entonces.';

describe('arming the offer (called after Meta accepted the estimate)', () => {
  it('has the capability shape the coordinator resolves through the registry', () => {
    const w = world();
    const registry = new BackorderOfferRegistry();
    expect(registry.current()).toBeNull();
    registry.register(w.service);
    expect(registry.current()).toBe(w.service);
  });

  it('writes the durable backorder_offer gate with the documented payload and 24 h expiry', async () => {
    const w = world();
    await w.arm(3);
    await expect(w.store.get(SENDER, 'backorder_offer')).resolves.toMatchObject(
      {
        payload: {
          decisionId: DECISION,
          productId: PRODUCT,
          variantId: null,
          productName: 'Croquetas Adulto 18 kg',
          estimatedAt: ESTIMATED_AT,
          statedQuantity: 3,
        },
        expiresAt: new Date(T0 + 24 * 60 * 60 * 1000),
      },
    );
  });

  it('reads the stated count noted when the RESTOCK request was made, per topic', async () => {
    const w = world();
    const gates = w.service.gates;
    gates.quantities.note(SENDER, PRODUCT, null, 4);
    w.gates.touch(SENDER);
    await w.gates.settle(SENDER);
    const restarted = w.boot();
    await expect(
      restarted.service.statedQuantity(SENDER, PRODUCT, null),
    ).resolves.toBe(4);
    await expect(
      restarted.service.statedQuantity(SENDER, PRODUCT, VARIANT),
    ).resolves.toBeNull();
  });

  it('spends the note when the offer carries it (a later cycle asks again)', async () => {
    const w = world();
    w.service.gates.quantities.note(SENDER, PRODUCT, null, 4);
    w.gates.touch(SENDER);
    await w.arm(4);
    await w.gates.settle(SENDER);
    const restarted = w.boot();
    await expect(
      restarted.service.statedQuantity(SENDER, PRODUCT, null),
    ).resolves.toBeNull();
  });

  it('a newer offer replaces the older one of the sender', async () => {
    const w = world();
    await w.arm();
    await w.service.arm({
      ...OFFER,
      decisionId: OTHER_DECISION,
      productName: 'Collar',
    });
    await expect(
      w.turn({ text: 'sí', interactiveReplyId: SCHEDULE }),
    ).resolves.toEqual({ kind: 'stale' });
  });

  it('answers false (never throws) when the gate cannot be written', async () => {
    const w = world();
    jest.spyOn(w.store, 'put').mockRejectedValue(new Error('down'));
    await expect(w.service.arm(OFFER)).resolves.toBe(false);
  });
});

describe('accepting the offer with a stated count (S1, S14)', () => {
  it.each([
    [
      'the tapped button',
      { text: 'Sí, apártamelo', interactiveReplyId: SCHEDULE },
    ],
    ['a bare yes', { text: 'sí' }],
    ['a polite yes', { text: 'Sí, por favor' }],
  ])('%s schedules the stated count and confirms it', async (_label, input) => {
    const w = world();
    await w.arm(2);
    const result = await w.turn(input);
    expect(result).toEqual({ kind: 'reply', reply: SCHEDULED_REPLY });
    expect(w.client.createBackorder).toHaveBeenCalledTimes(1);
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      {
        phoneCountryCode: '52',
        phone: '5512349901',
        customer: { mode: 'existing', customerId: CUSTOMER },
        productId: PRODUCT,
        variantId: null,
        quantity: 2,
        sourceDecisionId: DECISION,
      },
      `backorder:${DECISION}:${SENDER}`,
    );
    const sent = w.client.createBackorder.mock.calls[0][0] as object;
    expect(Object.keys(sent)).not.toContain('expectedReferencePriceCents');
    expect(w.client.getBackorder).not.toHaveBeenCalled();
  });

  it('states the variant when the backorder has one and sends its id', async () => {
    const w = world();
    w.client.createBackorder.mockResolvedValue({
      created: true,
      backorder: backorder({ variantId: VARIANT, variantName: '18 kg' }),
    });
    await w.service.arm({ ...OFFER, variantId: VARIANT, statedQuantity: 2 });
    const result = await w.turn({ text: 'sí' });
    expect(replyOf(result)).toContain('2 × Croquetas Adulto 18 kg (18 kg) a ');
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: VARIANT }),
      expect.any(String),
    );
  });

  it('a replayed 200 (same key) is confirmed exactly like a new backorder', async () => {
    const w = world();
    w.client.createBackorder.mockResolvedValue({
      created: false,
      backorder: backorder(),
    });
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: SCHEDULED_REPLY,
    });
  });

  it('does not mention the 24 h reservation yet', async () => {
    const w = world();
    await w.arm(2);
    const result = await w.turn({ text: 'sí' });
    expect(JSON.stringify(result)).not.toMatch(/24|reserv/i);
  });

  it('converts the estimate from UTC to Mexico City time', async () => {
    const w = world();
    await w.arm(2);
    const result = await w.turn({ text: 'sí' });
    expect(replyOf(result)).toContain('(aprox. el 26 de noviembre)');
  });

  it('omits the date when the estimate is already in the past', async () => {
    const w = world();
    w.client.createBackorder.mockResolvedValue({
      created: true,
      backorder: backorder({ estimatedAt: '2026-11-19T10:00:00.000Z' }),
    });
    await w.arm(2);
    const result = await w.turn({ text: 'sí' });
    expect(result).toEqual({
      kind: 'reply',
      reply:
        'Listo, quedó agendado su pedido BO-000012: 2 × Croquetas Adulto 18 kg a $1149.00 MXN c/u. Le aviso en cuanto llegue; no paga nada hasta entonces.',
    });
  });

  it('spends the offer: a second yes or tap schedules nothing', async () => {
    const w = world();
    await w.arm(2);
    await w.turn({ text: 'sí' });
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
    await expect(
      w.turn({ text: 'Sí, apártamelo', interactiveReplyId: SCHEDULE }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(w.client.createBackorder).toHaveBeenCalledTimes(1);
  });

  it('uses the same idempotency key for the same offer across processes', async () => {
    const w = world();
    await w.arm(2);
    await w.turn({ text: 'sí' });
    expect(w.client.createBackorder.mock.calls[0][1]).toBe(
      `backorder:${DECISION}:${SENDER}`,
    );
  });
});

describe('asking the count when none was stated (S14)', () => {
  it('yes → «¿Cuántas piezas le aparto?» and nothing is scheduled yet', async () => {
    const w = world();
    await w.arm(null);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: '¿Cuántas piezas le aparto?',
    });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
  });

  it.each([
    ['3', 3],
    ['quiero 4', 4],
    ['dos', 2],
    ['una', 1],
    ['1', 1],
    ['10 piezas', 10],
  ])('the answer %j schedules %i piece(s)', async (text, quantity) => {
    const w = world();
    w.client.createBackorder.mockResolvedValue({
      created: true,
      backorder: backorder({ quantity }),
    });
    await w.arm(null);
    await w.turn({ text: 'sí' });
    const result = await w.turn({ text });
    expect(replyOf(result)).toContain(`${quantity} × Croquetas`);
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({ quantity }),
      `backorder:${DECISION}:${SENDER}`,
    );
  });

  it('the tapped button asks too, and the asked state survives a restart', async () => {
    const w = world();
    await w.arm(null);
    await expect(
      w.turn({ text: 'Sí, apártamelo', interactiveReplyId: SCHEDULE }),
    ).resolves.toEqual({ kind: 'reply', reply: '¿Cuántas piezas le aparto?' });
    const restarted = w.boot();
    await expect(w.turnOn(restarted, { text: '5' })).resolves.toMatchObject({
      kind: 'reply',
    });
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 5 }),
      expect.any(String),
    );
  });

  it.each(['no sé', 'mejor otra cosa', 'dos o tres', '0', '1000', '2.5 kg'])(
    'the answer %j is no count: the offer ends politely and the turn goes on',
    async (text) => {
      const w = world();
      await w.arm(null);
      await w.turn({ text: 'sí' });
      await expect(w.turn({ text })).resolves.toBeNull();
      expect(w.client.createBackorder).not.toHaveBeenCalled();
      // Spent: a later «sí» is not an answer to anything.
      await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
    },
  );

  it('«no» to the question declines', async () => {
    const w = world();
    await w.arm(null);
    await w.turn({ text: 'sí' });
    await expect(w.turn({ text: 'no' })).resolves.toEqual({
      kind: 'reply',
      reply: 'Entendido. ¡Que esté muy bien!',
    });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
  });
});

describe('declining and ignoring the offer', () => {
  it.each([
    ['the tapped button', { text: 'No, gracias', interactiveReplyId: DECLINE }],
    ['a bare no', { text: 'no' }],
    ['a polite no', { text: 'No, gracias' }],
  ])('%s answers «Entendido» and spends the offer', async (_l, input) => {
    const w = world();
    await w.arm(2);
    await expect(w.turn(input)).resolves.toEqual({
      kind: 'reply',
      reply: 'Entendido. ¡Que esté muy bien!',
    });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
  });

  it.each([
    'cuánto cuesta el envío',
    'mejor dame otra marca',
    'gracias',
    'sí, pero que sean 3',
  ])(
    'any other message (%j) spends the offer and the turn goes on',
    async (text) => {
      const w = world();
      await w.arm(2);
      await expect(w.turn({ text })).resolves.toBeNull();
      expect(w.client.createBackorder).not.toHaveBeenCalled();
      await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
      await expect(w.store.get(SENDER, 'backorder_offer')).resolves.toBeNull();
    },
  );

  it('another button tap spends the offer too', async () => {
    const w = world();
    await w.arm(2);
    await expect(
      w.turn({
        text: 'Quiero comprar',
        interactiveReplyId: 'cart_continue:abc',
      }),
    ).resolves.toBeNull();
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
  });

  it('an expired offer is no offer', async () => {
    const w = world();
    await w.arm(2);
    w.advance(24 * 60 * 60 * 1000);
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
    expect(w.client.createBackorder).not.toHaveBeenCalled();
  });

  it('no offer armed: a bare yes is not for this service', async () => {
    const w = world();
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
  });

  it.each([
    ['no offer at all', null],
    ['another decision', OTHER_DECISION],
  ])('a tapped button with %s is stale', async (_label, armed) => {
    const w = world();
    if (armed !== null)
      await w.service.arm({ ...OFFER, decisionId: armed, statedQuantity: 2 });
    await expect(
      w.turn({ text: 'Sí, apártamelo', interactiveReplyId: SCHEDULE }),
    ).resolves.toEqual({ kind: 'stale' });
    await expect(
      w.turn({ text: 'No, gracias', interactiveReplyId: DECLINE }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
    if (armed !== null)
      // A stale tap never spends the current offer.
      await expect(
        w.store.get(SENDER, 'backorder_offer'),
      ).resolves.not.toBeNull();
  });
});

describe('the customer of the backorder', () => {
  const notFound = {
    status: 'not_found',
    customer: null,
    addresses: [],
    nextAfterAddressId: null,
  };

  it('looks the customer up by the WhatsApp number (first page only)', async () => {
    const w = world();
    await w.arm(2);
    await w.turn({ text: 'sí' });
    expect(w.api.getCustomerCheckoutContext).toHaveBeenCalledWith(
      '52',
      '5512349901',
      { limit: 1 },
    );
  });

  it('a new customer is created with the name the profile knows', async () => {
    const w = world({ customer: notFound, profile: { preferredName: 'Rosa' } });
    await w.arm(2);
    await w.turn({ text: 'sí' });
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: { mode: 'createIfAbsent', firstName: 'Rosa' },
      }),
      expect.any(String),
    );
  });

  it('falls back to the first word of the WhatsApp contact name', async () => {
    const w = world({
      customer: notFound,
      profile: { displayName: 'Rosa Elena Pérez' },
    });
    await w.arm(2);
    await w.turn({ text: 'sí' });
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: { mode: 'createIfAbsent', firstName: 'Rosa' },
      }),
      expect.any(String),
    );
  });

  it('asks «¿A nombre de quién lo agendo?» when no name is known, then schedules with it', async () => {
    const w = world({ customer: notFound, profile: null });
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: '¿A nombre de quién lo agendo?',
    });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
    const result = await w.turn({ text: 'Rosa' });
    expect(result).toMatchObject({ kind: 'reply' });
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 2,
        customer: { mode: 'createIfAbsent', firstName: 'Rosa' },
      }),
      `backorder:${DECISION}:${SENDER}`,
    );
    expect(w.profiles.record).toHaveBeenCalledWith(SENDER, {
      preferredName: 'Rosa',
    });
  });

  it('asks the count first and the name second when both are missing', async () => {
    const w = world({ customer: notFound, profile: null });
    await w.arm(null);
    await expect(w.turn({ text: 'sí' })).resolves.toMatchObject({
      reply: '¿Cuántas piezas le aparto?',
    });
    await expect(w.turn({ text: '3' })).resolves.toMatchObject({
      reply: '¿A nombre de quién lo agendo?',
    });
    await w.turn({ text: 'Rosa' });
    expect(w.client.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 3,
        customer: { mode: 'createIfAbsent', firstName: 'Rosa' },
      }),
      expect.any(String),
    );
  });

  it.each(['no sé', '12345', 'cuánto cuesta', 'a'.repeat(60)])(
    'the name answer %j is no name: the offer ends and the turn goes on',
    async (text) => {
      const w = world({ customer: notFound, profile: null });
      await w.arm(2);
      await w.turn({ text: 'sí' });
      await expect(w.turn({ text })).resolves.toBeNull();
      expect(w.client.createBackorder).not.toHaveBeenCalled();
    },
  );

  it('a shared phone is never guessed: honest failure, no request', async () => {
    const w = world({
      customer: { ...notFound, status: 'ambiguous' },
      profile: { preferredName: 'Rosa' },
    });
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: 'No pude agendar su pedido por ahora.',
    });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
  });

  it('a failed customer lookup is retryable and keeps the offer', async () => {
    const w = world();
    w.api.getCustomerCheckoutContext.mockRejectedValueOnce(apiError(503, null));
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply:
        'No pude agendar su pedido en este momento. Intente de nuevo en unos minutos.',
    });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: SCHEDULED_REPLY,
    });
  });

  it('a number that is not a Mexican WhatsApp number cannot be scheduled', async () => {
    const w = world();
    await w.service.arm({
      ...OFFER,
      senderId: 'whatsapp:+1555',
      statedQuantity: 2,
    });
    await w.gates.begin('whatsapp:+1555');
    const result = await w.service.handle({
      senderId: 'whatsapp:+1555',
      text: 'sí',
    });
    expect(result).toEqual({
      kind: 'reply',
      reply: 'No pude agendar su pedido por ahora.',
    });
    expect(w.client.createBackorder).not.toHaveBeenCalled();
  });
});

describe('what the backend answers', () => {
  it('409 STOCK_AVAILABLE_NOW: good news and the count question for the cart', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValue(
      apiError(409, 'STOCK_AVAILABLE_NOW', { availableToSell: 5 }),
    );
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply:
        '¡Buenas noticias! Ya tenemos Croquetas Adulto 18 kg disponible. ¿Cuántas piezas le agrego al carrito?',
    });
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
  });

  it('409 BACKORDER_DUPLICATE: says it is already scheduled, with the folio from GET :id', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValue(
      apiError(409, 'BACKORDER_DUPLICATE', { backorderId: BACKORDER_ID }),
    );
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply:
        'Ya tiene agendado su pedido BO-000012 de Croquetas Adulto 18 kg. Le aviso en cuanto llegue.',
    });
    expect(w.client.getBackorder).toHaveBeenCalledWith(BACKORDER_ID);
  });

  it('409 BACKORDER_DUPLICATE: still honest when the folio cannot be read', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValue(
      apiError(409, 'BACKORDER_DUPLICATE', { backorderId: BACKORDER_ID }),
    );
    w.client.getBackorder.mockRejectedValue(apiError(503, null));
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: 'Ya tiene agendado ese producto. Le aviso en cuanto llegue.',
    });
  });

  it.each([
    ['500 BACKORDER_REQUEST_FAILED', apiError(500, 'BACKORDER_REQUEST_FAILED')],
    ['503 BACKORDER_RETRY_REQUIRED', apiError(503, 'BACKORDER_RETRY_REQUIRED')],
    [
      '409 IDEMPOTENCY_KEY_IN_FLIGHT',
      apiError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT'),
    ],
    ['a timeout (no status)', new UpstreamError('timeout', null)],
    ['429 rate limit', apiError(429, null)],
  ])(
    '%s: honest retry message, the offer stays and the retry reuses the same key',
    async (_label, failure) => {
      const w = world();
      w.client.createBackorder.mockRejectedValueOnce(failure);
      await w.arm(2);
      await expect(w.turn({ text: 'sí' })).resolves.toEqual({
        kind: 'reply',
        reply:
          'No pude agendar su pedido en este momento. Intente de nuevo en unos minutos.',
      });
      await expect(w.turn({ text: 'sí' })).resolves.toEqual({
        kind: 'reply',
        reply: SCHEDULED_REPLY,
      });
      expect(w.client.createBackorder).toHaveBeenCalledTimes(2);
      expect(w.client.createBackorder.mock.calls[0][1]).toBe(
        w.client.createBackorder.mock.calls[1][1],
      );
    },
  );

  it('a retryable failure keeps the durable offer (and its expiry) across a restart', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValueOnce(apiError(503, null));
    await w.arm(2);
    await w.turn({ text: 'sí' });
    await expect(w.store.get(SENDER, 'backorder_offer')).resolves.toMatchObject(
      { expiresAt: new Date(T0 + 24 * 60 * 60 * 1000) },
    );
    const restarted = w.boot();
    await expect(w.turnOn(restarted, { text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: SCHEDULED_REPLY,
    });
  });

  it.each([
    [
      '400 INVALID_BACKORDER_REQUEST',
      apiError(400, 'INVALID_BACKORDER_REQUEST'),
    ],
    [
      '409 SOURCE_DECISION_NOT_ESTIMATED',
      apiError(409, 'SOURCE_DECISION_NOT_ESTIMATED'),
    ],
    ['404 PRODUCT_NOT_FOUND', apiError(404, 'PRODUCT_NOT_FOUND')],
    ['422 PRICE_UNAVAILABLE', apiError(422, 'PRICE_UNAVAILABLE')],
    ['403 missing scope', apiError(403, null)],
    ['409 CUSTOMER_PHONE_AMBIGUOUS', apiError(409, 'CUSTOMER_PHONE_AMBIGUOUS')],
  ])(
    '%s: an honest short message with no promise, the offer is spent',
    async (_label, failure) => {
      const w = world();
      w.client.createBackorder.mockRejectedValue(failure);
      await w.arm(2);
      const result = await w.turn({ text: 'sí' });
      expect(result).toEqual({
        kind: 'reply',
        reply: 'No pude agendar su pedido por ahora.',
      });
      expect(JSON.stringify(result)).not.toMatch(/aviso|llegue/i);
      await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
      expect(w.client.createBackorder).toHaveBeenCalledTimes(1);
    },
  );

  it('logs the status and the error code of a failure, never the body', async () => {
    const w = world();
    const warn = jest
      .spyOn(
        (w.service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    w.client.createBackorder.mockRejectedValue(
      apiError(422, 'PRICE_UNAVAILABLE', { secret: 'do-not-log' }),
    );
    await w.arm(2);
    await w.turn({ text: 'sí' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('status=422 code=PRICE_UNAVAILABLE'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('do-not-log');
  });
});

describe('L11 note 1: a retry never changes the body under the same idempotency key', () => {
  const notFound = {
    status: 'not_found',
    customer: null,
    addresses: [],
    nextAfterAddressId: null,
  };
  const unique = {
    status: 'unique',
    customer: { customerId: CUSTOMER, firstName: 'Rosa', lastName: null },
    addresses: [],
    nextAfterAddressId: null,
  };

  it('a timeout after resolving a NEW customer retries with the same body even if the customer exists now', async () => {
    const w = world({ customer: notFound, profile: { preferredName: 'Rosa' } });
    w.client.createBackorder.mockRejectedValueOnce(
      new UpstreamError('t', null),
    );
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply:
        'No pude agendar su pedido en este momento. Intente de nuevo en unos minutos.',
    });
    // The first request may have created the customer meanwhile.
    w.api.getCustomerCheckoutContext.mockResolvedValue(unique);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: SCHEDULED_REPLY,
    });
    const [first, second] = w.client.createBackorder.mock.calls;
    expect(second).toEqual(first);
    expect(first[0].customer).toEqual({
      mode: 'createIfAbsent',
      firstName: 'Rosa',
    });
    expect(w.api.getCustomerCheckoutContext).toHaveBeenCalledTimes(1);
  });

  it('a count asked after the yes is kept for the retry (it cannot change under the key)', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValueOnce(apiError(503, null));
    await w.arm(null);
    await w.turn({ text: 'sí' });
    await w.turn({ text: '3' });
    // The retry is a yes, not a new count.
    await expect(w.turn({ text: 'sí' })).resolves.toMatchObject({
      reply: SCHEDULED_REPLY,
    });
    const [first, second] = w.client.createBackorder.mock.calls;
    expect(first[0].quantity).toBe(3);
    expect(second).toEqual(first);
  });

  it('the retry state is durable: a restart replays the very same body', async () => {
    const w = world({ customer: notFound, profile: { preferredName: 'Rosa' } });
    w.client.createBackorder.mockRejectedValueOnce(apiError(500, null));
    await w.arm(2);
    await w.turn({ text: 'sí' });
    w.api.getCustomerCheckoutContext.mockResolvedValue(unique);
    const restarted = w.boot();
    await w.turnOn(restarted, { text: 'sí' });
    const [first, second] = w.client.createBackorder.mock.calls;
    expect(second).toEqual(first);
    await expect(w.store.get(SENDER, 'backorder_offer')).resolves.toBeNull();
  });

  it('a decline in the retry stage ends the offer', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValueOnce(apiError(500, null));
    await w.arm(2);
    await w.turn({ text: 'sí' });
    await expect(w.turn({ text: 'no' })).resolves.toEqual({
      kind: 'reply',
      reply: 'Entendido. ¡Que esté muy bien!',
    });
    expect(w.client.createBackorder).toHaveBeenCalledTimes(1);
  });

  it('any other message in the retry stage spends the offer', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValueOnce(apiError(500, null));
    await w.arm(2);
    await w.turn({ text: 'sí' });
    await expect(w.turn({ text: '¿y el envío?' })).resolves.toBeNull();
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
    expect(w.client.createBackorder).toHaveBeenCalledTimes(1);
  });
});

describe('L11 note 1: 409 IDEMPOTENCY_KEY_CONFLICT recovers the backorder the first attempt created', () => {
  const conflict = () => apiError(409, 'IDEMPOTENCY_KEY_CONFLICT');

  it('confirms the active backorder of this product created from this offer as scheduled', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValue(conflict());
    w.client.listBackorders.mockResolvedValue([
      backorder({ scheduledAt: new Date(T0 + 60_000).toISOString() }),
    ]);
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: SCHEDULED_REPLY,
    });
    expect(w.client.listBackorders).toHaveBeenCalledWith({
      phoneCountryCode: '52',
      phone: '5512349901',
      status: 'WAITING,RESERVED',
    });
    expect(w.client.createBackorder).toHaveBeenCalledTimes(1);
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
  });

  it.each([
    ['none exists', []],
    [
      'another product',
      [backorder({ productId: '77777777-7777-4777-8777-777777777777' })],
    ],
    ['another variant', [backorder({ variantId: VARIANT })]],
    [
      'one scheduled before this offer was made',
      [backorder({ scheduledAt: new Date(T0 - 60_000).toISOString() })],
    ],
  ])('is still «No pude agendar» when %s', async (_label, listed) => {
    const w = world();
    w.client.createBackorder.mockRejectedValue(conflict());
    w.client.listBackorders.mockResolvedValue(listed);
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: 'No pude agendar su pedido por ahora.',
    });
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
  });

  it('a failing lookup keeps the offer for a retry', async () => {
    const w = world();
    w.client.createBackorder.mockRejectedValue(conflict());
    w.client.listBackorders.mockRejectedValueOnce(apiError(503, null));
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply:
        'No pude agendar su pedido en este momento. Intente de nuevo en unos minutos.',
    });
    w.client.listBackorders.mockResolvedValue([
      backorder({ scheduledAt: new Date(T0 + 1).toISOString() }),
    ]);
    await expect(w.turn({ text: 'sí' })).resolves.toMatchObject({
      reply: SCHEDULED_REPLY,
    });
  });
});

describe('L11 note 2: a replayed create that is no longer active is not «quedó agendado»', () => {
  it.each([
    [
      'CANCELLED',
      'Su pedido BO-000012 ya estaba cancelado, así que no está agendado.',
    ],
    ['EXPIRED', 'Su pedido BO-000012 ya venció, así que no está agendado.'],
    ['CONFIRMED', 'Su pedido BO-000012 ya está confirmado.'],
  ] as const)('%s', async (status, reply) => {
    const w = world();
    w.client.createBackorder.mockResolvedValue({
      created: false,
      backorder: backorder({ status }),
    });
    await w.arm(2);
    const result = await w.turn({ text: 'sí' });
    expect(result).toEqual({ kind: 'reply', reply });
    expect(JSON.stringify(result)).not.toMatch(/quedó agendado|le aviso/i);
    // Nothing is rescheduled here: one request, offer spent.
    expect(w.client.createBackorder).toHaveBeenCalledTimes(1);
    await expect(w.turn({ text: 'sí' })).resolves.toBeNull();
  });

  it('RESERVED says it arrived (no «le aviso en cuanto llegue»)', async () => {
    const w = world();
    w.client.createBackorder.mockResolvedValue({
      created: false,
      backorder: backorder({
        status: 'RESERVED',
        reservedUntil: '2026-11-21T15:00:00.000Z',
      }),
    });
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply:
        '¡Ya llegó! Se lo tenemos apartado hasta el 21 de noviembre a las 9:00 a. m.',
    });
  });

  it('a WAITING replay is still confirmed as scheduled', async () => {
    const w = world();
    w.client.createBackorder.mockResolvedValue({
      created: false,
      backorder: backorder({ status: 'WAITING' }),
    });
    await w.arm(2);
    await expect(w.turn({ text: 'sí' })).resolves.toEqual({
      kind: 'reply',
      reply: SCHEDULED_REPLY,
    });
  });
});

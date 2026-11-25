import type {
  BackorderBot,
  BackorderClient,
  CreateBackorderInput,
} from '../../backorders/domain/backorder';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  ChatbotApiError,
  NotFoundError,
} from '../../chatbot-api/domain/errors';
import { Logger } from '@nestjs/common';
import { parseInteractiveReplyId } from '../domain/customer-reply';
import { isBackorderConfirmText } from '../domain/backorder-confirm';
import {
  MinimalBackorderConfirmService,
  backorderRescheduleKey,
  sourceDecisionOf,
} from './minimal-backorder-confirm.service';
import {
  BO_DECISION,
  BO_ID,
  BO_ID_2,
  BO_NOW,
  BO_PRODUCT,
  BO_SENDER,
  reservedBackorder,
} from './minimal-backorder-checkout.fixtures';

/**
 * Restock backorder T5b (S6): the confirm taps and the bare yes verify the
 * backorder before anything is added to the cart; the reschedule taps create a
 * new backorder from the same RESTOCK decision after an expiry.
 */
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

function setup(backorders: BackorderBot[] = [reservedBackorder()]) {
  const client = {
    createBackorder: jest.fn(),
    getBackorder: jest.fn((id: string) => {
      const found = backorders.find((item) => item.id === id);
      return found === undefined
        ? Promise.reject(new NotFoundError('nope', 404, {}))
        : Promise.resolve(found);
    }),
    listBackorders: jest.fn((query?: { status?: string }) =>
      Promise.resolve(
        backorders.filter(
          (item) =>
            query?.status === undefined ||
            query.status.split(',').includes(item.status),
        ),
      ),
    ),
    cancelBackorder: jest.fn(),
  } satisfies Record<keyof BackorderClient, jest.Mock>;
  const chatbotApi = {
    getCustomerCheckoutContext: jest.fn(() =>
      Promise.resolve({
        status: 'unique',
        customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
        addresses: [],
        nextAfterAddressId: null,
      }),
    ),
  };
  const service = new MinimalBackorderConfirmService({
    backorders: client,
    chatbotApi: chatbotApi as unknown as Pick<
      ChatbotApiClient,
      'getCustomerCheckoutContext'
    >,
    clock: () => BO_NOW,
  });
  const allowed = jest.fn(() => Promise.resolve(true));
  const tap = (id: string, backorderId = BO_ID) =>
    service.handle({
      senderId: BO_SENDER,
      text: 'Confirmo mi pedido apartado',
      interactiveReplyId: `${id}:${backorderId}`,
      bareYesAllowed: allowed,
    });
  const say = (text: string) =>
    service.handle({ senderId: BO_SENDER, text, bareYesAllowed: allowed });
  return { client, chatbotApi, service, allowed, tap, say };
}

const textOf = (turn: unknown) => (turn as { reply: string }).reply;

describe('the confirm tap (backorder_confirm:<id>)', () => {
  it('a RESERVED backorder of this phone with its deadline ahead asks the caller to add it', async () => {
    const h = setup();
    expect(await h.tap('backorder_confirm')).toEqual({
      kind: 'add',
      backorder: reservedBackorder(),
    });
    // Verified against the customer's own list AND GET :id; never blocked by
    // the caller's context: the tap does not even consult it.
    expect(h.client.listBackorders).toHaveBeenCalledWith({
      phoneCountryCode: '52',
      phone: '5550001111',
    });
    expect(h.client.getBackorder).toHaveBeenCalledWith(BO_ID);
    expect(h.allowed).not.toHaveBeenCalled();
  });

  it.each([
    ['EXPIRED', 'Se venció el apartado de su pedido BO-000012.'],
    ['CONFIRMED', 'Ese pedido ya está confirmado.'],
    ['CANCELLED', 'Ese pedido apartado ya está cancelado.'],
    [
      'WAITING',
      'Su pedido BO-000012 todavía no está apartado. Le aviso en cuanto llegue.',
    ],
  ])(
    'a %s backorder is answered honestly and nothing is added',
    async (status, text) => {
      const h = setup([reservedBackorder({ status: status as never })]);
      const turn = await h.tap('backorder_confirm');
      expect(turn).toEqual({ kind: 'reply', reply: text });
    },
  );

  it('RESERVED but past its deadline (before the sweep) is expired, not confirmable', async () => {
    const h = setup([
      reservedBackorder({ reservedUntil: '2026-11-20T14:59:59.000Z' }),
    ]);
    expect(textOf(await h.tap('backorder_confirm'))).toContain(
      'Se venció el apartado',
    );
    const missing = setup([reservedBackorder({ reservedUntil: null })]);
    expect(textOf(await missing.tap('backorder_confirm'))).toContain(
      'Se venció el apartado',
    );
  });

  it('a RESERVED backorder without a final price cannot be priced: nothing is added', async () => {
    const h = setup([reservedBackorder({ finalPriceCents: null })]);
    expect(textOf(await h.tap('backorder_confirm'))).toContain(
      'No pude consultar su pedido apartado',
    );
  });

  it("another phone's or an unknown backorder is «no encontré»", async () => {
    const h = setup([reservedBackorder()]);
    expect(await h.tap('backorder_confirm', BO_ID_2)).toEqual({
      kind: 'reply',
      reply: 'No encontré ese pedido apartado.',
    });
    // Listed for the phone but gone by GET :id.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const gone = setup([reservedBackorder()]);
    gone.client.getBackorder.mockRejectedValue(
      new ChatbotApiError('x', 404, {}, 'BACKORDER_NOT_FOUND'),
    );
    expect(textOf(await gone.tap('backorder_confirm'))).toBe(
      'No encontré ese pedido apartado.',
    );
  });

  it("a backorder of ANOTHER phone (GET :id finds it, the customer's own list does not) is never added", async () => {
    const h = setup([reservedBackorder()]);
    h.client.listBackorders.mockResolvedValue([]);
    expect(await h.tap('backorder_confirm')).toEqual({
      kind: 'reply',
      reply: 'No encontré ese pedido apartado.',
    });
    expect(h.client.getBackorder).not.toHaveBeenCalled();
  });

  it('a failed read is an honest retry message, never an add', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const h = setup();
    h.client.listBackorders.mockRejectedValue(new Error('down'));
    expect(await h.tap('backorder_confirm')).toEqual({
      kind: 'reply',
      reply:
        'No pude consultar su pedido apartado por ahora. Intente de nuevo en unos minutos.',
    });
  });

  it('an expired one with a known sourceDecisionId offers to schedule it again', async () => {
    const h = setup([
      reservedBackorder({
        status: 'EXPIRED',
        sourceDecisionId: BO_DECISION,
      }),
    ]);
    const turn = await h.tap('backorder_confirm');
    expect(turn).toMatchObject({
      kind: 'reply',
      reply:
        'Se venció el apartado de su pedido BO-000012. ¿Quiere que se lo agende de nuevo? Quedaría al final de la fila de espera.',
      interactive: {
        type: 'buttons',
        buttons: [
          { id: `backorder_reschedule:${BO_ID}`, title: 'Sí, agendar' },
          { id: `backorder_reschedule_decline:${BO_ID}`, title: 'No, gracias' },
        ],
      },
    });
  });

  it('a forged or malformed button id is not ours', async () => {
    const h = setup();
    for (const id of [
      'backorder_confirm:not-a-uuid',
      'backorder_confirm',
      'backorder_confirm:',
      'order_confirm:x',
    ])
      expect(
        await h.service.handle({
          senderId: BO_SENDER,
          text: 'x',
          interactiveReplyId: id,
          bareYesAllowed: h.allowed,
        }),
      ).toBeNull();
    expect(h.client.listBackorders).not.toHaveBeenCalled();
  });

  it('a non-Mexican number is not ours', async () => {
    const h = setup();
    expect(
      await h.service.handle({
        senderId: '14155550100',
        text: 'sí',
        bareYesAllowed: h.allowed,
      }),
    ).toBeNull();
    expect(h.client.listBackorders).not.toHaveBeenCalled();
  });
});

describe('the bare yes (conservative)', () => {
  it.each([
    'sí',
    'Si',
    'ok',
    'dale',
    'confirmo',
    'sí lo quiero',
    'Lo confirmo',
    'sí, confirmo mi pedido',
  ])(
    '«%s» confirms the only RESERVED backorder when nothing else could own it',
    async (text) => {
      const h = setup();
      expect(await h.say(text)).toEqual({
        kind: 'add',
        backorder: reservedBackorder(),
      });
      expect(h.client.listBackorders).toHaveBeenCalledWith({
        phoneCountryCode: '52',
        phone: '5550001111',
        status: 'RESERVED',
      });
    },
  );

  it.each([
    'no',
    'sí pero cambia la cantidad',
    'sí, y agrégame un collar',
    '¿sí lo tienen?',
    'hola',
    'confirmo que quiero cambiar la dirección',
    '',
  ])('«%s» is not a confirmation: no backend call at all', async (text) => {
    const h = setup();
    expect(await h.say(text)).toBeNull();
    expect(h.client.listBackorders).not.toHaveBeenCalled();
    expect(h.allowed).not.toHaveBeenCalled();
  });

  it('is not ours when the caller says another order or question could own the yes (no backend call)', async () => {
    const h = setup();
    h.allowed.mockResolvedValue(false);
    expect(await h.say('sí')).toBeNull();
    expect(h.client.listBackorders).not.toHaveBeenCalled();
    h.allowed.mockRejectedValue(new Error('boom'));
    expect(await h.say('sí')).toBeNull();
  });

  it('is not ours with several RESERVED backorders, none, or an unreadable list', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const two = setup([
      reservedBackorder(),
      reservedBackorder({ id: BO_ID_2, productId: BO_PRODUCT }),
    ]);
    expect(await two.say('sí')).toBeNull();
    const none = setup([reservedBackorder({ status: 'WAITING' })]);
    expect(await none.say('sí')).toBeNull();
    const down = setup();
    down.client.listBackorders.mockRejectedValue(new Error('down'));
    expect(await down.say('sí')).toBeNull();
  });

  it('the typed lexicon is whole-message only', () => {
    expect(isBackorderConfirmText('confirmo')).toBe(true);
    expect(isBackorderConfirmText('si lo quiero')).toBe(true);
    expect(isBackorderConfirmText('sí lo quiero con envío')).toBe(false);
    expect(isBackorderConfirmText(undefined)).toBe(false);
    expect(isBackorderConfirmText('sí'.repeat(40))).toBe(false);
  });
});

describe('reschedule after an expiry', () => {
  const expired = (extra: object = {}) =>
    reservedBackorder({
      status: 'EXPIRED',
      sourceDecisionId: BO_DECISION,
      ...extra,
    });
  const created = (backorder: Partial<BackorderBot> = {}) =>
    reservedBackorder({
      id: BO_ID_2,
      folio: 'BO-000020',
      status: 'WAITING',
      reservedAt: null,
      reservedUntil: null,
      finalPriceCents: null,
      currentPriceCents: null,
      estimatedAt: '2026-11-27T15:00:00.000Z',
      ...backorder,
    });

  it('creates a NEW backorder from the same decision, product, variant, quantity and the existing customer, under its own key', async () => {
    const variantId = '66666666-6666-4666-8666-666666666666';
    const h = setup([expired({ variantId, variantName: 'Bolsa' })]);
    h.client.createBackorder.mockResolvedValue({
      created: true,
      backorder: created(),
    });

    const turn = await h.tap('backorder_reschedule');

    expect(h.client.createBackorder).toHaveBeenCalledWith(
      {
        phoneCountryCode: '52',
        phone: '5550001111',
        customer: { mode: 'existing', customerId: CUSTOMER },
        productId: reservedBackorder().productId,
        variantId,
        quantity: 2,
        sourceDecisionId: BO_DECISION,
      },
      backorderRescheduleKey(BO_ID),
    );
    expect(backorderRescheduleKey(BO_ID)).toBe(`backorder-reschedule:${BO_ID}`);
    expect(textOf(turn)).toBe(
      'Listo, quedó agendado su pedido *BO-000020*:\n• Croquetas Adulto 18 kg\n   2 × $1,149.00 = *$2,298.00*\n\nLe aviso en cuanto llegue (aprox. el 27 de noviembre); no paga nada hasta entonces.',
    );
  });

  it('a CANCELLED backorder can be rescheduled too; an unknown customer is created by the stored first name', async () => {
    const h = setup([expired({ status: 'CANCELLED' })]);
    h.chatbotApi.getCustomerCheckoutContext.mockResolvedValue({
      status: 'not_found',
      customer: null,
      addresses: [],
      nextAfterAddressId: null,
    } as never);
    h.client.createBackorder.mockResolvedValue({
      created: true,
      backorder: created(),
    });
    await h.tap('backorder_reschedule');
    expect(
      (
        h.client.createBackorder.mock.calls as unknown as Array<
          [CreateBackorderInput]
        >
      )[0][0].customer,
    ).toEqual({
      mode: 'createIfAbsent',
      firstName: 'Rosa',
    });
  });

  it('without a sourceDecisionId it cannot be rescheduled automatically and says so', async () => {
    const h = setup([reservedBackorder({ status: 'EXPIRED' })]);
    const turn = await h.tap('backorder_reschedule');
    expect(textOf(turn)).toBe(
      'No puedo agendarlo de nuevo de forma automática. Si quiere, dígame «hablar con una persona» y el equipo le ayuda.',
    );
    expect(h.client.createBackorder).not.toHaveBeenCalled();
    expect(sourceDecisionOf(reservedBackorder())).toBeNull();
  });

  it('the decline tap is «Entendido.» and calls nothing', async () => {
    const h = setup([expired()]);
    expect(await h.tap('backorder_reschedule_decline')).toEqual({
      kind: 'reply',
      reply: 'Entendido.',
    });
    expect(h.client.createBackorder).not.toHaveBeenCalled();
    expect(h.client.listBackorders).not.toHaveBeenCalled();
  });

  it.each([
    [
      'WAITING',
      'Su pedido BO-000012 sigue agendado; no hace falta agendarlo de nuevo.',
    ],
    [
      'RESERVED',
      'Su pedido BO-000012 sigue agendado; no hace falta agendarlo de nuevo.',
    ],
    ['CONFIRMED', 'Su pedido BO-000012 ya está confirmado.'],
  ])('a %s backorder is not rescheduled', async (status, text) => {
    const h = setup([expired({ status })]);
    expect(textOf(await h.tap('backorder_reschedule'))).toBe(text);
    expect(h.client.createBackorder).not.toHaveBeenCalled();
  });

  it('an unknown backorder is «no encontré»; nothing is created', async () => {
    const h = setup([expired()]);
    expect(textOf(await h.tap('backorder_reschedule', BO_ID_2))).toBe(
      'No encontré ese pedido apartado.',
    );
    expect(h.client.createBackorder).not.toHaveBeenCalled();
  });

  it.each([
    [
      new ChatbotApiError(
        'x',
        409,
        { backorderId: BO_ID },
        'BACKORDER_DUPLICATE',
      ),
      'Ya tiene agendado su pedido BO-000012',
    ],
    [
      new ChatbotApiError('x', 409, {}, 'STOCK_AVAILABLE_NOW'),
      '¡Buenas noticias!',
    ],
    [
      new ChatbotApiError('x', 503, {}, 'BACKORDER_RETRY_REQUIRED'),
      'No pude agendar su pedido en este momento.',
    ],
    [
      new ChatbotApiError('x', 409, {}, 'IDEMPOTENCY_KEY_IN_FLIGHT'),
      'No pude agendar su pedido en este momento.',
    ],
    [
      new ChatbotApiError('x', 409, {}, 'SOURCE_DECISION_NOT_ESTIMATED'),
      'No pude agendar su pedido por ahora.',
    ],
    [new Error('socket'), 'No pude agendar su pedido en este momento.'],
  ])('a failed create is answered honestly (%#)', async (error, text) => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const h = setup([expired()]);
    h.client.createBackorder.mockRejectedValue(error);
    expect(textOf(await h.tap('backorder_reschedule'))).toContain(text);
  });

  it('a replayed (200) create is worded by the state of the backorder it returns', async () => {
    const h = setup([expired()]);
    h.client.createBackorder.mockResolvedValue({
      created: false,
      backorder: created({ status: 'CANCELLED' }),
    });
    expect(textOf(await h.tap('backorder_reschedule'))).toBe(
      'Su pedido BO-000020 ya estaba cancelado, así que no está agendado.',
    );
  });

  it('a shared phone or a failed customer lookup never guesses a customer', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const shared = setup([expired()]);
    shared.chatbotApi.getCustomerCheckoutContext.mockResolvedValue({
      status: 'ambiguous',
      customer: null,
      addresses: [],
      nextAfterAddressId: null,
    } as never);
    expect(textOf(await shared.tap('backorder_reschedule'))).toBe(
      'No pude agendar su pedido por ahora.',
    );
    const down = setup([expired()]);
    down.chatbotApi.getCustomerCheckoutContext.mockRejectedValue(
      new Error('down'),
    );
    expect(textOf(await down.tap('backorder_reschedule'))).toContain(
      'en este momento',
    );
    expect(shared.client.createBackorder).not.toHaveBeenCalled();
    expect(down.client.createBackorder).not.toHaveBeenCalled();
  });
});

describe('button ids', () => {
  it('parse the three new ids and reject anything else', () => {
    expect(parseInteractiveReplyId(`backorder_confirm:${BO_ID}`)).toEqual({
      kind: 'backorder_confirm',
      reference: BO_ID,
    });
    expect(parseInteractiveReplyId(`backorder_reschedule:${BO_ID}`)).toEqual({
      kind: 'backorder_reschedule',
      reference: BO_ID,
    });
    expect(
      parseInteractiveReplyId(`backorder_reschedule_decline:${BO_ID}`),
    ).toEqual({ kind: 'backorder_reschedule_decline', reference: BO_ID });
    expect(parseInteractiveReplyId('backorder_confirm:abc')).toBeNull();
    expect(
      parseInteractiveReplyId(`backorder_confirm:yes:${BO_ID}`),
    ).toBeNull();
    // The existing ids are untouched.
    expect(
      parseInteractiveReplyId(`backorder:schedule:${BO_DECISION}`),
    ).toEqual({
      kind: 'backorder',
      action: 'schedule',
      reference: BO_DECISION,
    });
    expect(parseInteractiveReplyId(`backorder_cancel:yes:${BO_ID}`)).toEqual({
      kind: 'backorder_cancel',
      action: 'yes',
      reference: BO_ID,
    });
  });
});

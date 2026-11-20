import type {
  BackorderBot,
  BackorderClient,
} from '../../backorders/domain/backorder';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { MinimalBackorderManageService } from './minimal-backorder-manage.service';

/**
 * Restock backorder S8 (T6): the customer cancels, or asks about, a SCHEDULED
 * restock order from the chat. Deterministic: only the backorder client is
 * called, never a model.
 */
const SENDER = '5215512349901';
const ID = '8c1d0000-1111-4222-8333-444455556666';
const ID2 = '9c1d0000-1111-4222-8333-444455556666';
const ID3 = 'ac1d0000-1111-4222-8333-444455556666';
const ID4 = 'bc1d0000-1111-4222-8333-444455556666';
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
// 27 Nov 03:00 UTC is still 26 Nov 21:00 in Mexico City.
const FUTURE = '2026-11-27T03:00:00.000Z';
const PAST = '2026-11-18T15:00:00.000Z';

const backorder = (overrides: Partial<BackorderBot> = {}): BackorderBot => ({
  id: ID,
  folio: 'BO-000012',
  status: 'WAITING',
  productId: '99999999-9999-4999-8999-999999999999',
  productName: 'Croquetas Adulto 18 kg',
  variantId: null,
  variantName: null,
  quantity: 2,
  referencePriceCents: 114900,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: '2026-11-20T12:00:00.000Z',
  estimatedAt: FUTURE,
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
const apiError = (status: number | null, code: string | null, body = {}) =>
  new ChatbotApiError('x', status, { error: code, ...body }, code);

function world(active: BackorderBot[] = [backorder()]) {
  let now = T0;
  const client = {
    createBackorder: jest.fn(),
    getBackorder: jest.fn(),
    listBackorders: jest.fn().mockResolvedValue(active),
    cancelBackorder: jest
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(backorder({ id, status: 'CANCELLED' })),
      ),
  } satisfies Record<keyof BackorderClient, jest.Mock>;
  const service = new MinimalBackorderManageService({
    backorders: client,
    clock: () => now,
  });
  const competing = jest.fn().mockResolvedValue(false);
  const say = (
    text: string,
    interactiveReplyId?: string,
    senderId: string = SENDER,
  ) =>
    service.handle({
      senderId,
      text,
      competingOrderContext: competing,
      ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
    });
  return {
    client,
    service,
    competing,
    say,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const replyOf = (turn: { kind: string; reply?: string } | null): string =>
  turn?.kind === 'reply' ? (turn.reply ?? '') : '';

const QUESTION = '¿Cancelo su pedido BO-000012 de 2 × Croquetas Adulto 18 kg?';
const CANCELLED = 'Listo, cancelé su pedido BO-000012.';

describe('cancel from the chat (S8)', () => {
  it('asks once, naming the backorder, with [Sí, cancelar] [No]', async () => {
    const w = world();
    const turn = await w.say('cancela lo que aparté');
    expect(turn).toEqual({
      kind: 'reply',
      reply: QUESTION,
      interactive: {
        type: 'buttons',
        buttons: [
          { id: `backorder_cancel:yes:${ID}`, title: 'Sí, cancelar' },
          { id: `backorder_cancel:no:${ID}`, title: 'No' },
        ],
        prompt: '¿Cancelo su pedido BO-000012?',
      },
    });
    expect(w.client.listBackorders).toHaveBeenCalledWith({
      phoneCountryCode: '52',
      phone: '5512349901',
      status: 'WAITING,RESERVED',
    });
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it('names the variant in the question', async () => {
    const w = world([backorder({ variantName: '18 kg' })]);
    expect(replyOf(await w.say('cancela mi pedido por reposición'))).toBe(
      '¿Cancelo su pedido BO-000012 de 2 × Croquetas Adulto 18 kg (18 kg)?',
    );
  });

  it.each(['sí', 'si', 'Sí.', 'cancela', 'cancélalo', 'ok'])(
    'the text «%s» confirms and cancels',
    async (yes) => {
      const w = world();
      await w.say('cancela lo que aparté');
      expect(replyOf(await w.say(yes))).toBe(CANCELLED);
      expect(w.client.cancelBackorder).toHaveBeenCalledTimes(1);
      expect(w.client.cancelBackorder).toHaveBeenCalledWith(ID);
    },
  );

  it('a reply that is not a plain yes never cancels', async () => {
    const w = world();
    await w.say('cancela lo que aparté');
    expect(await w.say('sí, pero cambia la cantidad')).toBeNull();
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it('the tapped «Sí, cancelar» cancels, even after a restart (the id is self-contained)', async () => {
    const w = world();
    const turn = await w.say('SÍ', `backorder_cancel:yes:${ID}`);
    expect(replyOf(turn)).toBe(CANCELLED);
    expect(w.client.cancelBackorder).toHaveBeenCalledWith(ID);
  });

  it('a tapped yes for a backorder the customer does not have active is stale: nothing is cancelled', async () => {
    const w = world([backorder({ id: ID2 })]);
    const turn = await w.say('SÍ', `backorder_cancel:yes:${ID}`);
    expect(turn).toEqual({ kind: 'stale' });
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it.each([
    ['the tapped No', 'No', `backorder_cancel:no:${ID}`],
    ['a typed no', 'no', undefined],
    ['«mejor no»', 'mejor no', undefined],
  ])('%s keeps the order and cancels nothing', async (_label, text, id) => {
    const w = world();
    await w.say('cancela lo que aparté');
    const turn = await w.say(text, id);
    expect(replyOf(turn)).toBe(
      'Entendido, su pedido BO-000012 sigue agendado.',
    );
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
    // The question is spent: a later yes means nothing here.
    expect(await w.say('sí')).toBeNull();
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it('a 409 BACKORDER_NOT_CANCELLABLE with status CANCELLED is the same success', async () => {
    const w = world();
    w.client.cancelBackorder.mockRejectedValue(
      apiError(409, 'BACKORDER_NOT_CANCELLABLE', { status: 'CANCELLED' }),
    );
    await w.say('cancela lo que aparté');
    expect(replyOf(await w.say('sí'))).toBe(CANCELLED);
  });

  it.each([
    [
      'EXPIRED',
      'Su pedido BO-000012 ya venció, así que no hay nada que cancelar.',
    ],
    [
      'CONFIRMED',
      'Su pedido BO-000012 ya está confirmado, así que ya no puedo cancelarlo desde aquí.',
    ],
  ])('a 409 with status %s is answered honestly', async (status, text) => {
    const w = world();
    w.client.cancelBackorder.mockRejectedValue(
      apiError(409, 'BACKORDER_NOT_CANCELLABLE', { status }),
    );
    await w.say('cancela lo que aparté');
    expect(replyOf(await w.say('sí'))).toBe(text);
  });

  it.each([
    ['a 500', apiError(500, 'BACKORDER_REQUEST_FAILED')],
    ['a 404', apiError(404, 'BACKORDER_NOT_FOUND')],
    ['a timeout', apiError(null, null)],
    ['an unknown error', new Error('boom')],
    ['a 409 with no status', apiError(409, 'BACKORDER_NOT_CANCELLABLE')],
  ])('%s is answered «No pude cancelarlo por ahora»', async (_l, error) => {
    const w = world();
    w.client.cancelBackorder.mockRejectedValue(error);
    await w.say('cancela lo que aparté');
    expect(replyOf(await w.say('sí'))).toBe('No pude cancelarlo por ahora.');
  });

  it('a typed yes after the question expired (5 minutes) is not ours', async () => {
    const w = world();
    await w.say('cancela lo que aparté');
    w.advance(5 * 60 * 1000);
    expect(await w.say('sí')).toBeNull();
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it('any other message spends the question; a later yes means nothing here', async () => {
    const w = world();
    await w.say('cancela lo que aparté');
    expect(await w.say('¿y cuánto cuesta el envío?')).toBeNull();
    expect(await w.say('sí')).toBeNull();
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it('another button spends the question too', async () => {
    const w = world();
    await w.say('cancela lo que aparté');
    expect(await w.say('Seguir con la compra', 'cart_continue:abc')).toBeNull();
    expect(await w.say('sí')).toBeNull();
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it('a double yes cancels once', async () => {
    const w = world();
    await w.say('cancela lo que aparté');
    const [a, b] = await Promise.all([w.say('sí'), w.say('sí')]);
    expect(w.client.cancelBackorder).toHaveBeenCalledTimes(1);
    expect([a, b].filter((turn) => turn !== null)).toHaveLength(1);
  });

  describe('several active backorders', () => {
    const three = () => [
      backorder(),
      backorder({ id: ID2, folio: 'BO-000013', quantity: 1 }),
      backorder({ id: ID3, folio: 'BO-000014', productName: 'Collar' }),
    ];

    it('lists them as buttons (up to three) and asks which', async () => {
      const w = world(three());
      const turn = await w.say('cancela lo que aparté');
      expect(turn).toMatchObject({
        kind: 'reply',
        reply: [
          'Tiene varios pedidos por reposición. ¿Cuál desea cancelar?',
          '• BO-000012: 2 × Croquetas Adulto 18 kg',
          '• BO-000013: 1 × Croquetas Adulto 18 kg',
          '• BO-000014: 2 × Collar',
        ].join('\n'),
        interactive: {
          type: 'buttons',
          buttons: [
            { id: `backorder_cancel:pick:${ID}`, title: 'BO-000012' },
            { id: `backorder_cancel:pick:${ID2}`, title: 'BO-000013' },
            { id: `backorder_cancel:pick:${ID3}`, title: 'BO-000014' },
          ],
        },
      });
      expect(w.client.cancelBackorder).not.toHaveBeenCalled();
    });

    it('lists four or more as a list', async () => {
      const w = world([...three(), backorder({ id: ID4, folio: 'BO-000015' })]);
      const turn = await w.say('cancela lo que aparté');
      expect(turn).toMatchObject({
        kind: 'reply',
        interactive: { type: 'list' },
      });
    });

    it('a pick (tap) asks the confirmation for that one, then yes cancels it', async () => {
      const w = world(three());
      await w.say('cancela lo que aparté');
      const asked = await w.say('BO-000013', `backorder_cancel:pick:${ID2}`);
      expect(replyOf(asked)).toBe(
        '¿Cancelo su pedido BO-000013 de 1 × Croquetas Adulto 18 kg?',
      );
      expect(replyOf(await w.say('sí'))).toBe(
        'Listo, cancelé su pedido BO-000013.',
      );
      expect(w.client.cancelBackorder).toHaveBeenCalledWith(ID2);
    });

    it('a typed folio answers the pick (text fallback)', async () => {
      const w = world(three());
      await w.say('cancela lo que aparté');
      expect(replyOf(await w.say('la BO-000014 por favor'))).toBe(
        '¿Cancelo su pedido BO-000014 de 2 × Collar?',
      );
    });

    it('anything else after the pick question ends it and is not ours', async () => {
      const w = world(three());
      await w.say('cancela lo que aparté');
      expect(await w.say('mejor otra cosa')).toBeNull();
      expect(w.client.cancelBackorder).not.toHaveBeenCalled();
    });
  });

  describe('not handled: the existing flows answer as before', () => {
    it('no active backorder: explicit and generic wording are not ours', async () => {
      const w = world([]);
      expect(await w.say('cancela mi pedido por reposición')).toBeNull();
      expect(await w.say('ya no quiero el pedido')).toBeNull();
      expect(await w.say('¿cómo va mi pedido por reposición?')).toBeNull();
    });

    it('only inactive backorders listed by a loose backend are not active', async () => {
      const w = world([backorder({ status: 'CANCELLED' })]);
      expect(await w.say('cancela lo que aparté')).toBeNull();
    });

    it('a message that is no request never touches the backend', async () => {
      const w = world();
      for (const text of [
        'cancela',
        'quita las croquetas del carrito',
        'ya no quiero las croquetas',
        'sí',
        '¿cuánto cuesta el envío?',
      ])
        expect(await w.say(text)).toBeNull();
      expect(w.client.listBackorders).not.toHaveBeenCalled();
      expect(w.competing).not.toHaveBeenCalled();
    });

    it('generic wording with another order or purchase in progress is not ours, and asks nothing of the backend', async () => {
      const w = world();
      w.competing.mockResolvedValue(true);
      expect(await w.say('ya no quiero el pedido')).toBeNull();
      expect(await w.say('cancela mi pedido')).toBeNull();
      expect(await w.say('¿cómo va mi pedido?')).toBeNull();
      expect(w.client.listBackorders).not.toHaveBeenCalled();
    });

    it('explicit wording is ours even with another order in progress', async () => {
      const w = world();
      w.competing.mockResolvedValue(true);
      expect(replyOf(await w.say('cancela mi pedido por reposición'))).toBe(
        QUESTION,
      );
      expect(w.competing).not.toHaveBeenCalled();
    });

    it('generic wording with only the backorder is ours', async () => {
      const w = world();
      expect(replyOf(await w.say('ya no quiero el pedido'))).toBe(QUESTION);
      expect(w.competing).toHaveBeenCalledTimes(1);
    });

    it('a failing context check keeps generic wording out (fail closed)', async () => {
      const w = world();
      w.competing.mockRejectedValue(new Error('boom'));
      expect(await w.say('ya no quiero el pedido')).toBeNull();
    });

    it('a failing list: explicit gets an honest reply, generic is left to the other flows', async () => {
      const w = world();
      w.client.listBackorders.mockRejectedValue(apiError(500, null));
      expect(replyOf(await w.say('cancela mi pedido por reposición'))).toBe(
        'No pude cancelarlo por ahora.',
      );
      expect(await w.say('ya no quiero el pedido')).toBeNull();
    });

    it('a shared phone (ambiguous) is never guessed', async () => {
      const w = world();
      w.client.listBackorders.mockRejectedValue(
        apiError(409, 'CUSTOMER_PHONE_AMBIGUOUS'),
      );
      expect(replyOf(await w.say('cancela lo que aparté'))).toBe(
        'No pude cancelarlo por ahora.',
      );
      expect(w.client.cancelBackorder).not.toHaveBeenCalled();
    });

    it('a non-Mexican sender is not ours (the backend phone contract is Mexican)', async () => {
      const w = world();
      expect(
        await w.say('cancela lo que aparté', undefined, '14155550123'),
      ).toBe(null);
      expect(w.client.listBackorders).not.toHaveBeenCalled();
    });
  });
});

describe('status from the chat (S8)', () => {
  it('WAITING with a future estimate: the local date and the notice promise', async () => {
    const w = world();
    expect(replyOf(await w.say('¿cómo va mi pedido por reposición?'))).toBe(
      'Su pedido BO-000012 sigue en espera; llega aprox. el 26 de noviembre. Le aviso en cuanto llegue.',
    );
    expect(w.client.cancelBackorder).not.toHaveBeenCalled();
  });

  it('WAITING with a past estimate omits the date', async () => {
    const w = world([backorder({ estimatedAt: PAST })]);
    expect(replyOf(await w.say('¿ya llegó lo que aparté?'))).toBe(
      'Su pedido BO-000012 sigue en espera; estamos confirmando la fecha con el equipo. Le aviso en cuanto llegue.',
    );
  });

  it('RESERVED: arrived and set aside until the local date and time (no checkout offered)', async () => {
    const w = world([
      backorder({
        status: 'RESERVED',
        reservedAt: '2026-11-20T11:00:00.000Z',
        // 15:00 UTC is 09:00 in Mexico City (UTC-6 in November).
        reservedUntil: '2026-11-21T15:00:00.000Z',
        queuePosition: null,
      }),
    ]);
    const turn = await w.say('¿ya llegó lo que aparté?');
    expect(turn).toEqual({
      kind: 'reply',
      reply:
        '¡Ya llegó! Se lo tenemos apartado hasta el 21 de noviembre a las 9:00 a. m.',
    });
    expect((turn as { interactive?: unknown }).interactive).toBeUndefined();
  });

  it('RESERVED with a deadline already past does not state it', async () => {
    const w = world([
      backorder({
        status: 'RESERVED',
        reservedUntil: '2026-11-19T15:00:00.000Z',
      }),
    ]);
    expect(replyOf(await w.say('¿ya llegó lo que aparté?'))).toBe(
      '¡Ya llegó! Estamos confirmando con el equipo hasta cuándo se lo tenemos apartado.',
    );
  });

  it('PM times read «p. m.»', async () => {
    const w = world([
      backorder({
        status: 'RESERVED',
        reservedUntil: '2026-11-21T21:30:00.000Z',
      }),
    ]);
    expect(replyOf(await w.say('¿ya llegó lo que aparté?'))).toBe(
      '¡Ya llegó! Se lo tenemos apartado hasta el 21 de noviembre a las 3:30 p. m.',
    );
  });

  it('several active: one line each, folio named', async () => {
    const w = world([
      backorder(),
      backorder({
        id: ID2,
        folio: 'BO-000013',
        status: 'RESERVED',
        reservedUntil: '2026-11-21T15:00:00.000Z',
      }),
    ]);
    expect(replyOf(await w.say('¿cómo va lo que aparté?'))).toBe(
      [
        'Tiene varios pedidos por reposición:',
        'Su pedido BO-000012 sigue en espera; llega aprox. el 26 de noviembre. Le aviso en cuanto llegue.',
        'Su pedido BO-000013 ya llegó y se lo tenemos apartado hasta el 21 de noviembre a las 9:00 a. m.',
      ].join('\n'),
    );
  });

  it('the generic «¿cómo va mi pedido?» is ours only with nothing else in progress', async () => {
    const w = world();
    expect(replyOf(await w.say('¿cómo va mi pedido?'))).toContain(
      'sigue en espera',
    );
    w.competing.mockResolvedValue(true);
    expect(await w.say('¿cómo va mi pedido?')).toBeNull();
  });

  it('the generic status with an unpaid placed sale prefers the sale status path unless the text names the restock order', async () => {
    const w = world();
    w.competing.mockResolvedValue(true);
    expect(await w.say('¿ya llegó mi pedido?')).toBeNull();
    expect(
      replyOf(await w.say('¿ya llegó mi pedido por reposición?')),
    ).toContain('sigue en espera');
  });

  it('a failing list is honest for explicit wording, silent for generic', async () => {
    const w = world();
    w.client.listBackorders.mockRejectedValue(apiError(500, null));
    expect(replyOf(await w.say('¿cómo va mi pedido por reposición?'))).toBe(
      'No pude consultar su pedido por ahora.',
    );
    expect(await w.say('¿cómo va mi pedido?')).toBeNull();
  });
});

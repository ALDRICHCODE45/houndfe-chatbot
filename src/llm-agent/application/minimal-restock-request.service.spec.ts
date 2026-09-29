import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import * as preflight from '../../human-decisions/application/restock-request-preflight';
import {
  MINIMAL_RESTOCK_AMBIGUOUS_REPLY,
  MINIMAL_RESTOCK_PENDING_TTL_MS,
  MinimalRestockRequestService,
} from './minimal-restock-request.service';

type Stock = StockCheckResponse;
const SENDER = '5215550001111';
const PRODUCT = '00000000-0000-4000-8000-000000000001';
const VARIANT = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-0000000000ff';
const PROPOSAL = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.P',
};
const CONFIRM = { ...PROPOSAL, messageId: 'wamid.C' };
const ALLOWED = new Set([PRODUCT]);
const INTAKE = {
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: 'Croquetas',
};
const AMBIGUOUS = { kind: 'handled', reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY };
const CONFIRMED = {
  kind: 'handled',
  reply:
    '¡Listo! 😊 Ya quedó registrada su consulta sobre la reposición de «Croquetas». ¡Gracias!',
};
type Classify = (
  question: string,
  reply: string,
) => Promise<'accept' | 'decline' | 'unclear'>;
const restockRoute = () =>
  jest
    .spyOn(preflight, 'preflightRestockRequest')
    .mockResolvedValue({ route: 'restock', intake: INTAKE } as never);

const parent = (o: Partial<Stock> = {}): Stock => ({
  productId: PRODUCT,
  name: 'Croquetas',
  stock: { status: 'out_of_stock', quantity: 0 },
  variants: [],
  ...o,
});
const variant = (
  o: Partial<Stock['variants'][number]> = {},
): Stock['variants'][number] => ({
  variantId: VARIANT,
  name: 'Sabor pollo',
  option: 'Sabor',
  value: 'Pollo',
  stock: { status: 'out_of_stock', quantity: 0 },
  ...o,
});
const vid = (n: number): Stock['variants'][number] =>
  variant({
    variantId: `00000000-0000-4000-8000-a${String(n).padStart(11, '0')}`,
    name: `Presentación ${n}`,
    option: 'Tamaño',
    value: `${n} kg`,
  });

function hz(stock: Stock = parent(), enabled = true) {
  let now = 1_000_000;
  const getStock = jest.fn(async () => stock);
  const coordinate: jest.Mock = jest.fn(async () => ({
    decision: 'recorded',
    historicalPollId: 'POLL',
  }));
  const recover: jest.Mock = jest.fn(async () => ({ outcome: 'unavailable' }));
  const chatbotApi = { getStock };
  const store = { get: jest.fn(async () => null) };
  const restock = {
    enabled: true as const,
    markers: {},
    coordinator: { coordinate },
    recovery: { recover },
  };
  const service = new MinimalRestockRequestService({
    chatbotApi: chatbotApi as never,
    store: store as never,
    restock: enabled ? (restock as never) : undefined,
    clock: () => now,
  });
  return {
    service,
    getStock,
    chatbotApi,
    store,
    coordinate,
    recover,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
type Hz = ReturnType<typeof hz>;

const prep = (o: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  inboundEvent: PROPOSAL,
  allowedProductIds: ALLOWED,
  productId: PRODUCT,
  ...o,
});
const say = (
  h: Hz,
  text = 'SÍ',
  inboundEvent: unknown = CONFIRM,
  classify?: Classify,
) =>
  h.service.consume({
    senderId: SENDER,
    text,
    inboundEvent,
    ...(classify === undefined ? {} : { classify }),
  });
async function offer(h: Hz) {
  const r = await h.service.prepare(prep());
  if (r.kind !== 'offer') throw new Error('expected an offer');
  return r;
}

describe('MinimalRestockRequestService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('default-off: enabled is false, prepare closes and consume is null', async () => {
    const h = hz(parent(), false);
    expect(h.service.enabled).toBe(false);
    expect(await h.service.prepare(prep())).toEqual({
      kind: 'closed',
      reason: 'disabled',
    });
    expect(await say(h)).toBeNull();
    expect(h.getStock).not.toHaveBeenCalled();
  });

  it('prepare ends on a natural question and writes nothing', async () => {
    const h = hz();
    const o = await offer(h);
    expect(o.reply).toBe(
      'Por ahora no tenemos «Croquetas» 😕. ¿Quiere que consulte si hay una fecha estimada de reposición?',
    );
    expect(o.reply.endsWith('?')).toBe(true);
    expect(o.reply).not.toContain('Responda');
    expect(h.getStock).toHaveBeenCalledTimes(1);
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('never writes before onSent, and a stale onSent cannot arm a replaced pending', async () => {
    const h = hz();
    const first = await offer(h);
    expect(await say(h)).toEqual(AMBIGUOUS);
    await offer(h);
    first.onSent();
    expect(await say(h)).toEqual(AMBIGUOUS);
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('an armed exact SÍ on a new bound message runs ONE coordinator request with the canonical digest', async () => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    o.onSent();
    await expect(say(h)).resolves.toEqual(CONFIRMED);
    const [pIn, pDeps] = spy.mock.calls[0];
    expect(pIn).toMatchObject({
      senderId: SENDER,
      digest: { productId: PRODUCT, name: 'Croquetas' },
      inboundEvent: CONFIRM,
    });
    expect(CatalogSession.is(pIn.catalogSession)).toBe(true);
    expect(pDeps).toMatchObject({
      conversation: h.store,
      catalog: h.chatbotApi,
    });
    expect(h.coordinate).toHaveBeenCalledWith({
      senderId: SENDER,
      intake: INTAKE,
    });
  });

  it('requires and carries an explicit variant, adding option/value when names repeat', async () => {
    const spy = restockRoute();
    const h = hz(
      parent({
        variants: [
          variant({ variantId: VARIANT, name: 'Clásico', value: '1 kg' }),
          variant({ variantId: OTHER, name: 'Clásico', value: '3 kg' }),
        ],
      }),
    );
    const o = await h.service.prepare(prep({ variantId: OTHER }));
    expect(o.kind).toBe('offer');
    if (o.kind !== 'offer') throw new Error('expected an offer');
    expect(o.reply).toContain('Clásico: Sabor 3 kg');
    o.onSent();
    await say(h);
    expect(spy.mock.calls[0][0].digest).toEqual({
      productId: PRODUCT,
      name: 'Croquetas',
      variantId: OTHER,
    });
  });

  it('an exact NO clears and a later SÍ is left to the ordinary SDK', async () => {
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(await say(h, 'no')).toEqual({
      kind: 'handled',
      reply: 'Entendido, no registraré su consulta de reposición. ¡Gracias!',
    });
    expect(await say(h)).toBeNull();
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  const CLARIFY = {
    kind: 'handled',
    reply:
      'Perdón, no estoy seguro de haberle entendido. ¿Quiere que consulte si hay una fecha estimada de reposición?',
  };

  it('unrelated text keeps the pending and asks a natural clarification', async () => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(await say(h, '¿Tienen otra talla?')).toEqual(CLARIFY);
    expect(await say(h, 'SÍ', { ...CONFIRM, messageId: 'wamid.C2' })).toEqual(
      CONFIRMED,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.coordinate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'SÍ, por favor',
    'Si por favor.',
    'SI POR FAVOR',
    'sí,  por\tfavor',
  ])('a bounded polite affirmative (%s) writes exactly once', async (text) => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(await say(h, text)).toEqual(CONFIRMED);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.coordinate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'sí pero no',
    'no sé',
    'si por favor no, mejor no',
    'por favor',
    'SÍ, por favor, gracias',
    'NO, por favor',
  ])(
    'a mixed or loose intent (%s) has no fast consent and writes nothing',
    async (text) => {
      const spy = restockRoute();
      const h = hz();
      const o = await offer(h);
      o.onSent();
      expect(await say(h, text)).toEqual(CLARIFY);
      expect(spy).not.toHaveBeenCalled();
      expect(h.coordinate).not.toHaveBeenCalled();
    },
  );

  it('a polite affirmative with no pending never writes', async () => {
    const spy = restockRoute();
    const h = hz();
    expect(await say(h, 'Sí, por favor')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('an unarmed polite affirmative stays ambiguous and writes nothing', async () => {
    const h = hz();
    await offer(h);
    expect(await say(h, 'Sí, por favor')).toEqual(AMBIGUOUS);
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('a polite affirmative on the origin replay never counts as consent', async () => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(await say(h, 'Sí, por favor', PROPOSAL)).toMatchObject({
      kind: 'handled',
      reply: o.reply,
    });
    expect(h.coordinate).not.toHaveBeenCalled();
    expect((await say(h, 'sí'))?.kind).toBe('handled');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('an expired pending never writes', async () => {
    const h = hz();
    const o = await offer(h);
    o.onSent();
    h.advance(MINIMAL_RESTOCK_PENDING_TTL_MS);
    expect(await say(h)).toEqual(AMBIGUOUS);
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('a replayed proposal never counts as consent and does not poison later consent', async () => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(await say(h, 'SÍ', PROPOSAL)).toMatchObject({
      kind: 'handled',
      reply: o.reply,
    });
    expect(h.coordinate).not.toHaveBeenCalled();
    expect((await say(h))?.kind).toBe('handled');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.coordinate).toHaveBeenCalledTimes(1);
  });

  it('a replayed origin question re-exposes a checked onSent so a resend can arm it', async () => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    // The initial send failed, so `onSent` was never called and the pending is
    // still unarmed; the origin replay must carry a checked arming callback.
    const replay = await say(h, 'SÍ', PROPOSAL);
    expect(replay).toMatchObject({ kind: 'handled', reply: o.reply });
    expect(replay?.onSent).toBeInstanceOf(Function);
    expect(h.coordinate).not.toHaveBeenCalled();
    replay?.onSent?.();
    await expect(say(h)).resolves.toEqual(CONFIRMED);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.coordinate).toHaveBeenCalledTimes(1);
  });

  it('a mismatched origin phone or a different sender is not a trusted confirmation', async () => {
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(
      await say(h, 'SÍ', {
        ...CONFIRM,
        receivingPhoneNumberId: '9'.repeat(15),
      }),
    ).toEqual(AMBIGUOUS);
    expect(
      await h.service.consume({
        senderId: '5215550009999',
        text: 'SÍ',
        inboundEvent: { ...CONFIRM, senderId: '5215550009999' },
      }),
    ).toBeNull();
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('an untrusted or unarmed NO never drops the pending or claims a decline', async () => {
    const h = hz();
    const o = await offer(h);
    expect(await say(h, 'no')).toEqual(AMBIGUOUS);
    o.onSent();
    expect(
      await say(h, 'no', {
        ...CONFIRM,
        receivingPhoneNumberId: '9'.repeat(15),
      }),
    ).toEqual(AMBIGUOUS);
    expect(await say(h, 'no', PROPOSAL)).toMatchObject({
      kind: 'handled',
      reply: o.reply,
    });
    const spy = restockRoute();
    expect((await say(h, 'sí'))?.kind).toBe('handled');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('unrelated text on a wrong channel or unbound identity never clears a valid pending', async () => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(
      await say(h, '¿Tienen otra talla?', {
        ...CONFIRM,
        receivingPhoneNumberId: '9'.repeat(15),
      }),
    ).toBeNull();
    expect(
      await say(h, '¿Tienen otra talla?', { senderId: SENDER }),
    ).toBeNull();
    expect((await say(h, 'sí'))?.kind).toBe('handled');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('offers an exact variant even when the product lists more variants than one prompt', async () => {
    const h = hz(
      parent({ variants: Array.from({ length: 7 }, (_, i) => vid(i + 1)) }),
    );
    const o = await h.service.prepare(prep({ variantId: vid(7).variantId }));
    expect(o.kind).toBe('offer');
    if (o.kind !== 'offer') throw new Error('expected an offer');
    expect(o.reply).toContain('Presentación 7');
  });

  it('closes when the 7-variant selection collides with an indistinguishable one', async () => {
    const h = hz(
      parent({
        variants: [
          vid(1),
          vid(2),
          vid(3),
          vid(4),
          vid(5),
          vid(6),
          variant({
            variantId: vid(7).variantId,
            name: 'Presentación 1',
            option: 'Tamaño',
            value: '1 kg',
          }),
        ],
      }),
    );
    expect(
      await h.service.prepare(prep({ variantId: vid(1).variantId })),
    ).toEqual({ kind: 'closed', reason: 'display_unsafe_or_ambiguous' });
  });

  it.each<
    [
      string,
      Stock['variants'],
      string[],
      { variantId: string; fragment: string },
    ]
  >([
    [
      'a unique raw name that renders like a repeated name plus detail',
      [
        variant({
          variantId: vid(1).variantId,
          name: 'Clásico: Sabor 3 kg',
          option: 'Sabor',
          value: '3 kg',
        }),
        variant({
          variantId: vid(2).variantId,
          name: 'Clásico',
          option: 'Sabor',
          value: '3 kg',
        }),
        variant({
          variantId: vid(3).variantId,
          name: 'Clásico',
          option: 'Sabor',
          value: '6 kg',
        }),
      ],
      [vid(1).variantId, vid(2).variantId],
      { variantId: vid(3).variantId, fragment: 'Clásico: Sabor 6 kg' },
    ],
    [
      'a unique raw name that aliases an exact raw duplicate pair',
      [
        variant({
          variantId: vid(1).variantId,
          name: 'Clásico: Sabor 3 kg',
          option: 'Sabor',
          value: '3 kg',
        }),
        variant({
          variantId: vid(2).variantId,
          name: 'Clásico',
          option: 'Sabor',
          value: '3 kg',
        }),
        variant({
          variantId: vid(3).variantId,
          name: 'Clásico',
          option: 'Sabor',
          value: '3 kg',
        }),
        variant({
          variantId: vid(4).variantId,
          name: 'Clásico',
          option: 'Sabor',
          value: '6 kg',
        }),
      ],
      [vid(1).variantId, vid(2).variantId, vid(3).variantId],
      { variantId: vid(4).variantId, fragment: 'Clásico: Sabor 6 kg' },
    ],
    [
      'two different option/value tuples that join with a space',
      [
        variant({
          variantId: vid(1).variantId,
          name: 'Clásico',
          option: 'Sabor a',
          value: 'b c',
        }),
        variant({
          variantId: vid(2).variantId,
          name: 'Clásico',
          option: 'Sabor',
          value: 'a b c',
        }),
        variant({
          variantId: vid(3).variantId,
          name: 'Clásico',
          option: 'Sabor',
          value: 'Chocolate',
        }),
      ],
      [vid(1).variantId, vid(2).variantId],
      { variantId: vid(3).variantId, fragment: 'Clásico: Sabor Chocolate' },
    ],
  ])(
    'closes a selected variant whose rendered label aliases another (%s)',
    async (_name, variants, ambiguous, unique) => {
      for (const ambiguousId of ambiguous) {
        const h = hz(parent({ variants }));
        expect(
          await h.service.prepare(prep({ variantId: ambiguousId })),
        ).toEqual({ kind: 'closed', reason: 'display_unsafe_or_ambiguous' });
        expect(h.coordinate).not.toHaveBeenCalled();
      }
      const h = hz(parent({ variants }));
      const o = await h.service.prepare(prep({ variantId: unique.variantId }));
      expect(o.kind).toBe('offer');
      if (o.kind !== 'offer') throw new Error('expected an offer');
      expect(o.reply).toContain(unique.fragment);
    },
  );

  it('closes when the selected label carries a display-breaking control character', async () => {
    const h = hz(
      parent({
        variants: [
          variant({ variantId: vid(1).variantId, name: 'Clásico\u202E' }),
        ],
      }),
    );
    expect(
      await h.service.prepare(prep({ variantId: vid(1).variantId })),
    ).toEqual({ kind: 'closed', reason: 'display_unsafe_or_ambiguous' });
  });

  it('a double SÍ consumes the pending once', async () => {
    const spy = restockRoute();
    const h = hz();
    const o = await offer(h);
    o.onSent();
    const [ra, rb] = await Promise.all([say(h), say(h)]);
    expect(ra?.kind).toBe('handled');
    expect(rb).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('RAM-only: a fresh instance has no pending (lost on restart)', async () => {
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(
      await hz().service.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: CONFIRM,
      }),
    ).toBeNull();
  });

  it.each<[string, Stock, Record<string, unknown>, string]>([
    [
      'parent available',
      parent({ stock: { status: 'available', quantity: 4 } }),
      {},
      'parent_not_depleted',
    ],
    [
      'parent quantity nonzero',
      parent({ stock: { status: 'out_of_stock', quantity: 3 } }),
      {},
      'parent_not_depleted',
    ],
    [
      'parent not managed',
      parent({ stock: { status: 'not_managed', quantity: null } }),
      {},
      'parent_not_depleted',
    ],
    [
      'variant required but omitted',
      parent({ variants: [variant()] }),
      {},
      'variant_required',
    ],
    [
      'unknown variant',
      parent({ variants: [variant()] }),
      { variantId: OTHER },
      'variant_unresolved',
    ],
    [
      'variant available',
      parent({
        variants: [variant({ stock: { status: 'available', quantity: 2 } })],
      }),
      { variantId: VARIANT },
      'variant_not_depleted',
    ],
    [
      'variant not managed',
      parent({
        variants: [
          variant({ stock: { status: 'not_managed', quantity: null } }),
        ],
      }),
      { variantId: VARIANT },
      'variant_not_depleted',
    ],
    [
      'an unexpected variant on a variantless product',
      parent(),
      { variantId: VARIANT },
      'unexpected_variant',
    ],
    [
      'a non-uuid product reference',
      parent(),
      { productId: 'not-a-uuid' },
      'invalid_reference',
    ],
    [
      'a stale subject identity',
      parent({ productId: OTHER }),
      {},
      'subject_mismatch',
    ],
    [
      'an unrepresentable catalog snapshot',
      parent({ name: 'x'.repeat(257), variants: [variant()] }),
      { variantId: VARIANT },
      'catalog_unresolved',
    ],
  ])(
    'prepare closes on %s with an exact reason, no pending and no write',
    async (_name, stock, inputOver, reason) => {
      const h = hz(stock);
      expect(await h.service.prepare(prep(inputOver))).toEqual({
        kind: 'closed',
        reason,
      });
      expect(await say(h)).toBeNull();
      expect(h.coordinate).not.toHaveBeenCalled();
    },
  );

  it('maps a stock read failure to stock_read_failed without leaking the error', async () => {
    const h = hz();
    h.getStock.mockRejectedValueOnce(new Error('RAW_READ_SENTINEL'));
    expect(await h.service.prepare(prep())).toEqual({
      kind: 'closed',
      reason: 'stock_read_failed',
    });
    expect(await say(h)).toBeNull();
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('prepare closes when the product is not allowlisted or the identity is unbound', async () => {
    const a = hz();
    expect(
      await a.service.prepare(prep({ allowedProductIds: new Set<string>() })),
    ).toEqual({ kind: 'closed', reason: 'unknown_product' });
    const b = hz();
    expect(
      await b.service.prepare(prep({ inboundEvent: { senderId: SENDER } })),
    ).toEqual({ kind: 'closed', reason: 'identity_unbound' });
    expect(a.getStock).not.toHaveBeenCalled();
    expect(b.getStock).not.toHaveBeenCalled();
  });

  it('a coordinator hold stays truthful and claims no registration', async () => {
    const h = hz();
    h.coordinate.mockResolvedValueOnce({
      decision: 'hold',
      reason: 'unknown_hold',
    });
    const o = await offer(h);
    o.onSent();
    expect(await say(h)).toEqual(AMBIGUOUS);
  });

  it('an already accepted request reports the existing record, not a new creation', async () => {
    jest.spyOn(preflight, 'preflightRestockRequest').mockResolvedValue({
      route: 'blocked',
      reason: 'existing_restock',
    } as never);
    const h = hz();
    h.recover.mockResolvedValueOnce({
      outcome: 'existing_restock_recorded',
      status: 'pending',
    });
    const o = await offer(h);
    o.onSent();
    expect(await say(h)).toEqual({
      kind: 'handled',
      reply:
        'Su consulta sobre la reposición de «Croquetas» ya estaba registrada. ¡Gracias!',
    });
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  describe('semantic consent seam (mock classifier only)', () => {
    const NATURAL_QUESTION =
      'Por ahora no tenemos «Croquetas» 😕. ¿Quiere que consulte si hay una fecha estimada de reposición?';
    const DECLINED = {
      kind: 'handled',
      reply: 'Entendido, no registraré su consulta de reposición. ¡Gracias!',
    };
    const newEvent = (id: string) => ({ ...PROPOSAL, messageId: id });
    const classifier = (verdict: 'accept' | 'decline' | 'unclear'): Classify =>
      jest.fn(async () => verdict);

    it.each([
      'sí, muchas gracias, me ayudaría mucho',
      'por favor',
      'claro',
      'adelante',
    ])(
      'accepts a natural positive (%s) once through the seam',
      async (text) => {
        const spy = restockRoute();
        const h = hz();
        const o = await offer(h);
        o.onSent();
        const classify = classifier('accept');
        await expect(say(h, text, CONFIRM, classify)).resolves.toEqual(
          CONFIRMED,
        );
        expect(classify).toHaveBeenCalledWith(NATURAL_QUESTION, text);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(h.coordinate).toHaveBeenCalledTimes(1);
      },
    );

    it('declines through the seam without writing and clears the pending', async () => {
      const h = hz();
      const o = await offer(h);
      o.onSent();
      await expect(
        say(h, 'mejor no', CONFIRM, classifier('decline')),
      ).resolves.toEqual(DECLINED);
      expect(await say(h, 'sí')).toBeNull();
      expect(h.coordinate).not.toHaveBeenCalled();
    });

    it('keeps the pending and clarifies on unclear, then a fresh clear SÍ writes', async () => {
      const spy = restockRoute();
      const h = hz();
      const o = await offer(h);
      o.onSent();
      await expect(
        say(h, '¿tienen otra talla?', CONFIRM, classifier('unclear')),
      ).resolves.toEqual(CLARIFY);
      await expect(say(h, 'SÍ', newEvent('wamid.N1'))).resolves.toEqual(
        CONFIRMED,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.coordinate).toHaveBeenCalledTimes(1);
    });

    it('clarifies without a seam or on a classifier failure, never writing', async () => {
      const h = hz();
      const o = await offer(h);
      o.onSent();
      await expect(say(h, 'claro')).resolves.toEqual(CLARIFY);
      const boom: Classify = jest.fn(async () => {
        throw new Error('RAW_SENTINEL');
      });
      await expect(say(h, 'ok', CONFIRM, boom)).resolves.toEqual(CLARIFY);
      expect(h.coordinate).not.toHaveBeenCalled();
    });

    it('never upgrades an already-classified message on replay even with new text', async () => {
      const spy = restockRoute();
      const h = hz();
      const o = await offer(h);
      o.onSent();
      await expect(
        say(h, 'no sé', CONFIRM, classifier('unclear')),
      ).resolves.toEqual(CLARIFY);
      const replay = classifier('accept');
      await expect(say(h, 'SÍ', CONFIRM, replay)).resolves.toEqual(CLARIFY);
      expect(replay).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      expect(h.coordinate).not.toHaveBeenCalled();
    });

    it('bounds classifier calls and still honors a fresh clear SÍ', async () => {
      const spy = restockRoute();
      const h = hz();
      const o = await offer(h);
      o.onSent();
      const classify = classifier('unclear');
      for (let i = 0; i < 16; i++)
        await expect(
          say(h, 'no sé', newEvent(`wamid.${i}`), classify),
        ).resolves.toEqual(CLARIFY);
      expect(classify).toHaveBeenCalledTimes(16);
      await expect(
        say(h, 'nada', newEvent('wamid.16'), classify),
      ).resolves.toEqual(CLARIFY);
      expect(classify).toHaveBeenCalledTimes(16);
      await expect(say(h, 'SÍ', newEvent('wamid.17'))).resolves.toEqual(
        CONFIRMED,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.coordinate).toHaveBeenCalledTimes(1);
    });

    it('never classifies untrusted, unarmed, origin or expired turns', async () => {
      const classify = classifier('accept');
      const untrusted = hz();
      (await offer(untrusted)).onSent();
      await expect(
        say(
          untrusted,
          'claro',
          { ...CONFIRM, receivingPhoneNumberId: '9'.repeat(15) },
          classify,
        ),
      ).resolves.toBeNull();
      const unarmed = hz();
      await offer(unarmed);
      await expect(
        say(unarmed, 'claro', CONFIRM, classify),
      ).resolves.toBeNull();
      const origin = hz();
      (await offer(origin)).onSent();
      await expect(
        say(origin, 'claro', PROPOSAL, classify),
      ).resolves.toBeNull();
      const expired = hz();
      (await offer(expired)).onSent();
      expired.advance(MINIMAL_RESTOCK_PENDING_TTL_MS);
      await expect(
        say(expired, 'claro', newEvent('wamid.E'), classify),
      ).resolves.toBeNull();
      expect(classify).not.toHaveBeenCalled();
    });

    it('cannot write when the pending expires while the classifier is in flight', async () => {
      const spy = restockRoute();
      const h = hz();
      const o = await offer(h);
      o.onSent();
      let release!: (verdict: 'accept') => void;
      const gate = new Promise<'accept'>((resolve) => {
        release = resolve;
      });
      const inFlight: Classify = jest.fn(() => gate);
      const pending = say(h, 'claro', CONFIRM, inFlight);
      h.advance(MINIMAL_RESTOCK_PENDING_TTL_MS);
      release('accept');
      await expect(pending).resolves.toEqual(CLARIFY);
      expect(spy).not.toHaveBeenCalled();
      expect(h.coordinate).not.toHaveBeenCalled();
    });

    it('writes once when two new messages accept concurrently', async () => {
      const spy = restockRoute();
      const h = hz();
      const o = await offer(h);
      o.onSent();
      const classify = classifier('accept');
      const [a, b] = await Promise.all([
        say(h, 'claro', newEvent('wamid.A1'), classify),
        say(h, 'adelante', newEvent('wamid.A2'), classify),
      ]);
      expect([a, b].filter((r) => r?.reply === CONFIRMED.reply)).toHaveLength(
        1,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.coordinate).toHaveBeenCalledTimes(1);
    });

    it('memoizes a no-seam ambiguous event so a later seam cannot grant permission on redelivery', async () => {
      const spy = restockRoute();
      const h = hz();
      const o = await offer(h);
      o.onSent();
      await expect(say(h, 'claro', CONFIRM)).resolves.toEqual(CLARIFY);
      const classify = classifier('accept');
      await expect(say(h, 'claro', CONFIRM, classify)).resolves.toEqual(
        CLARIFY,
      );
      expect(classify).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      // A genuinely new message can still be classified later.
      await expect(
        say(h, 'adelante', newEvent('wamid.N2'), classifier('accept')),
      ).resolves.toEqual(CONFIRMED);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.coordinate).toHaveBeenCalledTimes(1);
    });

    it('cannot act on a deferred accept after the pending was replaced', async () => {
      const spy = restockRoute();
      const h = hz();
      const first = await offer(h);
      first.onSent();
      let release!: (verdict: 'accept') => void;
      const gate = new Promise<'accept'>((resolve) => {
        release = resolve;
      });
      const inFlight = say(
        h,
        'claro',
        CONFIRM,
        jest.fn(() => gate),
      );
      const second = await offer(h);
      release('accept');
      await expect(inFlight).resolves.toEqual(CLARIFY);
      expect(spy).not.toHaveBeenCalled();
      expect(h.coordinate).not.toHaveBeenCalled();
      // The replacement still needs its own sent question and a new reply.
      expect(await say(h, 'SÍ', newEvent('wamid.R1'))).toEqual(AMBIGUOUS);
      second.onSent();
      await expect(say(h, 'SÍ', newEvent('wamid.R2'))).resolves.toEqual(
        CONFIRMED,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.coordinate).toHaveBeenCalledTimes(1);
    });

    it('contains a deferred classification whose post-await clock throws', async () => {
      const spy = restockRoute();
      let failClock = false;
      const getStock = jest.fn(async () => parent());
      const coordinate = jest.fn(async () => ({ decision: 'recorded' }));
      const service = new MinimalRestockRequestService({
        chatbotApi: { getStock } as never,
        store: { get: jest.fn(async () => null) } as never,
        restock: {
          enabled: true,
          markers: {},
          coordinator: { coordinate },
          recovery: {
            recover: jest.fn(async () => ({ outcome: 'unavailable' })),
          },
        } as never,
        clock: () => {
          if (failClock) throw new Error('clock down');
          return 1_000_000;
        },
      });
      const prepared = await service.prepare(prep());
      if (prepared.kind !== 'offer') throw new Error('expected an offer');
      prepared.onSent();
      let release!: (verdict: 'accept') => void;
      const gate = new Promise<'accept'>((resolve) => {
        release = resolve;
      });
      const inFlight = service.consume({
        senderId: SENDER,
        text: 'claro',
        inboundEvent: CONFIRM,
        classify: jest.fn(() => gate),
      });
      failClock = true;
      release('accept');
      await expect(inFlight).resolves.toEqual(AMBIGUOUS);
      expect(spy).not.toHaveBeenCalled();
      expect(coordinate).not.toHaveBeenCalled();
      expect(getStock).toHaveBeenCalledTimes(1);
    });
  });
});

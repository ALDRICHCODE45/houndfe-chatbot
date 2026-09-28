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
    'Ya quedó registrada su consulta sobre cuándo tendremos «Croquetas» de nuevo.',
};
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
const say = (h: Hz, text = 'SÍ', inboundEvent: unknown = CONFIRM) =>
  h.service.consume({ senderId: SENDER, text, inboundEvent });
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
    expect(await h.service.prepare(prep())).toEqual({ kind: 'closed' });
    expect(await say(h)).toBeNull();
    expect(h.getStock).not.toHaveBeenCalled();
  });

  it('prepare offers one clear SÍ/NO question and writes nothing', async () => {
    const h = hz();
    const o = await offer(h);
    expect(o.reply).toBe(
      '¿Quiere que registre una consulta sobre la reposición de «Croquetas»? Responda SÍ o NO.',
    );
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

  it('NO clears and a later SÍ is left to the ordinary SDK', async () => {
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(await say(h, 'no')).toEqual({
      kind: 'handled',
      reply: 'Entendido, no registraré la consulta de reposición.',
    });
    expect(await say(h)).toBeNull();
    expect(h.coordinate).not.toHaveBeenCalled();
  });

  it('any other text clears the pending and returns null (no stale consent)', async () => {
    const h = hz();
    const o = await offer(h);
    o.onSent();
    expect(await say(h, '¿Tienen otra talla?')).toBeNull();
    expect(await say(h)).toBeNull();
    expect(h.coordinate).not.toHaveBeenCalled();
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
    ).toEqual({ kind: 'closed' });
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
        ).toEqual({ kind: 'closed' });
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
    ).toEqual({ kind: 'closed' });
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

  it.each<[string, Stock, Record<string, unknown>]>([
    [
      'parent available',
      parent({ stock: { status: 'available', quantity: 4 } }),
      {},
    ],
    [
      'parent quantity nonzero',
      parent({ stock: { status: 'out_of_stock', quantity: 3 } }),
      {},
    ],
    [
      'parent not managed',
      parent({ stock: { status: 'not_managed', quantity: null } }),
      {},
    ],
    ['variant required but omitted', parent({ variants: [variant()] }), {}],
    [
      'unknown variant',
      parent({ variants: [variant()] }),
      { variantId: OTHER },
    ],
    [
      'variant available',
      parent({
        variants: [variant({ stock: { status: 'available', quantity: 2 } })],
      }),
      { variantId: VARIANT },
    ],
    [
      'variant not managed',
      parent({
        variants: [
          variant({ stock: { status: 'not_managed', quantity: null } }),
        ],
      }),
      { variantId: VARIANT },
    ],
  ])(
    'prepare closes on %s without writing',
    async (_name, stock, inputOver) => {
      const h = hz(stock);
      expect(await h.service.prepare(prep(inputOver))).toEqual({
        kind: 'closed',
      });
      expect(h.coordinate).not.toHaveBeenCalled();
    },
  );

  it('prepare closes when the product is not allowlisted or the identity is unbound', async () => {
    const a = hz();
    expect(
      await a.service.prepare(prep({ allowedProductIds: new Set<string>() })),
    ).toEqual({ kind: 'closed' });
    const b = hz();
    expect(
      await b.service.prepare(prep({ inboundEvent: { senderId: SENDER } })),
    ).toEqual({ kind: 'closed' });
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
      reply: 'Su consulta sobre «Croquetas» ya estaba registrada.',
    });
    expect(h.coordinate).not.toHaveBeenCalled();
  });
});

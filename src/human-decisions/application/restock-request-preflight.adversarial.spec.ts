import { preflightRestockRequest } from './restock-request-preflight';

/**
 * HD-R3b3 adversarial spec for the inert RESTOCK request preflight: every
 * identity, durable-marker, conversation-marker, read, digest, and CATALOG
 * verification failure must BLOCK (never fall back to legacy once the feature
 * is on). Positive paths live in the base spec. The preflight is advisory — the
 * final reserve CAS decides, and a fresh GET is not atomic with it.
 */
const SENDER = 'whatsapp:+5215500000001';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const OTHER_PRODUCT = '66666666-6666-4666-8666-666666666666';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const OTHER_VARIANT = '77777777-7777-4777-8777-777777777777';
const EVENT = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.ABC123',
};
const DIGEST = {
  productId: PRODUCT,
  name: 'Nombre del modelo',
  variantId: VARIANT,
  quantity: 2,
};
const CLEAR = { legacyRequestPending: false, restockIntentPresent: false };
const PENDING_MARKER = {
  requestId: 'r1',
  ref: 'HF-r1',
  createdAt: '2026-06-23T12:00:00.000Z',
  customerNotifiedAt: '2026-06-23T12:00:01.000Z',
};
const VARIANT_ROW = {
  variantId: VARIANT,
  name: 'Variante',
  option: null,
  value: null,
  stock: { status: 'out_of_stock', quantity: 0 },
};
const STOCK = {
  productId: PRODUCT,
  name: 'Croquetas premium (backend)',
  stock: { status: 'out_of_stock', quantity: 0 },
  variants: [VARIANT_ROW],
};
const stock = (over: Record<string, unknown> = {}) => ({ ...STOCK, ...over });
const STATE = (data: unknown, senderId = SENDER) => ({
  senderId,
  lastMessageAt: '2026-06-23T12:00:00.000Z',
  data,
});
const withSender = (senderId: unknown) => ({ ...EVENT, senderId });

const deps = (
  over: {
    markers?: unknown;
    state?: unknown;
    catalog?: unknown;
    fail?: 'markers' | 'get' | 'catalog';
  } = {},
) => {
  const readForSender = jest.fn().mockResolvedValue(over.markers ?? CLEAR);
  const get = jest.fn().mockResolvedValue(over.state ?? null);
  const getStock = jest.fn().mockResolvedValue(over.catalog ?? STOCK);
  if (over.fail === 'markers') readForSender.mockRejectedValue(new Error('db'));
  if (over.fail === 'get') get.mockRejectedValue(new Error('db'));
  if (over.fail === 'catalog') getStock.mockRejectedValue(new Error('http'));
  return {
    conversation: { get },
    markers: { readForSender },
    catalog: { getStock },
    readForSender,
    get,
    getStock,
  };
};
const ask = (d: ReturnType<typeof deps>, over: Record<string, unknown> = {}) =>
  preflightRestockRequest(
    {
      senderId: SENDER,
      inboundEvent: EVENT,
      digest: DIGEST,
      restockFeatureEnabled: true,
      ...over,
    },
    d,
  );

describe('preflightRestockRequest (blocking)', () => {
  it('blocks a missing, mismatched, malformed, or hostile identity BEFORE any read', async () => {
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'receivingPhoneNumberId', {
      get: () => EVENT.receivingPhoneNumberId,
      enumerable: true,
    });
    const cases: unknown[] = [
      undefined,
      null,
      'x',
      {},
      { ...EVENT, senderId: 'whatsapp:+5215500000999' },
      { ...EVENT, extra: 'x' },
      { ...EVENT, messageId: 1 },
      withSender(null),
      accessor,
      new Proxy(
        { ...EVENT },
        {
          get: () => {
            throw new Error('boom');
          },
        },
      ),
    ];
    for (const inboundEvent of cases) {
      const d = deps();
      await expect(ask(d, { inboundEvent })).resolves.toEqual({
        route: 'blocked',
        reason: 'identity_unbound',
      });
      expect(d.readForSender).not.toHaveBeenCalled();
      expect(d.get).not.toHaveBeenCalled();
      expect(d.getStock).not.toHaveBeenCalled();
    }
  });

  it('blocks on durable legacy, restock, conflict, or unknown markers WITHOUT a catalog read', async () => {
    const cases: Array<[unknown, string]> = [
      [
        { legacyRequestPending: true, restockIntentPresent: false },
        'existing_legacy',
      ],
      [
        { legacyRequestPending: false, restockIntentPresent: true },
        'existing_restock',
      ],
      [
        { legacyRequestPending: true, restockIntentPresent: true },
        'conflicting_markers',
      ],
      [
        { legacyRequestPending: 'unknown', restockIntentPresent: false },
        'indeterminate_marker_state',
      ],
      [
        { legacyRequestPending: false, restockIntentPresent: 'unknown' },
        'indeterminate_marker_state',
      ],
    ];
    for (const [markers, reason] of cases) {
      const d = deps({ markers });
      await expect(ask(d)).resolves.toEqual({ route: 'blocked', reason });
      expect(d.getStock).not.toHaveBeenCalled();
    }
  });

  it('blocks on a pending, malformed, or wrong-sender conversation marker', async () => {
    const cases: Array<[unknown, string]> = [
      [STATE({ pendingHumanRequest: PENDING_MARKER }), 'existing_legacy'],
      [
        STATE({ pendingHumanRequest: { requestId: 'r1' } }),
        'indeterminate_marker_state',
      ],
      [STATE({}, 'whatsapp:+5215500000999'), 'indeterminate_marker_state'],
    ];
    for (const [state, reason] of cases) {
      const d = deps({ state });
      await expect(ask(d)).resolves.toEqual({ route: 'blocked', reason });
      expect(d.getStock).not.toHaveBeenCalled();
    }
  });

  it('blocks when a marker read throws, without a catalog read', async () => {
    for (const fail of ['markers', 'get'] as const) {
      const d = deps({ fail });
      await expect(ask(d)).resolves.toEqual({
        route: 'blocked',
        reason: 'marker_read_failed',
      });
      expect(d.getStock).not.toHaveBeenCalled();
    }
  });

  it('blocks an invalid digest without a catalog read or a legacy fallback', async () => {
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      {},
      { productId: 'nope', name: 'x' },
      { productId: PRODUCT, name: '' },
      { productId: PRODUCT, name: 'x', quantity: 0 },
      { productId: PRODUCT, name: 'x', quantity: 1.5 },
      { productId: PRODUCT, name: 'x', variantId: 'nope' },
    ];
    for (const digest of bad) {
      const d = deps();
      await expect(ask(d, { digest })).resolves.toEqual({
        route: 'blocked',
        reason: 'invalid_digest',
      });
      expect(d.getStock).not.toHaveBeenCalled();
    }
  });

  it('blocks when the catalog read throws or the product stock cannot be verified', async () => {
    const thrown = deps({ fail: 'catalog' });
    await expect(ask(thrown)).resolves.toEqual({
      route: 'blocked',
      reason: 'catalog_read_failed',
    });

    const cases: Array<[string, unknown]> = [
      ['productId mismatch', stock({ productId: OTHER_PRODUCT })],
      ['available', stock({ stock: { status: 'available', quantity: 5 } })],
      ['low_stock', stock({ stock: { status: 'low_stock', quantity: 1 } })],
      ['not_managed', stock({ stock: { status: 'not_managed', quantity: 0 } })],
      [
        'officially out but nonzero',
        stock({ stock: { status: 'out_of_stock', quantity: 3 } }),
      ],
      [
        'officially out but null qty',
        stock({ stock: { status: 'out_of_stock', quantity: null } }),
      ],
      ['blank backend name', stock({ name: '   ' })],
      ['malformed stock', stock({ stock: null })],
      ['malformed variants', stock({ variants: 'nope' })],
      ['malformed rows', stock({ variants: [null, 'x'] })],
    ];
    for (const [label, catalog] of cases) {
      const d = deps({ catalog });
      await expect(ask(d)).resolves.toEqual({
        route: 'blocked',
        reason: 'catalog_unverified',
      });
      expect([label, d.getStock.mock.calls.length]).toEqual([label, 1]);
    }
  });

  it('rejects a malformed variants collection even with no selected variant', async () => {
    const digest = { productId: PRODUCT, name: 'Modelo sin variante' };
    for (const variants of [null, 'nope', [null], [{ variantId: VARIANT }]]) {
      await expect(
        ask(deps({ catalog: stock({ variants }) }), { digest }),
      ).resolves.toEqual({ route: 'blocked', reason: 'catalog_unverified' });
    }
  });

  it('blocks a selected variant that is not uniquely out of stock', async () => {
    const variants = (rows: unknown[]) => stock({ variants: rows });
    const cases: unknown[] = [
      variants([]),
      variants([{ ...VARIANT_ROW, variantId: OTHER_VARIANT }]),
      variants([null]),
      variants([VARIANT_ROW, { ...VARIANT_ROW }]),
      variants([
        { ...VARIANT_ROW, stock: { status: 'available', quantity: 2 } },
      ]),
      variants([
        { ...VARIANT_ROW, stock: { status: 'out_of_stock', quantity: 1 } },
      ]),
      variants([
        { ...VARIANT_ROW, stock: { status: 'out_of_stock', quantity: null } },
      ]),
    ];
    for (const catalog of cases) {
      await expect(ask(deps({ catalog }))).resolves.toEqual({
        route: 'blocked',
        reason: 'catalog_unverified',
      });
    }
  });
});

import { CatalogSession } from '../../conversation/domain/catalog-references';
import { preflightRestockRequest } from './restock-request-preflight';

/**
 * HD-R3b3 base spec for the inert RESTOCK request preflight: the default-off
 * legacy path and the enabled positive path, which now includes a FRESH trusted
 * catalog read. It writes nothing and is advisory — the final
 * RestockIntakeService.reserve CAS still decides. Blocking cases live in the
 * adversarial spec.
 */
const SENDER = 'whatsapp:+5215500000001';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const EVENT = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.ABC123',
};
const LATER_EVENT = { ...EVENT, messageId: 'wamid.ABC124' };
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const LATER_SOURCE = 'd9d741a0-898a-5f7b-bbd8-934e95e36420';
/** The MODEL name must never reach the intake; the backend name wins. */
const DIGEST = {
  productId: PRODUCT,
  name: 'Nombre del modelo',
  variantId: VARIANT,
  quantity: 2,
};
const BACKEND_NAME = 'Croquetas premium (backend)';
/** A verified out-of-stock product plus the exact selected variant. */
const STOCK = {
  productId: PRODUCT,
  name: BACKEND_NAME,
  stock: { status: 'out_of_stock', quantity: 0 },
  variants: [
    {
      variantId: VARIANT,
      name: 'Variante',
      option: null,
      value: null,
      stock: { status: 'out_of_stock', quantity: 0 },
    },
  ],
};
const INTAKE = {
  sourceRequestId: SOURCE,
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: BACKEND_NAME,
  variantId: VARIANT,
  sku: null,
  requestedQuantity: null,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
};
const CLEAR = { legacyRequestPending: false, restockIntentPresent: false };

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
function grounded() {
  const session = new CatalogSession(SENDER, 60000, 0);
  session.installSearch(session.beginSearch(), [
    { ...STOCK, name: DIGEST.name },
  ]);
  return session;
}
const ask = (d: ReturnType<typeof deps>, over: Record<string, unknown> = {}) =>
  preflightRestockRequest(
    {
      senderId: SENDER,
      inboundEvent: EVENT,
      digest: DIGEST,
      catalogSession: grounded(),
      restockFeatureEnabled: true,
      ...over,
    },
    d,
  );

describe('preflightRestockRequest', () => {
  it.each([
    { ...DIGEST, productId: '00000000-0000-4000-8000-000000000099' },
    { ...DIGEST, variantId: '00000000-0000-4000-8000-000000000099' },
    { ...DIGEST, name: 'Unobserved model name' },
  ])('rejects ungrounded identity before GET %#', async (digest) => {
    const d = deps();
    await expect(ask(d, { digest })).resolves.toEqual({
      route: 'blocked',
      reason: 'catalog_unverified',
    });
    expect(d.getStock).not.toHaveBeenCalled();
  });

  it('rejects missing, expired and cross-sender sessions before GET', async () => {
    let now = 1;
    const expired = new CatalogSession(SENDER, 0, 0, undefined, [], () => now);
    expired.installSearch(expired.beginSearch(), [
      { ...STOCK, name: DIGEST.name },
    ]);
    const other = new CatalogSession('another', 60000, 0);
    other.installSearch(other.beginSearch(), [{ ...STOCK, name: DIGEST.name }]);
    now = 2;
    for (const catalogSession of [undefined, expired, other]) {
      const d = deps();
      await expect(ask(d, { catalogSession })).resolves.toEqual({
        route: 'blocked',
        reason: 'catalog_unverified',
      });
      expect(d.getStock).not.toHaveBeenCalled();
    }
  });

  it('rejects prototype-forged sessions before GET', async () => {
    const forged = Object.assign(
      Object.create(CatalogSession.prototype) as CatalogSession,
      {
        senderId: SENDER,
        matches: () => true,
      },
    );
    const d = deps();
    await expect(ask(d, { catalogSession: forged })).resolves.toEqual({
      route: 'blocked',
      reason: 'catalog_unverified',
    });
    expect(d.getStock).not.toHaveBeenCalled();
  });
  it('recommends legacy with NO reads whenever the feature is not exactly true', async () => {
    for (const flag of [undefined, false, 'true', 1, null, {}]) {
      const d = deps();
      const outcome = await preflightRestockRequest(
        {
          senderId: SENDER,
          inboundEvent: undefined,
          digest: undefined,
          restockFeatureEnabled: flag,
        },
        d,
      );
      expect(outcome).toEqual({ route: 'legacy' });
      expect(d.readForSender).not.toHaveBeenCalled();
      expect(d.get).not.toHaveBeenCalled();
      expect(d.getStock).not.toHaveBeenCalled();
    }
  });

  it('re-reads the catalog and returns the exact ten-key intake using the backend name', async () => {
    const d = deps();
    const outcome = await ask(d);
    expect(outcome).toEqual({ route: 'restock', intake: INTAKE });
    expect(d.getStock).toHaveBeenCalledWith(PRODUCT);
    expect(d.readForSender).toHaveBeenCalledWith(SENDER);
    expect(d.get).toHaveBeenCalledWith(SENDER);
    expect(Object.keys(INTAKE).sort()).toEqual([
      'observedStockAtRequest',
      'productId',
      'productName',
      'requestedQuantity',
      'sku',
      'sourceRequestId',
      'stockObservedAt',
      'supersedesDecisionId',
      'type',
      'variantId',
    ]);
  });

  it('uses fresh backend name rather than the previously grounded name and ignores supplied sourceRequestId', async () => {
    const d = deps();
    const outcome = await ask(d, {
      digest: {
        productId: PRODUCT,
        name: 'Nombre del modelo',
        sourceRequestId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(outcome).toEqual({
      route: 'restock',
      intake: { ...INTAKE, variantId: null, requestedQuantity: null },
    });
    expect(d.getStock).toHaveBeenCalledWith(PRODUCT);
  });

  it('derives a distinct id for a later customer turn with the same digest', async () => {
    const first = await ask(deps());
    const second = await ask(deps(), { inboundEvent: LATER_EVENT });
    if (first.route !== 'restock' || second.route !== 'restock') {
      throw new Error('expected restock');
    }
    expect(first.intake.sourceRequestId).toBe(SOURCE);
    expect(second.intake.sourceRequestId).toBe(LATER_SOURCE);
    expect(second.intake.productId).toBe(first.intake.productId);
  });
});

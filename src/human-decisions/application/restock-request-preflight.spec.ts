import { preflightRestockRequest } from './restock-request-preflight';

/**
 * HD-R3b3 base spec for the inert RESTOCK request preflight: the default-off
 * legacy path and the enabled positive path. It writes nothing and is advisory —
 * the final RestockIntakeService.reserve CAS still decides. Blocking cases live
 * in the adversarial spec.
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
const DIGEST = {
  productId: PRODUCT,
  name: 'Croquetas premium',
  variantId: VARIANT,
  quantity: 2,
};
const INTAKE = {
  sourceRequestId: SOURCE,
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: 'Croquetas premium',
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
    fail?: 'markers' | 'get';
  } = {},
) => {
  const readForSender = jest.fn().mockResolvedValue(over.markers ?? CLEAR);
  const get = jest.fn().mockResolvedValue(over.state ?? null);
  if (over.fail === 'markers') readForSender.mockRejectedValue(new Error('db'));
  if (over.fail === 'get') get.mockRejectedValue(new Error('db'));
  return {
    conversation: { get },
    markers: { readForSender },
    readForSender,
    get,
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

describe('preflightRestockRequest', () => {
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
    }
  });

  it('returns the exact ten-key intake built from the model digest plus the turn id', async () => {
    const d = deps();
    const outcome = await ask(d);
    expect(outcome).toEqual({ route: 'restock', intake: INTAKE });
    if (outcome.route !== 'restock') throw new Error('expected restock');
    expect(Object.keys(outcome.intake).sort()).toEqual([
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
    expect(d.readForSender).toHaveBeenCalledWith(SENDER);
    expect(d.get).toHaveBeenCalledWith(SENDER);
  });

  it('maps absent optionals to null and ignores a model-provided sourceRequestId', async () => {
    const d = deps();
    const outcome = await ask(d, {
      digest: {
        productId: PRODUCT,
        name: 'Croquetas premium',
        sourceRequestId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(outcome).toEqual({
      route: 'restock',
      intake: { ...INTAKE, variantId: null },
    });
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

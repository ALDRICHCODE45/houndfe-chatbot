import { Logger } from '@nestjs/common';
import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import { deriveExpirationSourceRequestId } from '../../human-decisions/domain/expiration-source-identity';
import {
  MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
  MINIMAL_EXPIRATION_CLARIFY_REPLY,
  MinimalExpirationRequestService,
} from './minimal-expiration-request.service';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VARIANT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const INBOUND = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.E1',
};
const SOURCE = deriveExpirationSourceRequestId(INBOUND) as string;
const VARIANT_ROW = {
  variantId: VARIANT,
  name: 'Caja',
  option: null,
  value: null,
  stock: { status: 'available', quantity: 1 },
};
const stock = (variants: unknown[] = []): StockCheckResponse => ({
  productId: PRODUCT,
  name: 'Ibuprofeno 400 mg',
  stock: { status: 'available', quantity: 5 },
  variants: variants as StockCheckResponse['variants'],
});
const intake = (variantId: string | null) => ({
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId,
});
const UNAVAILABLE = {
  kind: 'unavailable',
  reply: MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
};

function harness(
  over: {
    enabled?: boolean;
    catalog?: StockCheckResponse;
    outcome?: unknown;
  } = {},
) {
  const getStock = jest.fn().mockResolvedValue(over.catalog ?? stock());
  const reserve = jest
    .fn()
    .mockResolvedValue({ action: 'claim', reason: 'single_sender_vacant' });
  const orchestrate = jest.fn().mockResolvedValue(
    over.outcome ?? {
      action: 'receipt_recorded',
      backendDecisionId: '99999999-9999-4999-8999-999999999999',
    },
  );
  const service = new MinimalExpirationRequestService({
    chatbotApi: { getStock },
    reservations: { reserve },
    orchestrator: { orchestrateExpirationPost: orchestrate },
    enabled: over.enabled ?? true,
  });
  return { service, getStock, reserve, orchestrate };
}
const prepare = (
  service: MinimalExpirationRequestService,
  over: Record<string, unknown> = {},
) =>
  service.prepare({
    senderId: SENDER,
    inboundEvent: INBOUND,
    allowedProductIds: new Set([PRODUCT]),
    productId: PRODUCT,
    ...over,
  });

describe('MinimalExpirationRequestService (E1a prerequisite callee)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['validation', 'stock', 'grounding', 'reservation', 'post'] as const)(
    'logs only a fixed stage/reason for %s failure and preserves the reply',
    async (stage) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const h = harness();
      const secret = new Error('private-token customer-phone message-body');
      const input: Record<string, unknown> = {};
      if (stage === 'validation') input.allowedProductIds = new Set();
      if (stage === 'stock') h.getStock.mockRejectedValue(secret);
      if (stage === 'grounding')
        input.inboundEvent = { private: 'message-body' };
      if (stage === 'reservation') h.reserve.mockRejectedValue(secret);
      if (stage === 'post') h.orchestrate.mockRejectedValue(secret);
      await expect(prepare(h.service, input)).resolves.toEqual(UNAVAILABLE);
      const reason =
        stage === 'validation'
          ? 'unknown_product'
          : stage === 'grounding'
            ? 'subject_blocked'
            : 'exception';
      expect(warn.mock.calls).toEqual([
        [`expiration_intake stage=${stage} reason=${reason}`],
      ]);
      if (['validation', 'stock', 'grounding'].includes(stage))
        expect(h.reserve).not.toHaveBeenCalled();
      if (stage !== 'post') expect(h.orchestrate).not.toHaveBeenCalled();
    },
  );

  it('is unavailable when default-off and writes nothing', async () => {
    const h = harness({ enabled: false });
    await expect(prepare(h.service)).resolves.toEqual(UNAVAILABLE);
    expect(h.getStock).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('fences the allowlist before any read and never reserves an unbound identity', async () => {
    const fence = harness();
    await expect(
      prepare(fence.service, { allowedProductIds: new Set([OTHER]) }),
    ).resolves.toEqual(UNAVAILABLE);
    expect(fence.getStock).not.toHaveBeenCalled();
    const unbound = harness();
    await expect(
      prepare(unbound.service, { inboundEvent: { nope: true } }),
    ).resolves.toEqual(UNAVAILABLE);
    expect(unbound.reserve).not.toHaveBeenCalled();
  });

  it('grounds a simple product, reserves the derived source with a null variant and replies the server outcome', async () => {
    const h = harness();
    await expect(prepare(h.service)).resolves.toEqual({
      kind: 'registered',
      reply:
        '¡Listo! 😊 Su consulta ya quedó registrada con el equipo de HoundFe.',
    });
    expect(h.reserve).toHaveBeenCalledWith({
      senderId: SENDER,
      route: 'EXPIRATION',
      requestKey: SOURCE,
      intake: intake(null),
    });
    expect(h.orchestrate).toHaveBeenCalledTimes(1);
  });

  it('clarifies a variant product with no explicit owned variant and never reserves', async () => {
    const h = harness({ catalog: stock([VARIANT_ROW]) });
    await expect(prepare(h.service)).resolves.toEqual({
      kind: 'clarify',
      reply: MINIMAL_EXPIRATION_CLARIFY_REPLY,
    });
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it.each(['receipt_recorded', 'receipt_replayed', 'historical_receipt'])(
    'acknowledges %s neutrally and preserves the owned variant',
    async (action) => {
      const h = harness({ catalog: stock([VARIANT_ROW]), outcome: { action } });
      await expect(prepare(h.service, { variantId: VARIANT })).resolves.toEqual(
        {
          kind: action === 'receipt_recorded' ? 'registered' : 'existing',
          reply:
            action === 'receipt_recorded'
              ? '¡Listo! 😊 Su consulta ya quedó registrada con el equipo de HoundFe.'
              : 'Su consulta ya estaba registrada con el equipo de HoundFe.',
        },
      );
      expect(h.reserve).toHaveBeenCalledWith({
        senderId: SENDER,
        route: 'EXPIRATION',
        requestKey: SOURCE,
        intake: intake(VARIANT),
      });
    },
  );

  it.each([
    [{ action: 'receipt_replayed' }, 'existing'],
    [{ action: 'blocked', reason: 'x' }, 'unavailable'],
  ])('reports a non-recorded outcome truthfully %#', async (outcome, kind) => {
    await expect(prepare(harness({ outcome }).service)).resolves.toMatchObject({
      kind,
    });
  });
});

import { makeCreateSaleTool } from './create-sale.tool';
import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../../conversation/domain/conversation-store';
import type { CartState } from '../../domain/cart-state';
import type { ToolDeps } from '../tool-deps';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type { CreateSaleInput } from '../../../chatbot-api/domain/dtos/sales.dto';
import type { HumanHandoffService } from '../../../human-handoff/application/human-handoff.service';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import { SHIPPING_APPROVAL_KEY } from '../../../human-handoff/application/shipping-approval-persistence';
import {
  SHIPPING_QUOTE_DRAFT_KEY,
  buildShippingQuoteDraftRecord,
} from '../../../shipping/application/shipping-quote-draft-record';
import { SHIPPING_QUOTE_DRAFT_CONTEXT_KEY } from '../../../shipping/application/shipping-quote-draft-context';
import {
  DENIED,
  SALE,
} from '../../../../test/fixtures/shipping-sale-gate-fixture';
import {
  DRAFT,
  ID,
  NOW_ISO,
  NOW_MS,
  PENDING,
  draftRecord,
} from '../../../../test/fixtures/shipping-approval-request-fixture';

// SQ-5E4 E4-2a guarded createSale charge wiring, fully offline.
const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const ADDRESS = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const PRODUCT = '33333333-3333-3333-3333-333333333333';
const SENDER = '525512345678';
const PHONE = '5512345678';
const NOW = NOW_MS + 600_000;
const MERCH = 60_000;
const DEST = {
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
};
const LINE = {
  productId: PRODUCT,
  variantId: null,
  quantity: 1,
  unitPriceCents: MERCH,
};

type Over = Record<string, unknown>;
type SaleInput = Parameters<
  ReturnType<typeof makeCreateSaleTool>['execute']
>[0];
type Options = {
  clock?: () => number;
  lookup?: () => unknown;
  reject?: Error;
  input?: Partial<SaleInput>;
};
type UpdatePatch = Partial<Omit<ConversationState, 'senderId'>>;

const zeroCharge = () =>
  buildShippingQuoteDraftRecord(
    {
      ...DRAFT,
      bestRateCents: 12_000,
      selectedRate: { ...DRAFT.selectedRate, priceCents: 12_000 },
      customerPaysCents: 0,
    },
    NOW_MS,
  )!;
const expired = () => buildShippingQuoteDraftRecord(DRAFT, NOW_MS - 3_600_000)!;
const contexts = (createdAt: string): Over => ({
  schemaVersion: 1,
  draftCreatedAt: createdAt,
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  cart: [LINE],
  destination: DEST,
});
const approval = (decision: string, createdAt: string): Over => ({
  requestId: ID,
  draftCreatedAt: createdAt,
  decision,
  decidedAt: createdAt,
});
const cart = (key: string): Over => ({
  items: [LINE],
  idempotencyKey: key,
  expectedTotalCents: MERCH,
});
const bag = (
  over: Over = {},
  record = draftRecord(),
  decision = 'SHIPPING_APPROVED',
  key = '',
): ConversationStateData => ({
  [SHIPPING_QUOTE_DRAFT_KEY]: record,
  [SHIPPING_QUOTE_DRAFT_CONTEXT_KEY]: contexts(record.createdAt),
  [SHIPPING_APPROVAL_KEY]: approval(decision, record.createdAt),
  cart: cart(key),
  ...over,
});
const lookup = (zipCode = '06700'): Over => ({
  found: true,
  customer: {
    customerId: CUSTOMER,
    firstName: 'Ana',
    phone: PHONE,
    address: { id: ADDRESS, street: 'Calle Falsa 123', ...DEST, zipCode },
  },
});
const input = (over: Partial<SaleInput> = {}): SaleInput => ({
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  items: [{ ...LINE, productName: 'Croquetas' }],
  ...over,
});
const boom = () => {
  throw new Error('hostile clock');
};

function setup(data: unknown, opts: Options = {}) {
  const update = jest.fn(
    async (
      senderId: string,
      patch: UpdatePatch,
    ): Promise<ConversationState> => ({
      senderId,
      lastMessageAt: patch.lastMessageAt ?? NOW_ISO,
      data: patch.data ?? {},
    }),
  );
  const store = {
    get: jest
      .fn()
      .mockResolvedValue({ senderId: SENDER, lastMessageAt: NOW_ISO, data }),
    update,
  } as unknown as ConversationStore;
  const getCustomerByPhone = jest.fn(async () =>
    opts.lookup ? opts.lookup() : lookup(),
  );
  const createSale = jest.fn<Promise<typeof SALE>, [CreateSaleInput, string]>(
    async () => {
      if (opts.reject) throw opts.reject;
      return SALE;
    },
  );
  const deps: ToolDeps = {
    cashierUserId: 'cashier',
    humanHandoffService: {} as unknown as HumanHandoffService,
    chatbotApi: {
      createSale,
      getCustomerByPhone,
    } as unknown as ChatbotApiClient,
    store,
  };
  return {
    tool: makeCreateSaleTool(deps, opts.clock ?? (() => NOW)),
    createSale,
    getCustomerByPhone,
    update,
  };
}
type Harness = ReturnType<typeof setup>;
const run = (h: Harness, modelInput: SaleInput = input()) =>
  h.tool.execute(modelInput, {
    toolCallId: 't',
    messages: [],
    context: { senderId: SENDER },
  });
const expectDenied = async (data: unknown, opts: Options = {}) => {
  const h = setup(data, opts);
  expect(await run(h, input(opts.input))).toEqual(DENIED);
  expect(h.createSale).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
};

describe('makeCreateSaleTool shipping charge (SQ-5E4 E4-2a)', () => {
  it('sends the exact pinned shipping DTO and reuses the existing key', async () => {
    const h = setup(bag({}, draftRecord(), 'SHIPPING_APPROVED', 'pinned-key'));
    const result = await run(
      h,
      input({
        items: [{ ...LINE, productName: 'Croquetas', unitPriceCents: 59_999 }],
      }),
    );
    expect(result).toEqual({ ok: true, ...SALE });
    expect(h.getCustomerByPhone).toHaveBeenCalledWith('52', PHONE);
    expect(h.update).toHaveBeenCalledTimes(1);
    const [dto, key] = h.createSale.mock.calls[0];
    expect(key).toBe('pinned-key');
    expect(dto).toMatchObject({
      customerId: CUSTOMER,
      shippingAddressId: ADDRESS,
      shipping: { chargeCents: 6_900, approvalId: ID, quoteId: 'q1' },
      expectedTotalCents: MERCH + 6_900,
    });
    expect(dto.items[0].unitPriceCents).toBe(MERCH);
    expect(dto.items[0].variantId).toBeNull();
    expect(JSON.stringify(dto)).not.toContain('59999');
  });

  it.each<[string, ConversationStateData, Options?]>([
    ['an invalid approval', bag({ [SHIPPING_APPROVAL_KEY]: null }), {}],
    ['a rejected approval', bag({}, draftRecord(), 'SHIPPING_REJECTED'), {}],
    ['an expired draft', bag({}, expired()), {}],
    ['a zero charge', bag({}, zeroCharge()), {}],
    ['a pending handoff', bag({ pendingHumanRequest: PENDING }), {}],
    ['model customer drift', bag(), { input: { customerId: OTHER } }],
    ['model address drift', bag(), { input: { shippingAddressId: OTHER } }],
    ['a hostile clock', bag(), { clock: boom }],
    ['destination drift', bag(), { lookup: () => lookup('06701') }],
  ])('fails closed with zero store/sale for %s', async (_l, data, opts) => {
    await expectDenied(data, opts);
  });

  it('fails closed before lookup/key/store for a pinned total above int32', async () => {
    const h = setup(
      bag({
        cart: {
          items: [LINE],
          idempotencyKey: '',
          expectedTotalCents: 2_147_483_648 - 6_900,
        },
      }),
    );
    expect(await run(h)).toEqual(DENIED);
    expect(h.getCustomerByPhone).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.createSale).not.toHaveBeenCalled();
  });

  it('leaves an ordinary address-only sale unchanged', async () => {
    const h = setup({ cart: cart('k') });
    expect(await run(h)).toEqual({ ok: true, ...SALE });
    expect(h.getCustomerByPhone).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
    const [dto] = h.createSale.mock.calls[0];
    expect(dto.shippingAddressId).toBe(ADDRESS);
    expect(dto.shipping).toBeUndefined();
    expect(dto.expectedTotalCents).toBe(MERCH);
  });

  it('never persists the freight-inclusive recomputed total on a charged PROMO_RE_QUOTE', async () => {
    const promo = new UpstreamError(
      'Price changed',
      409,
      {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 65_000,
        expectedTotalCents: MERCH + 6_900,
        discountCents: 1_900,
      },
      'PROMO_RE_QUOTE',
    );
    const h = setup(bag({}, draftRecord(), 'SHIPPING_APPROVED', 'pre-key'), {
      reject: promo,
    });
    const result = await run(h);
    expect(result).toEqual(DENIED);
    expect(h.update).toHaveBeenCalledTimes(1);
    const patch = h.update.mock.calls[0][1];
    const persisted = patch.data?.cart as CartState;
    expect(persisted.expectedTotalCents).toBe(MERCH);
    expect(persisted.idempotencyKey).toBe('');
    expect(JSON.stringify(result)).not.toContain('65000');
  });
});

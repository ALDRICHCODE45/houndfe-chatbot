/**
 * Shared offline builders for the SQ-5D2 shipping-sale marker-gate tool specs.
 *
 * Test-only: every seam is injected, so no live store, network, or clock runs.
 * The constants and the `createSale` harness live here so the gate spec and the
 * tool spec assert the same shapes without duplicating ~100 setup lines.
 */
import { makeCreateSaleTool } from '../../src/sale-flow/application/tools/create-sale.tool';
import type { ToolDeps } from '../../src/sale-flow/application/tool-deps';
import type { ChatbotApiClient } from '../../src/chatbot-api/domain/chatbot-api.client';
import type { BotSaleResponse } from '../../src/chatbot-api/domain/dtos/sales.dto';
import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../src/conversation/domain/conversation-store';
import { SHIPPING_APPROVAL_KEY } from '../../src/human-handoff/application/shipping-approval-persistence';
import { SHIPPING_QUOTE_DRAFT_KEY } from '../../src/shipping/application/shipping-quote-draft-record';

export const LAST_MESSAGE_AT = '2026-06-23T12:00:00.000Z';

export const NON_EMPTY_CART = {
  items: [
    {
      productId: '00000000-4000-9000-0000-000000000001',
      quantity: 1,
      unitPriceCents: 1000,
    },
  ],
  idempotencyKey: '',
};

export const MODEL_INPUT = {
  customerId: '00000000-4000-9000-0000-000000000099',
  items: [
    {
      productId: '00000000-4000-9000-0000-000000000001',
      productName: 'Croquetas',
      quantity: 1,
      unitPriceCents: 1000,
    },
  ],
};

export const SALE: BotSaleResponse = {
  saleId: 'sale-1',
  folio: null,
  paymentStatus: 'CREDIT',
  channel: 'ONLINE',
  deliveryStatus: 'PENDING',
  totalCents: 1000,
  paidCents: 0,
  debtCents: 1000,
  confirmedAt: null,
  discountCents: 0,
};

/** Exact finite nonretryable envelope the gate denies with. */
export const DENIED = {
  ok: false,
  error: { kind: 'shippingUnpersistable', retryable: false },
};

/** Clean data bag with an already-minted key (so a bypass cannot hide behind a
 *  key mint write). */
export const cleanCart = () => ({
  cart: { ...NON_EMPTY_CART, idempotencyKey: 'existing-key' },
});

export type GateInput = typeof MODEL_INPUT & {
  shippingAddressId?: string | null;
};

export const approval = (decision: string) => ({
  requestId: 'abcdef123456',
  draftCreatedAt: LAST_MESSAGE_AT,
  decision,
  decidedAt: LAST_MESSAGE_AT,
});

export const markerCase = (
  label: string,
  key: string,
  value: unknown,
): { label: string; data: () => ConversationState['data'] } => ({
  label,
  data: () => ({ cart: NON_EMPTY_CART, [key]: value }),
});

export const blockedCases = [
  markerCase('an in-date quote draft', SHIPPING_QUOTE_DRAFT_KEY, {
    schemaVersion: 1,
    quoteId: 'q1',
  }),
  markerCase(
    'an approved shipping decision',
    SHIPPING_APPROVAL_KEY,
    approval('SHIPPING_APPROVED'),
  ),
  markerCase(
    'a rejected shipping decision',
    SHIPPING_APPROVAL_KEY,
    approval('SHIPPING_REJECTED'),
  ),
  markerCase('an expired quote draft', SHIPPING_QUOTE_DRAFT_KEY, {
    schemaVersion: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-01T00:30:00.000Z',
  }),
];

/**
 * Identical setup + run shared by every gate test. `state` is handed to the
 * mocked store verbatim (it may be `null` or a hostile object); the caller
 * keeps its own assertions on the envelope, the backend call, and the writes.
 */
export function executeGateTool(
  deps: Omit<ToolDeps, 'chatbotApi' | 'store'>,
  state: ConversationState | null,
  input: GateInput = MODEL_INPUT,
) {
  const update = jest.fn();
  const store = {
    get: jest.fn().mockResolvedValue(state),
    update,
  } as unknown as ConversationStore;
  const createSale = jest.fn().mockResolvedValue(SALE);
  const tool = makeCreateSaleTool({
    ...deps,
    chatbotApi: { createSale } as unknown as ChatbotApiClient,
    store,
  });
  const result = tool.execute(input, {
    toolCallId: 't',
    messages: [],
    context: { senderId: 's' },
  });
  return { result, createSale, update };
}

export const executeGateWithData = (
  deps: Omit<ToolDeps, 'chatbotApi' | 'store'>,
  data: ConversationState['data'],
  input: GateInput = MODEL_INPUT,
) =>
  executeGateTool(
    deps,
    { senderId: 's', lastMessageAt: LAST_MESSAGE_AT, data },
    input,
  );

const markedBag = () => ({
  ...cleanCart(),
  [SHIPPING_QUOTE_DRAFT_KEY]: { schemaVersion: 1, quoteId: 'q1' },
});

/** State with an own `data` accessor (never a plain data property). */
export function stateWithDataAccessor(get: () => unknown): ConversationState {
  const state = {
    senderId: 's',
    lastMessageAt: LAST_MESSAGE_AT,
  } as unknown as ConversationState;
  Object.defineProperty(state, 'data', {
    enumerable: true,
    configurable: true,
    get,
  });
  return state;
}

/** Data bag with an own accessor marker plus a non-empty cart. */
export function dataWithAccessor(
  key: string,
  get: () => unknown,
): ConversationStateData {
  const data: Record<string, unknown> = { cart: NON_EMPTY_CART };
  Object.defineProperty(data, key, {
    enumerable: true,
    configurable: true,
    get,
  });
  return data;
}

/** `data` accessor answering the clean bag first and the marked bag later. */
export function statefulAccessorState(): {
  state: ConversationState;
  dataReads: () => number;
} {
  let reads = 0;
  const clean = cleanCart();
  const marked = markedBag();
  const state = stateWithDataAccessor(() => (reads++ === 0 ? clean : marked));
  return { state, dataReads: () => reads };
}

/**
 * Hostile state whose `data` DESCRIPTOR reports the clean bag while a plain
 * `get('data')` supplies the shipping-marked one. The pre-correction gate read
 * only the descriptor, so this state passed the gate and the later
 * `readCart` / persistence spread consumed the marked bag.
 */
export function divergentDataProxyState(): ConversationState {
  const clean = cleanCart();
  const marked = markedBag();
  return new Proxy(
    { senderId: 's', lastMessageAt: LAST_MESSAGE_AT, data: clean },
    {
      getOwnPropertyDescriptor: (target, key) =>
        key === 'data'
          ? {
              value: clean,
              writable: true,
              enumerable: true,
              configurable: true,
            }
          : Reflect.getOwnPropertyDescriptor(target, key),
      get: (target, key, receiver): unknown =>
        key === 'data'
          ? marked
          : (Reflect.get(target, key, receiver) as unknown),
    },
  );
}

/**
 * Hostile state whose `get('data')` is clean on the first read and
 * shipping-marked afterwards. Pinning one validated snapshot means the marked
 * bag is never read; the pre-correction tool read `state.data` again in
 * `readCart` / the persistence spread and persisted the marker.
 */
export function statefulDataProxyState(): {
  state: ConversationState;
  dataReads: () => number;
} {
  let reads = 0;
  const clean = cleanCart();
  const marked = markedBag();
  const state = new Proxy(
    { senderId: 's', lastMessageAt: LAST_MESSAGE_AT, data: clean },
    {
      get: (target, key, receiver): unknown =>
        key === 'data'
          ? reads++ === 0
            ? clean
            : marked
          : (Reflect.get(target, key, receiver) as unknown),
    },
  );
  return { state, dataReads: () => reads };
}

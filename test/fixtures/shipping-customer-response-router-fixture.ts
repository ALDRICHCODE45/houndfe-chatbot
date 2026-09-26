/**
 * SCA-4b0 test-only fixture: plain builders and constants for the committed
 * marker/disclosure shapes. Pure data only — it imports NO production router,
 * store, sender or provider, so its commit and its spec stand independently of
 * the SCA-4b1 router. The router-bound fake seam lives in the sibling harness.
 */
import type {
  AgentMessage,
  ConversationState,
  ConversationStateData,
  ReceiptAmountPointer,
} from '../../src/conversation/domain/conversation-store';
import {
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY,
} from '../../src/shipping/application/shipping-customer-acceptance';
import { SHIPPING_CUSTOMER_DECLINE_RECEIPT_KEY } from '../../src/shipping/application/shipping-customer-response';

export const DRAFT = 'shippingQuoteDraft';
export const CONTEXT = 'shippingQuoteDraftContext';
export const APPROVAL = 'shippingApproval';
export const OFFER_KEY = SHIPPING_CUSTOMER_OFFER_KEY;
export const ACCEPT_KEY = SHIPPING_CUSTOMER_ACCEPTANCE_KEY;
export const RECEIPT_KEY = SHIPPING_CUSTOMER_DECLINE_RECEIPT_KEY;
export const PIN = '2026-06-23T12:00:00.000Z';
export const DECIDED = '2026-06-23T12:05:00.000Z';
export const OFFERED = '2026-06-23T12:06:00.000Z';
export const EXPIRES = '2026-06-23T12:30:00.000Z';
export const NOW = '2026-06-23T12:10:00.000Z';
export const YES = '2026-06-23T12:07:00.000Z';
export const REQ = 'abcdef123456';
export const OTHER_REQ = 'fedcba654321';
export const SENDER = '5215500000000';
export const OUT_ID = 'wamid.HBgLoutbound=';
export const IN_ID = 'wamid.HBgLinbound=';
export const REPLAY_ID = 'wamid.HBgLreplay=';
export const MERCH = 60_000;
export const CHARGE = 6_900;
export const TOTAL = MERCH + CHARGE;
const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const ADDRESS = '22222222-2222-2222-2222-222222222222';
const PRODUCT = '33333333-3333-3333-3333-333333333333';

export type Obj = Record<string, unknown>;
export type Patch = Partial<Omit<ConversationState, 'senderId'>>;

const line = (unit = MERCH) => ({
  productId: PRODUCT,
  variantId: null,
  quantity: 1,
  unitPriceCents: unit,
});
export const draft = () => ({
  schemaVersion: 1,
  draft: {
    quoteId: 'q',
    selectedRate: {
      rateId: 'r',
      carrierName: 'Skydropx',
      serviceName: 'Express',
      priceCents: CHARGE + 12_000,
      currency: 'MXN',
      estimatedDeliveryDays: 3,
      validUntil: null,
    },
    providerExpiresAt: null,
    bestRateCents: CHARGE + 12_000,
    totalCreditCents: 12_000,
    appliedCreditCents: 12_000,
    unusedCreditCents: 0,
    qualifyingUnitCount: 1,
    customerPaysCents: CHARGE,
  },
  createdAt: PIN,
  expiresAt: EXPIRES,
});
export const context = (unit = MERCH) => ({
  schemaVersion: 1,
  draftCreatedAt: PIN,
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  cart: [line(unit)],
  destination: {
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  },
});
export const approval = () => ({
  requestId: REQ,
  draftCreatedAt: PIN,
  decision: 'SHIPPING_APPROVED',
  decidedAt: DECIDED,
});
export const cart = (unit = MERCH) => ({
  items: [line(unit)],
  idempotencyKey: 'key-1',
  expectedTotalCents: unit,
});
export const offer = (over: Obj = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: PIN,
  offeredAt: OFFERED,
  expiresAt: EXPIRES,
  merchandiseCents: MERCH,
  chargeCents: CHARGE,
  expectedTotalCents: TOTAL,
  providerMessageId: OUT_ID,
  ...over,
});
export const acceptance = (over: Obj = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: PIN,
  merchandiseCents: MERCH,
  chargeCents: CHARGE,
  expectedTotalCents: TOTAL,
  acceptedAt: YES,
  inboundMessageId: IN_ID,
  ...over,
});
export const receipt = (over: Obj = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: PIN,
  inboundMessageId: IN_ID,
  declinedAt: YES,
  ...over,
});
const MESSAGES: AgentMessage[] = [{ role: 'user', content: 'hola' }];
/** Explicit valid receipt amount pointer. `base()` intentionally omits it so an
 *  active shipping offer alone never trips the SCA-4c two-flow collision guard;
 *  collision tests opt in by spreading this builder. */
export const RECEIPT_POINTER: ReceiptAmountPointer = {
  receiptMediaId: 'm1',
  saleId: 's1',
  receiptVersion: '1',
};
/** Sibling keys preserved across writes; no receipt flow by default. */
export const SIBLINGS = {
  messages: MESSAGES,
  keepMe: { untouched: true },
};
export const base = (over: Obj = {}): ConversationStateData => ({
  [DRAFT]: draft(),
  [CONTEXT]: context(),
  [APPROVAL]: approval(),
  cart: cart(),
  [OFFER_KEY]: offer(),
  ...SIBLINGS,
  ...over,
});
export const stateOf = (data: ConversationStateData): ConversationState => ({
  senderId: SENDER,
  lastMessageAt: PIN,
  data,
});
export const PENDING = {
  requestId: REQ,
  ref: `HF-${REQ}`,
  createdAt: DECIDED,
  customerNotifiedAt: DECIDED,
};
export const input = (over: Obj = {}) => ({
  senderId: SENDER,
  text: 'SÍ',
  sourceWebhookMessageId: IN_ID,
  inboundTimestamp: YES,
  ...over,
});

/**
 * SCA-4c3: pure offline contract that lets a future dedicated human-handoff
 * flow claim a pinned identity for the shipping/receipt two-flow collision, and
 * parse an agent ops cancel command. Detection re-derives the shipping offer
 * through the committed SCA-1a1 normalizer and copies a structurally valid
 * `receiptAmountPointer`; a malformed/absent offer or pointer yields `null`, so
 * this pure helper never claims an identity the router/sale gate must keep
 * blocking. The ops parser accepts ONLY the exact `HF-<12-lowercase-hex-id>:
 * CANCEL_SHIPPING|CANCEL_RECEIPT` grammar for the exact expected request id.
 * No model text authorizes ops; no store, I/O, messaging, provider or LLM.
 * Both helpers are total: hostile input fails closed with `null`, never throws.
 */
import { type ReceiptAmountPointer } from '../../conversation/domain/conversation-store';
import {
  normalizeShippingCustomerOffer,
  SHIPPING_CUSTOMER_OFFER_KEY,
  type ShippingCustomerOffer,
} from '../../shipping/application/shipping-customer-acceptance';

export interface ShippingReceiptCollision {
  readonly offer: ShippingCustomerOffer;
  readonly receiptPointer: ReceiptAmountPointer;
}

export type ShippingReceiptOpsDecision = 'CANCEL_SHIPPING' | 'CANCEL_RECEIPT';

const REQUEST_ID = /^[0-9a-f]{12}$/;
const OUTER_SPACING = /^[ \t]+|[ \t]+$/g;
const NEWLINES = /[\r\n]/;
// Exact grammar: lowercase `hf` prefix (uppercase `HF`), 12 lowercase hex,
// literal `: `, uppercase command. Anchored so prose, multiple refs and
// trailing punctuation are all rejected.
const OPS_COMMAND = /^HF-([0-9a-f]{12}): (CANCEL_SHIPPING|CANCEL_RECEIPT)$/;

const POINTER_KEYS = ['receiptMediaId', 'saleId', 'receiptVersion'] as const;

/** Data-only snapshot: rejects arrays, exotic prototypes, symbols, excess or
 *  missing keys and accessor properties, reading each own descriptor exactly
 *  once so a mutating getter can never validate as one value and copy as
 *  another. */
// prettier-ignore
function snapshotReceiptAmountPointer(raw: unknown): ReceiptAmountPointer | null {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const proto: unknown = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
    if (Object.getOwnPropertyNames(raw).length !== POINTER_KEYS.length) return null;
    const [mediaId, saleId, version] = POINTER_KEYS.map((k) => {
      const d = Object.getOwnPropertyDescriptor(raw, k);
      return d !== undefined && d.enumerable && 'value' in d ? (d.value as unknown) : undefined;
    });
    if (typeof mediaId !== 'string' || mediaId.length === 0 || typeof saleId !== 'string' || saleId.length === 0 || typeof version !== 'string' || !/^[1-9]\d*$/.test(version)) return null;
    return Object.freeze({ receiptMediaId: mediaId, saleId, receiptVersion: version });
  } catch {
    return null;
  }
}

/**
 * Claim the collision identity ONLY when `data` carries a valid
 * `shippingCustomerOffer` marker AND a structurally valid
 * `receiptAmountPointer`. Both are re-derived server-side; a malformed or
 * absent offer, an invalid pointer, or hostile/non-object state all return
 * `null` (the router and sale gate keep independently blocking).
 */
export function detectShippingReceiptCollision(
  data: unknown,
): ShippingReceiptCollision | null {
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return null;
    }
    const bag = data as Record<string, unknown>;
    const offer = normalizeShippingCustomerOffer(
      bag[SHIPPING_CUSTOMER_OFFER_KEY],
    );
    if (offer === null) return null;
    const receiptPointer = snapshotReceiptAmountPointer(
      bag.receiptAmountPointer,
    );
    if (receiptPointer === null) return null;
    return Object.freeze({ offer, receiptPointer });
  } catch {
    return null;
  }
}

/**
 * Parse an agent ops cancel command for exactly `expectedRequestId`. Accepts
 * only `HF-<id>: CANCEL_SHIPPING` or `HF-<id>: CANCEL_RECEIPT`, allowing outer
 * spaces/tabs (repo-established policy) but never newlines. The embedded id
 * must equal the expected request id; case is exact; there is no tokenless,
 * latest-pending, prose or model-text fallback. Anything else returns `null`.
 */
export function parseShippingReceiptOpsDecision(
  text: unknown,
  expectedRequestId: unknown,
): ShippingReceiptOpsDecision | null {
  try {
    if (typeof text !== 'string' || NEWLINES.test(text)) return null;
    if (
      typeof expectedRequestId !== 'string' ||
      !REQUEST_ID.test(expectedRequestId)
    ) {
      return null;
    }
    const match = OPS_COMMAND.exec(text.replace(OUTER_SPACING, ''));
    if (match === null || match[1] !== expectedRequestId) return null;
    return match[2] as ShippingReceiptOpsDecision;
  } catch {
    return null;
  }
}

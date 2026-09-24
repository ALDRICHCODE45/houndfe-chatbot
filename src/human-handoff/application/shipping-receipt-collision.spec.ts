// prettier-ignore
import type { ReceiptAmountPointer } from '../../conversation/domain/conversation-store';
// prettier-ignore
import { normalizeShippingCustomerOffer, SHIPPING_CUSTOMER_OFFER_KEY as OFFER_KEY } from '../../shipping/application/shipping-customer-acceptance';
// prettier-ignore
import { detectShippingReceiptCollision, parseShippingReceiptOpsDecision, type ShippingReceiptOpsDecision } from './shipping-receipt-collision';

/** SCA-4c3 pure offline contract: a two-flow collision is claimed ONLY from a
 *  valid shipping offer marker PLUS a structurally valid receipt pointer, both
 *  re-derived server-side; and an ops cancel command is parsed only from the
 *  exact `HF-<id>: CANCEL_*` grammar. No store, I/O, messaging or model prose. */

const OFFER = {
  schemaVersion: 1,
  requestId: 'abcdef123456',
  draftCreatedAt: '2026-06-23T12:00:00.000Z',
  offeredAt: '2026-06-23T12:06:00.000Z',
  expiresAt: '2026-06-23T12:30:00.000Z',
  merchandiseCents: 60_000,
  chargeCents: 6_900,
  expectedTotalCents: 66_900,
  providerMessageId: 'wamid.HBgLc2NhLW9mZmVyPQ==',
};
const POINTER: ReceiptAmountPointer = {
  receiptMediaId: '11111111-2222-4333-8444-555555555555',
  saleId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  receiptVersion: '7',
};
const REF = 'HF-abcdef123456';
const boom = (): never => {
  throw new Error('hostile get');
};
// prettier-ignore
const revoked = (): unknown => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
const pair = (offer: unknown, pointer: unknown) => ({
  [OFFER_KEY]: offer,
  receiptAmountPointer: pointer,
});

describe('detectShippingReceiptCollision', () => {
  it('claims a frozen collision only for a valid offer plus valid pointer', () => {
    const result = detectShippingReceiptCollision(pair(OFFER, POINTER));
    expect(result).not.toBeNull();
    expect(result?.offer).toEqual(normalizeShippingCustomerOffer(OFFER));
    expect(result?.receiptPointer).toEqual(POINTER);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.offer)).toBe(true);
    expect(Object.isFrozen(result?.receiptPointer)).toBe(true);
    expect(Object.keys(result?.receiptPointer ?? {})).toHaveLength(3);
    // copied, not aliased: a later mutation of the source never mutates output
    (POINTER as { saleId: string }).saleId = 'mutated';
    expect(result?.receiptPointer.saleId).not.toBe('mutated');
  });

  it('returns null when the offer marker is absent', () => {
    expect(detectShippingReceiptCollision(pair(undefined, POINTER))).toBeNull();
    expect(detectShippingReceiptCollision(pair(null, POINTER))).toBeNull();
    expect(
      detectShippingReceiptCollision({ receiptAmountPointer: POINTER }),
    ).toBeNull();
  });

  it.each<[string, unknown]>([
    ['extra key', { ...OFFER, priceCents: 1 }],
    ['missing offeredAt', { ...OFFER, offeredAt: undefined }],
    ['uppercase id', { ...OFFER, requestId: 'ABCDEF123456' }],
    ['nonhex id', { ...OFFER, requestId: 'abcdef12345g' }],
    ['noncanonical iso', { ...OFFER, draftCreatedAt: '2026-06-23T12:00:00Z' }],
    ['negative amount', { ...OFFER, merchandiseCents: -1 }],
    ['amount drift', { ...OFFER, expectedTotalCents: 66_901 }],
    ['string raw', 'offer'],
    ['array raw', [OFFER]],
  ])('returns null for a malformed offer (%s)', (_label, offer) => {
    expect(detectShippingReceiptCollision(pair(offer, POINTER))).toBeNull();
  });

  it.each<[string, unknown]>([
    [
      'missing key',
      { receiptMediaId: POINTER.receiptMediaId, saleId: POINTER.saleId },
    ],
    ['extra key', { ...POINTER, note: 'x' }],
    ['empty saleId', { ...POINTER, saleId: '' }],
    ['non-string media', { ...POINTER, receiptMediaId: 7 }],
    ['zero version', { ...POINTER, receiptVersion: '0' }],
    ['non-numeric version', { ...POINTER, receiptVersion: '1a' }],
    ['string raw', 'pointer'],
    ['null raw', null],
  ])('returns null for an invalid pointer (%s)', (_label, pointer) => {
    expect(detectShippingReceiptCollision(pair(OFFER, pointer))).toBeNull();
  });

  it('rejects a pointer whose getter mutates between validate and copy', () => {
    const pointer: Record<string, unknown> = {
      saleId: 'sale',
      receiptVersion: '1',
    };
    let reads = 0;
    Object.defineProperty(pointer, 'receiptMediaId', {
      enumerable: true,
      configurable: true,
      get: () => (++reads <= 2 ? 'media' : 7),
    });
    expect(detectShippingReceiptCollision(pair(OFFER, pointer))).toBeNull();
  });

  it('fails closed on hostile state without throwing', () => {
    // prettier-ignore
    const hostile = [null, undefined, 'x', [pair(OFFER, POINTER)], revoked(), new Proxy({}, { get: boom }), { get [OFFER_KEY]() { return boom(); } }, { [OFFER_KEY]: OFFER, get receiptAmountPointer() { return boom(); } }];
    for (const value of hostile)
      expect(detectShippingReceiptCollision(value)).toBeNull();
  });
});

describe('parseShippingReceiptOpsDecision', () => {
  it('returns only the two finite cancel decisions', () => {
    const shipping: ShippingReceiptOpsDecision = 'CANCEL_SHIPPING';
    const receipt: ShippingReceiptOpsDecision = 'CANCEL_RECEIPT';
    expect([shipping, receipt]).toHaveLength(2);
    expect(
      parseShippingReceiptOpsDecision(
        `${REF}: CANCEL_SHIPPING`,
        'abcdef123456',
      ),
    ).toBe('CANCEL_SHIPPING');
    expect(
      parseShippingReceiptOpsDecision(`${REF}: CANCEL_RECEIPT`, 'abcdef123456'),
    ).toBe('CANCEL_RECEIPT');
  });

  it('allows outer spaces/tabs only, never newlines', () => {
    expect(
      parseShippingReceiptOpsDecision(
        `  \t${REF}: CANCEL_RECEIPT\t `,
        'abcdef123456',
      ),
    ).toBe('CANCEL_RECEIPT');
    expect(
      parseShippingReceiptOpsDecision(
        `\n${REF}: CANCEL_RECEIPT`,
        'abcdef123456',
      ),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(
        `${REF}: CANCEL_RECEIPT\n`,
        'abcdef123456',
      ),
    ).toBeNull();
  });

  it('requires the exact case for the prefix, id and command', () => {
    expect(
      parseShippingReceiptOpsDecision(
        `hf-abcdef123456: CANCEL_RECEIPT`,
        'abcdef123456',
      ),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(
        `HF-ABCDEF123456: CANCEL_RECEIPT`,
        'abcdef123456',
      ),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(`${REF}: cancel_receipt`, 'abcdef123456'),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(`${REF}: Cancel_Receipt`, 'abcdef123456'),
    ).toBeNull();
  });

  it('rejects a wrong, missing or malformed requestId', () => {
    expect(
      parseShippingReceiptOpsDecision(
        `${REF}: CANCEL_SHIPPING`,
        'aaaaaaaaaaaa',
      ),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(
        'HF-aaaaaaaaaaaa: CANCEL_SHIPPING',
        'abcdef123456',
      ),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(
        `${REF}: CANCEL_SHIPPING`,
        'ABCDEF123456',
      ),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(`${REF}: CANCEL_SHIPPING`, 'abcdef12345'),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(
        `${REF}: CANCEL_SHIPPING`,
        'abcdef12345g',
      ),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(`${REF}: CANCEL_SHIPPING`, null),
    ).toBeNull();
    expect(
      parseShippingReceiptOpsDecision(`${REF}: CANCEL_SHIPPING`, 123456789012),
    ).toBeNull();
  });

  it.each<[string, string]>([
    ['tokenless command', 'CANCEL_SHIPPING'],
    ['missing id', 'HF-: CANCEL_SHIPPING'],
    ['missing colon space', 'HF-abcdef123456:CANCEL_SHIPPING'],
    ['double inner space', 'HF-abcdef123456:  CANCEL_SHIPPING'],
    ['lowercase command suffix', 'HF-abcdef123456: CANCEL_shipping'],
    ['unknown command', 'HF-abcdef123456: CANCEL_ORDER'],
    ['prose prefix', 'Please HF-abcdef123456: CANCEL_SHIPPING'],
    ['prose suffix', 'HF-abcdef123456: CANCEL_SHIPPING now'],
    [
      'two refs',
      'HF-abcdef123456: CANCEL_SHIPPING HF-abcdef123456: CANCEL_RECEIPT',
    ],
    ['embedded ref', 'x HF-abcdef123456: CANCEL_RECEIPT x'],
    ['trailing period', 'HF-abcdef123456: CANCEL_RECEIPT.'],
    ['empty', ''],
    ['spaces only', '   '],
    ['model prose', 'He decidido cancelar el envío'],
  ])('rejects non-exact text (%s)', (_label, text) => {
    expect(parseShippingReceiptOpsDecision(text, 'abcdef123456')).toBeNull();
  });

  it('fails closed on hostile/non-string input without throwing', () => {
    // prettier-ignore
    const hostile = [null, undefined, 42, [`${REF}: CANCEL_RECEIPT`], new Proxy({}, { get: boom }), revoked(), { get toString() { return boom(); } }];
    for (const value of hostile)
      expect(parseShippingReceiptOpsDecision(value, 'abcdef123456')).toBeNull();
  });
});

/**
 * SCA-4b0: fixture self-contract. Proves the shared test builders emit the exact
 * committed marker/disclosure shapes and that the fixture imports no router,
 * store, sender or provider. Runs standalone, without the SCA-4b1 router.
 */
import {
  normalizeShippingCustomerAcceptance,
  normalizeShippingCustomerOffer,
} from './shipping-customer-acceptance';
import { normalizeShippingCustomerDeclineReceipt } from './shipping-customer-response';
import {
  ACCEPT_KEY,
  OFFER_KEY,
  OFFERED,
  PIN,
  RECEIPT_KEY,
  REQ,
  TOTAL,
  acceptance,
  base,
  offer,
  receipt,
} from '../../../test/fixtures/shipping-customer-response-router-fixture';

describe('shipping-customer-response-router fixture (b0)', () => {
  it('emits committed norm-valid markers with the pinned amounts', () => {
    expect(normalizeShippingCustomerOffer(offer())).toMatchObject({
      requestId: REQ,
      draftCreatedAt: PIN,
      offeredAt: OFFERED,
      expectedTotalCents: TOTAL,
    });
    expect(normalizeShippingCustomerAcceptance(acceptance())).not.toBeNull();
    expect(normalizeShippingCustomerDeclineReceipt(receipt())).not.toBeNull();
  });

  it('exposes a disclosure-ready base carrying the offer and siblings', () => {
    const data = base();
    expect(data[OFFER_KEY]).toEqual(offer());
    expect(data).not.toHaveProperty(ACCEPT_KEY);
    expect(data).not.toHaveProperty(RECEIPT_KEY);
    expect(data.receiptAmountPointer).toBeDefined();
    expect(Array.isArray(data.messages)).toBe(true);
  });
});

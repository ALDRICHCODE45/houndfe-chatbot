import type { ConversationState } from '../../conversation/domain/conversation-store';
import { readPlacedOrder } from './placed-order';

const SALE = '55555555-5555-4555-8555-555555555555';
const state = (placedSale: unknown): ConversationState =>
  ({
    data: { minimalCart: { items: [], idempotencyKey: '', placedSale } },
  }) as unknown as ConversationState;

describe('readPlacedOrder (S7 compatibility)', () => {
  it('reads a placedSale written before the payment-pending marker', () => {
    expect(
      readPlacedOrder(
        state({ saleId: SALE, folio: 'B-0042', totalCents: 3000 }),
      ),
    ).toEqual({ saleId: SALE, folio: 'B-0042', totalCents: 3000 });
  });

  it('follow-ups S7: flags a pay-in-store hold (the tap recorded pickup.held)', () => {
    const base = { saleId: SALE, folio: 'B-0042', totalCents: 3000 };
    const pickup = {
      checkoutKey: '66666666-6666-4666-8666-666666666666',
      location: null,
    };
    expect(
      readPlacedOrder(state({ ...base, pickup: { ...pickup, held: true } })),
    ).toEqual({ ...base, payInStoreHold: true });
    // A pickup order the customer never held, or a malformed flag: no hold.
    expect(readPlacedOrder(state({ ...base, pickup }))).toEqual(base);
    expect(
      readPlacedOrder(state({ ...base, pickup: { ...pickup, held: 'yes' } })),
    ).toEqual(base);
  });

  it('is unaffected by the payment-pending marker', () => {
    expect(
      readPlacedOrder(
        state({
          saleId: SALE,
          folio: 'B-0042',
          totalCents: 3000,
          paymentPending: true,
        }),
      ),
    ).toEqual({ saleId: SALE, folio: 'B-0042', totalCents: 3000 });
  });
});

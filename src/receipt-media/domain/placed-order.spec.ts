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

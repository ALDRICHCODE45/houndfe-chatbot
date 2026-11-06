import { parseReceiptOutcome } from './receipt-outcome.dto';

const sale = { debtCents: 0, paymentStatus: 'PAID' };

describe('parseReceiptOutcome', () => {
  it.each(['PENDING', 'CONFIRMED'])('parses %s without a reason', (status) => {
    expect(parseReceiptOutcome({ status, sale })).toEqual({
      status,
      customerReason: null,
      sale,
    });
  });

  it('parses REJECTED with and without a customer reason', () => {
    expect(
      parseReceiptOutcome({
        status: 'REJECTED',
        customerReason: 'El monto no coincide',
        sale: { debtCents: 150000, paymentStatus: 'CREDIT' },
      }),
    ).toEqual({
      status: 'REJECTED',
      customerReason: 'El monto no coincide',
      sale: { debtCents: 150000, paymentStatus: 'CREDIT' },
    });
    expect(
      parseReceiptOutcome({ status: 'REJECTED', customerReason: null, sale }),
    ).toMatchObject({ status: 'REJECTED', customerReason: null });
  });

  it.each([
    ['not an object', 'CONFIRMED'],
    ['an array', []],
    ['unknown status', { status: 'APPROVED', sale }],
    ['missing sale', { status: 'PENDING' }],
    [
      'a reason outside REJECTED',
      { status: 'CONFIRMED', customerReason: 'x', sale },
    ],
    ['an empty reason', { status: 'REJECTED', customerReason: '  ', sale }],
    ['a non-string reason', { status: 'REJECTED', customerReason: 3, sale }],
    ['an extra key', { status: 'PENDING', sale, receiptId: 'r' }],
    ['negative debt', { status: 'PENDING', sale: { ...sale, debtCents: -1 } }],
    [
      'fractional debt',
      { status: 'PENDING', sale: { ...sale, debtCents: 1.5 } },
    ],
    ['a missing payment status', { status: 'PENDING', sale: { debtCents: 0 } }],
    [
      'an extra sale key',
      { status: 'PENDING', sale: { ...sale, totalCents: 1 } },
    ],
  ])('rejects %s', (_label, body) => {
    expect(parseReceiptOutcome(body)).toBeNull();
  });

  it('trims the customer reason and bounds its length', () => {
    expect(
      parseReceiptOutcome({
        status: 'REJECTED',
        customerReason: '  Comprobante ilegible ',
        sale,
      })?.customerReason,
    ).toBe('Comprobante ilegible');
    expect(
      parseReceiptOutcome({
        status: 'REJECTED',
        customerReason: 'x'.repeat(501),
        sale,
      }),
    ).toBeNull();
  });
});

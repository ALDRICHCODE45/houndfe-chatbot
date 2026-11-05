import { computeAmountMismatch } from './receipt-extraction.port';

describe('computeAmountMismatch', () => {
  it('is true when both amounts are known and differ', () => {
    expect(computeAmountMismatch(150000, 160000)).toBe(true);
  });

  it('is false when both amounts are known and equal', () => {
    expect(computeAmountMismatch(150000, 150000)).toBe(false);
  });

  it('is false when the extracted amount is unknown', () => {
    expect(computeAmountMismatch(null, 150000)).toBe(false);
  });

  it('is false when the expected amount is unknown', () => {
    expect(computeAmountMismatch(150000, null)).toBe(false);
  });

  it('is false when both amounts are unknown', () => {
    expect(computeAmountMismatch(null, null)).toBe(false);
  });
});

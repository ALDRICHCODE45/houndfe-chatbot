import { NullBankDetailsProvider } from './null-bank-details.provider';

/**
 * Unit test for the v1 default `BankDetailsProvider`.
 *
 * Spec: the runtime default implementation MUST return `null` until the
 * backend answers Q1. The null value triggers the human-handoff phrase
 * in `SALE_FLOW_INSTRUCTIONS`.
 */
describe('NullBankDetailsProvider', () => {
  it('resolves null', async () => {
    const provider = new NullBankDetailsProvider();
    await expect(provider.get()).resolves.toBeNull();
  });

  it('returns null on every call (idempotent)', async () => {
    const provider = new NullBankDetailsProvider();
    await expect(provider.get()).resolves.toBeNull();
    await expect(provider.get()).resolves.toBeNull();
  });
});

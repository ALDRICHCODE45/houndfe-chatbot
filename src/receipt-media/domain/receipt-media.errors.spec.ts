import { ReceiptMediaError } from './receipt-media.errors';

describe('ReceiptMediaError', () => {
  it('exposes only allowlisted category/code, never arbitrary text', () => {
    const sentinel = 'wamid.PII-SENTINEL caption URL token';
    const err = new ReceiptMediaError(
      'RECEIPT_OUTBOX_INVALID_INTENT',
      'TEMPLATE_ARGS_INVALID',
    );
    expect(err.message).toBe(
      'receipt-media:RECEIPT_OUTBOX_INVALID_INTENT/TEMPLATE_ARGS_INVALID',
    );
    expect(err.message).not.toContain(sentinel);
    expect(String(err)).not.toContain(sentinel);
  });
});

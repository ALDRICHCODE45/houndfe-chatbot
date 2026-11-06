import { toReceiptUploadForm } from './receipt-upload.dto';

const FILE = {
  bytes: Buffer.from('img'),
  mimeType: 'image/jpeg' as const,
  filename: 'receipt.jpg',
};

describe('toReceiptUploadForm', () => {
  // A retry re-sends fields read back from jsonb, which reorders keys; the
  // `extracted` part must still be byte-identical to the first attempt.
  it('serializes extracted in a fixed key order whatever the object order', () => {
    const first = toReceiptUploadForm(FILE, {
      extracted: {
        amountCents: 140000,
        date: '2026-11-05',
        reference: 'ABC',
        bank: 'BBVA',
        confidence: 0.6,
      },
    });
    const replayed = toReceiptUploadForm(FILE, {
      extracted: {
        bank: 'BBVA',
        date: '2026-11-05',
        confidence: 0.6,
        reference: 'ABC',
        amountCents: 140000,
      },
    });
    expect(replayed.get('extracted')).toBe(first.get('extracted'));
    expect(first.get('extracted')).toBe(
      '{"amountCents":140000,"date":"2026-11-05","reference":"ABC","bank":"BBVA","confidence":0.6}',
    );
  });

  it('omits absent extracted keys', () => {
    const form = toReceiptUploadForm(FILE, {
      extracted: { confidence: 0.3, amountCents: 1 },
    });
    expect(form.get('extracted')).toBe('{"amountCents":1,"confidence":0.3}');
  });
});

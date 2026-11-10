import {
  InvalidTranscriptMessageError,
  normalizeTranscriptMessage,
  transcriptPurgeAfter,
  type TranscriptMessageInput,
} from './transcript.port';

const BASE: TranscriptMessageInput = {
  senderId: '5215550001111',
  waMessageId: 'wamid.in-1',
  direction: 'IN',
  author: 'CUSTOMER',
  type: 'text',
  text: 'hola',
  providerTimestamp: '2026-11-09T16:02:11.000Z',
  observedAt: new Date('2026-11-09T16:02:12.345Z'),
};

describe('transcriptPurgeAfter', () => {
  it('adds 12 calendar months in UTC', () => {
    expect(
      transcriptPurgeAfter(new Date('2026-11-09T16:02:12.345Z')).toISOString(),
    ).toBe('2027-11-09T16:02:12.345Z');
  });

  it('clamps Feb 29 to Feb 28 like PostgreSQL', () => {
    expect(
      transcriptPurgeAfter(new Date('2028-02-29T23:59:59.999Z')).toISOString(),
    ).toBe('2029-02-28T23:59:59.999Z');
  });
});

describe('normalizeTranscriptMessage', () => {
  it('stamps ISO-8601 UTC times and the purge time', () => {
    expect(normalizeTranscriptMessage(BASE)).toEqual({
      senderId: '5215550001111',
      waMessageId: 'wamid.in-1',
      direction: 'IN',
      author: 'CUSTOMER',
      type: 'text',
      text: 'hola',
      media: null,
      details: null,
      providerTimestamp: '2026-11-09T16:02:11.000Z',
      observedAt: '2026-11-09T16:02:12.345Z',
      purgeAfter: '2027-11-09T16:02:12.345Z',
    });
  });

  it('drops empty text and media fields and an unparseable provider time', () => {
    expect(
      normalizeTranscriptMessage({
        ...BASE,
        type: 'image',
        text: '',
        media: { providerMediaId: 'm-1', mimeType: 'image/jpeg', filename: '' },
        providerTimestamp: 'not-a-date',
      }),
    ).toMatchObject({
      text: null,
      media: { providerMediaId: 'm-1', mimeType: 'image/jpeg' },
      providerTimestamp: null,
    });
  });

  it.each([
    ['senderId', { senderId: 'abc' }],
    ['waMessageId', { waMessageId: '' }],
    ['direction', { direction: 'SIDEWAYS' }],
    ['author', { author: 'ROBOT' }],
    ['type', { type: 'Text Message' }],
    ['observedAt', { observedAt: new Date('nope') }],
    ['text', { text: 'x'.repeat(16_385) }],
    ['details', { details: { blob: 'x'.repeat(9_000) } }],
  ])('refuses an invalid %s', (field, patch) => {
    expect(() =>
      normalizeTranscriptMessage({
        ...BASE,
        ...(patch as Partial<TranscriptMessageInput>),
      }),
    ).toThrow(new InvalidTranscriptMessageError(field));
  });
});

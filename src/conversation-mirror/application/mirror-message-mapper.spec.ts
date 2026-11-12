import type { BackendOutboxEntry } from '../../backend-outbox/domain/backend-outbox';
import {
  mapMirrorEntry,
  renderMirrorText,
  type MappedMirrorEntry,
} from './mirror-message-mapper';

const NOW = new Date('2026-11-12T17:00:00.000Z');
const entry = (payload: Record<string, unknown>): BackendOutboxEntry => ({
  id: '1',
  conversationRef: 'wa:5215550001111',
  seq: 1,
  kind: 'MESSAGE_MIRROR',
  idempotencyKey: 'mirror:x',
  payload,
  status: 'IN_FLIGHT',
  attempts: 0,
  nextAttemptAt: NOW,
  leaseOwner: 'o',
  leaseExpiresAt: NOW,
  lastError: null,
  createdAt: new Date('2026-11-12T16:30:00.000Z'),
  doneAt: null,
});
const base = {
  waMessageId: 'wamid.A',
  direction: 'IN',
  author: 'CUSTOMER',
  type: 'text',
  contractType: 'TEXT',
  text: 'hola',
  providerTimestamp: '2026-11-12T16:02:11.000Z',
  observedAt: '2026-11-12T16:02:12.103Z',
};
const ok = (mapped: MappedMirrorEntry) => {
  if (!mapped.ok) throw new Error(`unmappable: ${mapped.reason}`);
  return mapped;
};
const chars = (text: string) => Array.from(text).length;

describe('renderMirrorText (S5 #2: options appended, options truncated first)', () => {
  it('appends the options after the body', () => {
    expect(
      renderMirrorText('¿Desea algo más?', ['Sí', 'No', 'Hablar con alguien']),
    ).toBe('¿Desea algo más?\n\nOpciones: Sí · No · Hablar con alguien');
  });

  it('is the body untouched without options, and a body of exactly 4096 is kept', () => {
    expect(renderMirrorText('hola', null)).toBe('hola');
    expect(renderMirrorText('hola', [])).toBe('hola');
    const body = 'x'.repeat(4096);
    expect(renderMirrorText(body, null)).toBe(body);
  });

  it('truncates the options first and ends within 4096 characters', () => {
    const body = 'b'.repeat(4000);
    const text = renderMirrorText(body, ['A'.repeat(200), 'B'.repeat(200)]);
    expect(chars(text)).toBe(4096);
    expect(text.startsWith(`${body}\n\nOpciones: AAAA`)).toBe(true);
    expect(text.endsWith('…')).toBe(true);
  });

  it('drops the options entirely when the body leaves no room, then truncates the body', () => {
    const nearlyFull = 'b'.repeat(4090);
    expect(renderMirrorText(nearlyFull, ['Sí', 'No'])).toBe(nearlyFull);
    const tooLong = 'c'.repeat(5000);
    const text = renderMirrorText(tooLong, ['Sí', 'No']);
    expect(chars(text)).toBe(4096);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('Opciones');
  });

  it('counts characters, not UTF-16 units (emoji)', () => {
    const body = '😀'.repeat(4000);
    const text = renderMirrorText(body, ['😀'.repeat(300)]);
    expect(chars(text)).toBe(4096);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('a blank body shows only the options line', () => {
    expect(renderMirrorText('', ['Sí', 'No'])).toBe('Opciones: Sí · No');
  });
});

describe('mapMirrorEntry', () => {
  it('maps an inbound text row with the contract fields and author', () => {
    const mapped = ok(mapMirrorEntry(entry(base), NOW));
    expect(mapped.message).toEqual({
      waMessageId: 'wamid.A',
      direction: 'IN',
      author: 'CUSTOMER',
      type: 'TEXT',
      text: 'hola',
      providerTimestamp: '2026-11-12T16:02:11.000Z',
      observedAt: '2026-11-12T16:02:12.103Z',
    });
    expect(mapped.media).toBeUndefined();
  });

  it('derives the author from the direction, never from the payload', () => {
    const mapped = ok(
      mapMirrorEntry(
        entry({ ...base, direction: 'OUT', author: 'STAFF' }),
        NOW,
      ),
    );
    expect(mapped.message.author).toBe('BOT');
  });

  it('appends an interactive OUT row options', () => {
    const mapped = ok(
      mapMirrorEntry(
        entry({
          ...base,
          direction: 'OUT',
          type: 'interactive',
          contractType: 'TEXT',
          text: '¿Confirma?',
          options: ['Sí', 'No'],
        }),
        NOW,
      ),
    );
    expect(mapped.message.text).toBe('¿Confirma?\n\nOpciones: Sí · No');
  });

  it('does not append options to an inbound row', () => {
    const mapped = ok(mapMirrorEntry(entry({ ...base, options: ['Sí'] }), NOW));
    expect(mapped.message.text).toBe('hola');
  });

  it.each([
    ['text', 'TEXT'],
    ['interactive', 'TEXT'],
    ['button', 'TEXT'],
    ['image', 'IMAGE'],
    ['sticker', 'STICKER'],
    ['document', 'DOCUMENT'],
    ['audio', 'AUDIO'],
  ])('old rows without contractType: %s → %s', (type, contractType) => {
    const { contractType: _drop, ...old } = base;
    void _drop;
    const mapped = ok(
      mapMirrorEntry(
        entry({
          ...old,
          type,
          media: { providerMediaId: 'm1', mimeType: 'image/jpeg' },
        }),
        NOW,
      ),
    );
    expect(mapped.message.type).toBe(contractType);
  });

  it('old rows: video and location are UNSUPPORTED with their kind and no text', () => {
    const { contractType: _drop, text: _text, ...old } = base;
    void _drop;
    void _text;
    const video = ok(mapMirrorEntry(entry({ ...old, type: 'video' }), NOW));
    expect(video.message).toMatchObject({ type: 'UNSUPPORTED', kind: 'VIDEO' });
    expect(video.message.text).toBeUndefined();
    const location = ok(
      mapMirrorEntry(entry({ ...old, type: 'location', text: 'x' }), NOW),
    );
    expect(location.message).toMatchObject({
      type: 'UNSUPPORTED',
      kind: 'LOCATION',
    });
    expect(location.message.text).toBeUndefined();
    const other = ok(mapMirrorEntry(entry({ ...old, type: 'contacts' }), NOW));
    expect(other.message).toMatchObject({ type: 'UNSUPPORTED', kind: 'OTHER' });
  });

  it('new rows use contractType and unsupportedKind', () => {
    const mapped = ok(
      mapMirrorEntry(
        entry({
          ...base,
          type: 'location',
          contractType: 'UNSUPPORTED',
          unsupportedKind: 'LOCATION',
        }),
        NOW,
      ),
    );
    expect(mapped.message).toMatchObject({
      type: 'UNSUPPORTED',
      kind: 'LOCATION',
    });
  });

  it('a media row keeps its caption and asks for its media to be resolved', () => {
    const media = { providerMediaId: 'meta-1', mimeType: 'image/jpeg' };
    const mapped = ok(
      mapMirrorEntry(
        entry({
          ...base,
          type: 'image',
          contractType: 'IMAGE',
          text: 'mi foto',
          media,
        }),
        NOW,
      ),
    );
    expect(mapped.message).toMatchObject({ type: 'IMAGE', text: 'mi foto' });
    expect(mapped.message.mediaId).toBeUndefined();
    expect(mapped.media).toEqual({ payload: media, type: 'IMAGE' });
  });

  it('a media row without a caption sends no text', () => {
    const { text: _t, ...noText } = base;
    void _t;
    const mapped = ok(
      mapMirrorEntry(
        entry({
          ...noText,
          type: 'audio',
          contractType: 'AUDIO',
          media: { providerMediaId: 'a' },
        }),
        NOW,
      ),
    );
    expect(mapped.message.text).toBeUndefined();
  });

  it('L7: an old OUT row without providerTimestamp is backfilled with observedAt', () => {
    const { providerTimestamp: _p, ...old } = base;
    void _p;
    const mapped = ok(mapMirrorEntry(entry({ ...old, direction: 'OUT' }), NOW));
    expect(mapped.message.providerTimestamp).toBe(base.observedAt);
    expect(mapped.message.observedAt).toBe(base.observedAt);
  });

  it('an unparsable providerTimestamp is backfilled, a missing observedAt falls back to createdAt', () => {
    const { observedAt: _o, ...noObserved } = base;
    void _o;
    const mapped = ok(
      mapMirrorEntry(
        entry({ ...noObserved, providerTimestamp: 'yesterday' }),
        NOW,
      ),
    );
    expect(mapped.message.observedAt).toBe('2026-11-12T16:30:00.000Z');
    expect(mapped.message.providerTimestamp).toBe('2026-11-12T16:30:00.000Z');
  });

  it('clamps timestamps more than a few minutes in the future to now (display-only clocks)', () => {
    const mapped = ok(
      mapMirrorEntry(
        entry({ ...base, providerTimestamp: '2026-11-12T18:00:00.000Z' }),
        NOW,
      ),
    );
    expect(mapped.message.providerTimestamp).toBe(NOW.toISOString());
  });

  it('truncates a text above 4096 characters', () => {
    const mapped = ok(
      mapMirrorEntry(entry({ ...base, text: 'y'.repeat(5000) }), NOW),
    );
    expect(chars(mapped.message.text!)).toBe(4096);
  });

  it.each([
    ['no waMessageId', { waMessageId: undefined }],
    ['an invalid waMessageId', { waMessageId: 'wamid with spaces' }],
    ['no direction', { direction: 'SIDEWAYS' }],
    ['no type at all', { type: undefined, contractType: undefined }],
    ['a TEXT without text', { text: '   ' }],
    ['a non-string text', { text: 42 }],
  ])('is unmappable (on its own) with %s', (_label, patch) => {
    const mapped = mapMirrorEntry(entry({ ...base, ...patch }), NOW);
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) {
      expect(mapped.reason).toBeTruthy();
      expect(mapped.reason).not.toContain('5215550001111');
    }
  });
});

describe('mapMirrorEntry staffReplyId (unit 10)', () => {
  const REPLY = '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09';
  const out = {
    ...base,
    direction: 'OUT',
    author: 'BOT',
    text: 'Le comparto…',
  };

  it('is sent on an OUT TEXT message together with the text we sent', () => {
    const { message } = ok(
      mapMirrorEntry(entry({ ...out, staffReplyId: REPLY }), NOW),
    );
    expect(message).toMatchObject({
      direction: 'OUT',
      type: 'TEXT',
      text: 'Le comparto…',
      staffReplyId: REPLY,
    });
  });

  it('old payloads without it are unaffected', () => {
    const { message } = ok(mapMirrorEntry(entry(out), NOW));
    expect(message).not.toHaveProperty('staffReplyId');
  });

  it.each([
    ['an IN message', { ...base, staffReplyId: REPLY }],
    [
      'a non-text OUT',
      {
        ...out,
        type: 'template',
        contractType: 'TEMPLATE',
        staffReplyId: REPLY,
      },
    ],
    ['a malformed id', { ...out, staffReplyId: 'nope' }],
    ['a non-string id', { ...out, staffReplyId: 7 }],
  ])('is dropped (row still mapped) for %s', (_name, payload) => {
    const { message } = ok(mapMirrorEntry(entry(payload), NOW));
    expect(message).not.toHaveProperty('staffReplyId');
  });
});

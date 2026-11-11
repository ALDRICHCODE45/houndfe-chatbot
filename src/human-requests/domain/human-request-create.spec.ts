import { createHash } from 'node:crypto';
import {
  ASK_TEAM_QUESTION_MAX_LENGTH,
  buildUnknownQuestionRequest,
  unknownQuestionDedupKey,
} from './human-request-create';

const SENDER = '5215550001111';
const SOURCE = '3f1d2b6a-7c10-4c1e-9a52-0b8f5c0e6d7a';
const NOW = new Date('2026-11-10T16:20:00.000Z');
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VARIANT = '22222222-2222-4222-8222-222222222222';

const hash = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);

describe('unknownQuestionDedupKey', () => {
  it('hashes the normalized question (first 24 hex of sha256)', () => {
    expect(unknownQuestionDedupKey('¿Sirve para gatos?')).toBe(
      `UNKNOWN_QUESTION:${hash('¿sirve para gatos?')}`,
    );
  });

  it('is stable across whitespace and case variants', () => {
    const key = unknownQuestionDedupKey('¿Sirve para gatos?');
    for (const variant of [
      '  ¿sirve PARA gatos?  ',
      '¿Sirve\npara\t\tgatos?',
      '¿SIRVE para   GATOS?',
    ])
      expect(unknownQuestionDedupKey(variant)).toBe(key);
    expect(unknownQuestionDedupKey('¿Sirve para perros?')).not.toBe(key);
  });
});

describe('buildUnknownQuestionRequest', () => {
  const input = {
    senderId: SENDER,
    question: '  ¿Este collar sirve para un gato de 3 kg?  ',
    summary: '  Compatibilidad de collar con gato de 3 kg  ',
    inboundAt: '2026-11-10T16:19:30Z',
    triggerWaMessageId: 'wamid.Q1',
  };

  it('builds the exact UNKNOWN_QUESTION envelope', () => {
    expect(
      buildUnknownQuestionRequest(
        { ...input, productIds: [PRODUCT], variantIds: [VARIANT] },
        { sourceRequestId: SOURCE, now: NOW },
      ),
    ).toEqual({
      sourceRequestId: SOURCE,
      subtype: 'UNKNOWN_QUESTION',
      customer: { phoneCountryCode: '52', phone: '5550001111' },
      conversationRef: `wa:${SENDER}`,
      lastCustomerMessageAt: '2026-11-10T16:19:30.000Z',
      summary: 'Compatibilidad de collar con gato de 3 kg',
      needs: '¿Este collar sirve para un gato de 3 kg?',
      context: { productIds: [PRODUCT], variantIds: [VARIANT] },
      dedupKey: unknownQuestionDedupKey(input.question),
      triggerWaMessageId: 'wamid.Q1',
    });
  });

  it('keeps the raw sender id in conversationRef (legacy 521 shape)', () => {
    const request = buildUnknownQuestionRequest(
      { ...input, senderId: '5215550001111' },
      { sourceRequestId: SOURCE, now: NOW },
    );
    expect(request?.conversationRef).toBe('wa:5215550001111');
    expect(request?.customer).toEqual({
      phoneCountryCode: '52',
      phone: '5550001111',
    });
    const modern = buildUnknownQuestionRequest(
      { ...input, senderId: '525550001111' },
      { sourceRequestId: SOURCE, now: NOW },
    );
    expect(modern?.conversationRef).toBe('wa:525550001111');
  });

  it('omits empty context and a missing trigger', () => {
    const request = buildUnknownQuestionRequest(
      { ...input, productIds: [], triggerWaMessageId: undefined },
      { sourceRequestId: SOURCE, now: NOW },
    );
    expect(request).not.toHaveProperty('context');
    expect(request).not.toHaveProperty('triggerWaMessageId');
  });

  it('dedups and caps context ids at 20', () => {
    const ids = Array.from(
      { length: 25 },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    );
    const request = buildUnknownQuestionRequest(
      { ...input, productIds: [ids[0], ...ids] },
      { sourceRequestId: SOURCE, now: NOW },
    );
    expect(request?.context?.productIds).toEqual(ids.slice(0, 20));
  });

  it.each([
    ['missing', undefined],
    ['unparseable', 'ayer'],
    ['too far in the future', '2026-11-10T16:30:00.000Z'],
    ['older than 30 days', '2026-10-01T00:00:00.000Z'],
  ])('uses now when the inbound time is %s', (_label, inboundAt) => {
    expect(
      buildUnknownQuestionRequest(
        { ...input, inboundAt },
        { sourceRequestId: SOURCE, now: NOW },
      )?.lastCustomerMessageAt,
    ).toBe('2026-11-10T16:20:00.000Z');
  });

  it('bounds the question and the summary', () => {
    const request = buildUnknownQuestionRequest(
      { ...input, question: 'a'.repeat(1200), summary: 'b'.repeat(200) },
      { sourceRequestId: SOURCE, now: NOW },
    );
    expect(request?.needs).toHaveLength(ASK_TEAM_QUESTION_MAX_LENGTH);
    expect(request?.summary).toHaveLength(140);
  });

  it.each([
    ['a non-Mexican sender', { senderId: '15550001111' }],
    ['an empty question', { question: '   ' }],
    ['an empty summary', { summary: ' ' }],
  ])('returns null for %s', (_label, patch) => {
    expect(
      buildUnknownQuestionRequest(
        { ...input, ...patch },
        { sourceRequestId: SOURCE, now: NOW },
      ),
    ).toBeNull();
  });
});

import { createHash } from 'node:crypto';
import {
  ASK_TEAM_QUESTION_MAX_LENGTH,
  TALK_TO_HUMAN_DEDUP_KEY,
  TALK_TO_HUMAN_QUEUED_REPLY,
  TALK_TO_HUMAN_SUMMARY,
  buildTalkToHumanRequest,
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

describe('buildTalkToHumanRequest (T8 / S6)', () => {
  const input = {
    senderId: SENDER,
    text: '  Quiero hablar con una persona  ',
    inboundAt: '2026-11-10T16:19:30Z',
    triggerWaMessageId: 'wamid.T1',
  };

  it('builds the exact TALK_TO_HUMAN envelope', () => {
    expect(
      buildTalkToHumanRequest(input, { sourceRequestId: SOURCE, now: NOW }),
    ).toEqual({
      sourceRequestId: SOURCE,
      subtype: 'TALK_TO_HUMAN',
      customer: { phoneCountryCode: '52', phone: '5550001111' },
      conversationRef: `wa:${SENDER}`,
      lastCustomerMessageAt: '2026-11-10T16:19:30.000Z',
      summary: TALK_TO_HUMAN_SUMMARY,
      needs: 'Quiero hablar con una persona',
      dedupKey: TALK_TO_HUMAN_DEDUP_KEY,
      triggerWaMessageId: 'wamid.T1',
    });
  });

  it('uses one fixed dedup key so a repeated ask merges into the open request', () => {
    expect(TALK_TO_HUMAN_DEDUP_KEY).toBe('TALK_TO_HUMAN');
    expect(TALK_TO_HUMAN_DEDUP_KEY).toMatch(/^[A-Za-z0-9:_.-]{1,200}$/);
    const other = buildTalkToHumanRequest(
      { ...input, text: 'pásame con alguien' },
      { sourceRequestId: SOURCE, now: NOW },
    );
    expect(other?.dedupKey).toBe(TALK_TO_HUMAN_DEDUP_KEY);
  });

  it('has a summary within the backend bound (1..140, no control chars)', () => {
    expect(TALK_TO_HUMAN_SUMMARY.length).toBeGreaterThan(0);
    expect(TALK_TO_HUMAN_SUMMARY.length).toBeLessThanOrEqual(140);
    // eslint-disable-next-line no-control-regex
    expect(TALK_TO_HUMAN_SUMMARY).not.toMatch(/[\u0000-\u001f]/);
  });

  it('omits a missing trigger and bounds the quoted text', () => {
    const request = buildTalkToHumanRequest(
      { ...input, text: 'a'.repeat(1200), triggerWaMessageId: undefined },
      { sourceRequestId: SOURCE, now: NOW },
    );
    expect(request).not.toHaveProperty('triggerWaMessageId');
    expect(request?.needs).toHaveLength(ASK_TEAM_QUESTION_MAX_LENGTH);
  });

  it('uses now when the inbound time is out of bounds', () => {
    expect(
      buildTalkToHumanRequest(
        { ...input, inboundAt: '2026-10-01T00:00:00.000Z' },
        { sourceRequestId: SOURCE, now: NOW },
      )?.lastCustomerMessageAt,
    ).toBe('2026-11-10T16:20:00.000Z');
  });

  it('keeps no needs when the text is empty, and null for a non-Mexican sender', () => {
    expect(
      buildTalkToHumanRequest(
        { ...input, text: '   ' },
        { sourceRequestId: SOURCE, now: NOW },
      ),
    ).not.toHaveProperty('needs');
    expect(
      buildTalkToHumanRequest(
        { ...input, senderId: '15550001111' },
        { sourceRequestId: SOURCE, now: NOW },
      ),
    ).toBeNull();
  });

  it('has a queued reply that never claims the team was asked', () => {
    expect(TALK_TO_HUMAN_QUEUED_REPLY).toBe(
      'Estoy registrando su solicitud para que le atienda una persona del equipo; le aviso por aquí.',
    );
  });
});

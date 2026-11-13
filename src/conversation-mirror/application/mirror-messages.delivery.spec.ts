import { Logger } from '@nestjs/common';
import type { BackendOutboxDeliveryResult } from '../../backend-outbox/domain/backend-outbox';
import type {
  MirrorMessageInput,
  MirrorMessagesResult,
} from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import type { ResolveMediaOutcome } from '../domain/mirror-media';
import { MirrorDeliveryGate } from './mirror-delivery-gate';
import { MirrorMessagesDelivery } from './mirror-messages.delivery';
import {
  MEDIA_ID,
  MEDIA_ID_2,
  NOW,
  REF,
  imagePayload,
  okAck,
  rowEntry,
  textPayload,
} from './mirror-test-support';

type Call = { ref: string; messages: MirrorMessageInput[] };
type ClientScript = (call: Call, index: number) => MirrorMessagesResult;
type MediaScript = (
  media: unknown,
  type: string,
  options: { force?: boolean; signal?: AbortSignal },
) => ResolveMediaOutcome | Promise<ResolveMediaOutcome>;

const okMedia = (id = MEDIA_ID): ResolveMediaOutcome => ({
  kind: 'ok',
  mediaId: id,
  mimeType: 'image/jpeg',
  sizeBytes: 10,
  from: 'cache',
});

function build(
  client: ClientScript = (call) => okAck(call.messages),
  media: MediaScript = () => okMedia(),
  gateOptions: { clock?: () => number } = {},
) {
  const calls: Call[] = [];
  const mirrorMessages = jest.fn(
    (ref: string, messages: MirrorMessageInput[]) => {
      const call = { ref, messages: structuredClone(messages) };
      calls.push(call);
      return Promise.resolve(client(call, calls.length - 1));
    },
  );
  const resolveMedia = jest.fn(
    (
      payload: unknown,
      type: string,
      options: { force?: boolean; signal?: AbortSignal } = {},
    ) => Promise.resolve(media(payload, type, options)),
  );
  const gate = new MirrorDeliveryGate({
    random: () => 0,
    ...gateOptions,
  });
  const delivery = new MirrorMessagesDelivery({
    client: { mirrorMessages },
    media: { resolveMedia },
    gate,
    clock: () => NOW,
  });
  return { delivery, calls, mirrorMessages, resolveMedia, gate };
}

const texts = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) =>
    rowEntry(from + i, textPayload(`wamid.${from + i}`)),
  );
const contains = (text: string): string =>
  expect.stringContaining(text) as string;
const DELIVERED: BackendOutboxDeliveryResult = { outcome: 'DELIVERED' };
const outcomes = (results: BackendOutboxDeliveryResult[]) =>
  results.map((r) => r.outcome);
const containsBad = (call: Call, bad: string[]) =>
  call.messages.some((m) => bad.includes(m.waMessageId));

describe('MirrorMessagesDelivery (T4)', () => {
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnLog = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('batches up to 50 MESSAGE_MIRROR rows and nothing else', () => {
    const { delivery } = build();
    expect(delivery.batchLimit('MESSAGE_MIRROR')).toBe(50);
    expect(delivery.batchLimit('MESSAGE_STATUS')).toBe(1);
    expect(delivery.batchLimit('REQUEST_CREATE')).toBe(1);
  });

  describe('happy path', () => {
    it('sends the run in seq order in ONE call and ACKs every row', async () => {
      const { delivery, calls } = build();
      const entries = texts(50);
      const results = await delivery.deliverBatch(entries);
      expect(results).toEqual(entries.map(() => DELIVERED));
      expect(calls).toHaveLength(1);
      expect(calls[0].ref).toBe(REF);
      expect(calls[0].messages.map((m) => m.waMessageId)).toEqual(
        entries.map((e) => e.payload.waMessageId),
      );
      expect(calls[0].messages[0]).toMatchObject({
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'TEXT',
        text: 'texto wamid.1',
      });
    });

    it('duplicates are ACKed like accepted rows', async () => {
      const { delivery } = build((call) =>
        okAck(call.messages, [call.messages[1].waMessageId]),
      );
      const results = await delivery.deliverBatch(texts(3));
      expect(outcomes(results)).toEqual([
        'DELIVERED',
        'DELIVERED',
        'DELIVERED',
      ]);
    });

    it('deliver(entry) is a batch of one', async () => {
      const { delivery, calls } = build();
      await expect(delivery.deliver(texts(1)[0])).resolves.toEqual(DELIVERED);
      expect(calls).toHaveLength(1);
    });

    it('an empty run makes no call', async () => {
      const { delivery, mirrorMessages } = build();
      await expect(delivery.deliverBatch([])).resolves.toEqual([]);
      expect(mirrorMessages).not.toHaveBeenCalled();
    });

    it('renders options for an interactive OUT row and backfills an old OUT timestamp', async () => {
      const { delivery, calls } = build();
      const { providerTimestamp: _p, ...old } = textPayload('wamid.9', {
        direction: 'OUT',
        author: 'BOT',
        type: 'interactive',
        text: '¿Confirma?',
        options: ['Sí', 'No'],
      });
      void _p;
      await delivery.deliverBatch([rowEntry(1, old)]);
      expect(calls[0].messages[0]).toMatchObject({
        direction: 'OUT',
        author: 'BOT',
        type: 'TEXT',
        text: '¿Confirma?\n\nOpciones: Sí · No',
        providerTimestamp: '2026-11-12T16:02:12.103Z',
        observedAt: '2026-11-12T16:02:12.103Z',
      });
    });
  });

  describe('unmappable rows (L7: never park valid neighbours)', () => {
    it('DEADs only the unmappable row and delivers the rest in one call', async () => {
      const { delivery, calls } = build();
      const entries = [
        ...texts(2),
        rowEntry(3, textPayload('wamid.3', { text: '   ' })),
        ...texts(2, 4),
      ];
      const results = await delivery.deliverBatch(entries);
      expect(outcomes(results)).toEqual([
        'DELIVERED',
        'DELIVERED',
        'PERMANENT',
        'DELIVERED',
        'DELIVERED',
      ]);
      expect(results[2]).toMatchObject({
        outcome: 'PERMANENT',
        error: contains('TEXT'),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].messages.map((m) => m.waMessageId)).toEqual([
        'wamid.1',
        'wamid.2',
        'wamid.4',
        'wamid.5',
      ]);
    });

    it('a locally invalid message (TEMPLATE inbound) is DEAD alone, no HTTP for it', async () => {
      const { delivery, calls } = build();
      const results = await delivery.deliverBatch([
        rowEntry(1, textPayload('wamid.1')),
        rowEntry(
          2,
          textPayload('wamid.2', {
            type: 'template',
            contractType: 'TEMPLATE',
          }),
        ),
      ]);
      expect(outcomes(results)).toEqual(['DELIVERED', 'PERMANENT']);
      expect(calls).toHaveLength(1);
      expect(calls[0].messages).toHaveLength(1);
    });

    it('a run where every row is unmappable makes no call', async () => {
      const { delivery, mirrorMessages } = build();
      const results = await delivery.deliverBatch([
        rowEntry(1, { nonsense: true }),
        rowEntry(2, {}),
      ]);
      expect(outcomes(results)).toEqual(['PERMANENT', 'PERMANENT']);
      expect(mirrorMessages).not.toHaveBeenCalled();
    });
  });

  describe('media (T3 service)', () => {
    it('resolves each media and sends the mediaId, keeping the caption', async () => {
      const { delivery, calls, resolveMedia } = build((c) => okAck(c.messages));
      await delivery.deliverBatch([
        rowEntry(1, imagePayload('wamid.1', 'meta-1')),
        rowEntry(2, textPayload('wamid.2')),
      ]);
      expect(resolveMedia).toHaveBeenCalledTimes(1);
      expect(resolveMedia).toHaveBeenCalledWith(
        { providerMediaId: 'meta-1', mimeType: 'image/jpeg' },
        'IMAGE',
        expect.objectContaining({ force: false }),
      );
      expect(calls[0].messages[0]).toMatchObject({
        type: 'IMAGE',
        mediaId: MEDIA_ID,
        text: 'mi foto',
      });
    });

    it('unsupported media is sent as UNSUPPORTED OTHER without text or media', async () => {
      const { delivery, calls } = build(
        (c) => okAck(c.messages),
        () => ({ kind: 'unsupported', reason: 'too_large' }),
      );
      const results = await delivery.deliverBatch([
        rowEntry(1, imagePayload('wamid.1')),
      ]);
      expect(outcomes(results)).toEqual(['DELIVERED']);
      expect(calls[0].messages[0]).toEqual({
        waMessageId: 'wamid.1',
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'UNSUPPORTED',
        kind: 'OTHER',
        providerTimestamp: '2026-11-12T16:02:11.000Z',
        observedAt: '2026-11-12T16:02:12.103Z',
      });
    });

    it('a parked media mirrors only that row as UNSUPPORTED OTHER and warns', async () => {
      const { delivery, calls } = build(
        (c) => okAck(c.messages),
        (media) =>
          (media as { providerMediaId: string }).providerMediaId === 'meta-bad'
            ? { kind: 'park', reason: 'invalid_payload' }
            : okMedia(),
      );
      const results = await delivery.deliverBatch([
        rowEntry(1, imagePayload('wamid.1', 'meta-ok')),
        rowEntry(2, imagePayload('wamid.2', 'meta-bad')),
      ]);
      expect(outcomes(results)).toEqual(['DELIVERED', 'DELIVERED']);
      expect(calls[0].messages.map((m) => m.type)).toEqual([
        'IMAGE',
        'UNSUPPORTED',
      ]);
      expect(warnLog).toHaveBeenCalledWith(contains('invalid_payload'));
    });

    it('a media retry retries the whole batch with its retryAfter and sends nothing', async () => {
      const { delivery, mirrorMessages } = build(
        (c) => okAck(c.messages),
        () => ({ kind: 'retry', cause: 'rate_limited', retryAfterSeconds: 12 }),
      );
      const results = await delivery.deliverBatch([
        rowEntry(1, textPayload('wamid.1')),
        rowEntry(2, imagePayload('wamid.2')),
      ]);
      expect(results).toEqual([
        {
          outcome: 'RETRY',
          error: contains('rate_limited'),
          retryAfterMs: 12_000,
        },
        {
          outcome: 'RETRY',
          error: contains('rate_limited'),
          retryAfterMs: 12_000,
        },
      ]);
      expect(mirrorMessages).not.toHaveBeenCalled();
    });

    it('a media retry without retryAfter uses the worker backoff', async () => {
      const { delivery } = build(
        (c) => okAck(c.messages),
        () => ({
          kind: 'retry',
          cause: 'source_transient',
          retryAfterSeconds: null,
        }),
      );
      const [result] = await delivery.deliverBatch([
        rowEntry(1, imagePayload('w')),
      ]);
      expect(result).toEqual({
        outcome: 'RETRY',
        error: contains('source_transient'),
      });
    });

    it('a media stop never kills rows: RETRY with a long backoff and ONE alert', async () => {
      const { delivery, mirrorMessages } = build(
        (c) => okAck(c.messages),
        () => ({ kind: 'stop', reason: 'backend_forbidden' }),
      );
      for (let i = 0; i < 3; i++) {
        const results = await delivery.deliverBatch([
          rowEntry(1, imagePayload('wamid.1')),
        ]);
        expect(results[0]).toMatchObject({
          outcome: 'RETRY',
          retryAfterMs: 15 * 60_000,
        });
      }
      expect(mirrorMessages).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it('resolves at most two media at a time and stops starting new ones after a halt', async () => {
      let active = 0;
      let peak = 0;
      let started = 0;
      const { delivery } = build(
        (c) => okAck(c.messages),
        async () => {
          started += 1;
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return started === 2
            ? { kind: 'retry', cause: 'storage_failed', retryAfterSeconds: 5 }
            : okMedia();
        },
      );
      const entries = Array.from({ length: 10 }, (_, i) =>
        rowEntry(i + 1, imagePayload(`wamid.${i + 1}`)),
      );
      await delivery.deliverBatch(entries);
      expect(peak).toBeLessThanOrEqual(2);
      expect(started).toBeLessThan(10);
    });
  });

  describe('S4 reactions', () => {
    it('413 BATCH_TOO_LARGE halves the batch and resends', async () => {
      const { delivery, calls } = build((call) =>
        call.messages.length > 3
          ? { kind: 'BATCH_TOO_LARGE', limit: 3, local: false }
          : okAck(call.messages),
      );
      const results = await delivery.deliverBatch(texts(8));
      expect(outcomes(results)).toEqual(Array(8).fill('DELIVERED'));
      expect(calls.map((c) => c.messages.length)).toEqual([
        8, 4, 2, 2, 4, 2, 2,
      ]);
      // Every row went out exactly once in an accepted (≤ 3) call.
      expect(
        calls
          .filter((c) => c.messages.length <= 3)
          .flatMap((c) => c.messages.map((m) => m.waMessageId)),
      ).toEqual(texts(8).map((e) => e.payload.waMessageId));
    });

    it('413 BODY_TOO_LARGE also halves; a single oversized row is DEAD', async () => {
      const { delivery } = build(() => ({ kind: 'BODY_TOO_LARGE' }));
      const results = await delivery.deliverBatch(texts(2));
      expect(outcomes(results)).toEqual(['PERMANENT', 'PERMANENT']);
    });

    it('422 MEDIA_NOT_FOUND re-uploads EVERY media of the batch (force) and resends the batch', async () => {
      let first = true;
      const { delivery, calls, resolveMedia } = build(
        (call) => {
          if (first) {
            first = false;
            return { kind: 'MEDIA_NOT_FOUND' };
          }
          return okAck(call.messages);
        },
        (media, _type, options) =>
          options.force ? okMedia(MEDIA_ID_2) : okMedia(MEDIA_ID),
      );
      const results = await delivery.deliverBatch([
        rowEntry(1, imagePayload('wamid.1', 'meta-1')),
        rowEntry(2, textPayload('wamid.2')),
        rowEntry(3, imagePayload('wamid.3', 'meta-3')),
      ]);
      expect(outcomes(results)).toEqual([
        'DELIVERED',
        'DELIVERED',
        'DELIVERED',
      ]);
      const forced = resolveMedia.mock.calls.filter(([, , o]) => o?.force);
      expect(
        forced.map(([m]) => (m as { providerMediaId: string }).providerMediaId),
      ).toEqual(['meta-1', 'meta-3']);
      expect(calls).toHaveLength(2);
      expect(calls[0].messages.map((m) => m.mediaId)).toEqual([
        MEDIA_ID,
        undefined,
        MEDIA_ID,
      ]);
      expect(calls[1].messages.map((m) => m.mediaId)).toEqual([
        MEDIA_ID_2,
        undefined,
        MEDIA_ID_2,
      ]);
    });

    it('MEDIA_NOT_FOUND again after the forced re-upload → RETRY (bounded, no loop)', async () => {
      const { delivery, calls } = build(() => ({ kind: 'MEDIA_NOT_FOUND' }));
      const results = await delivery.deliverBatch([
        rowEntry(1, imagePayload('wamid.1')),
        rowEntry(2, textPayload('wamid.2')),
      ]);
      expect(calls).toHaveLength(2);
      expect(results).toEqual([
        { outcome: 'RETRY', error: contains('MEDIA_NOT_FOUND') },
        { outcome: 'RETRY', error: contains('MEDIA_NOT_FOUND') },
      ]);
    });

    describe('persistent MEDIA_NOT_FOUND never blocks the lane', () => {
      /** The backend keeps refusing the media of these messages. */
      const failing = (bad: string[]) => (call: Call) =>
        call.messages.some((m) => bad.includes(m.waMessageId) && m.mediaId)
          ? ({ kind: 'MEDIA_NOT_FOUND' } as const)
          : okAck(call.messages);
      const withAttempts = (
        seq: number,
        payload: Record<string, unknown>,
        attempts: number,
      ) => rowEntry(seq, payload, 'MESSAGE_MIRROR', { attempts });

      it('below the attempt cap (2 retries) every row keeps the plain RETRY, no isolation calls', async () => {
        const { delivery, calls } = build(failing(['wamid.2']));
        const results = await delivery.deliverBatch([
          rowEntry(1, textPayload('wamid.1')),
          withAttempts(2, imagePayload('wamid.2'), 2),
          rowEntry(3, textPayload('wamid.3')),
        ]);
        expect(results).toEqual([
          { outcome: 'RETRY', error: contains('MEDIA_NOT_FOUND') },
          { outcome: 'RETRY', error: contains('MEDIA_NOT_FOUND') },
          { outcome: 'RETRY', error: contains('MEDIA_NOT_FOUND') },
        ]);
        expect(calls).toHaveLength(2);
        expect(warnLog).not.toHaveBeenCalled();
      });

      it('at the cap (3 retries) that message is mirrored as UNSUPPORTED OTHER and the rest of the batch is DELIVERED', async () => {
        const { delivery, calls } = build(failing(['wamid.2']));
        const results = await delivery.deliverBatch([
          rowEntry(1, textPayload('wamid.1')),
          withAttempts(2, imagePayload('wamid.2'), 3),
          rowEntry(3, textPayload('wamid.3')),
          rowEntry(4, imagePayload('wamid.4', 'meta-4')),
        ]);
        expect(outcomes(results)).toEqual([
          'DELIVERED',
          'DELIVERED',
          'DELIVERED',
          'DELIVERED',
        ]);
        const delivered = calls
          .filter(
            (c) =>
              !c.messages.some((m) => m.waMessageId === 'wamid.2' && m.mediaId),
          )
          .flatMap((c) => c.messages);
        const degraded = delivered.find((m) => m.waMessageId === 'wamid.2');
        expect(degraded).toMatchObject({ type: 'UNSUPPORTED', kind: 'OTHER' });
        expect(degraded?.mediaId).toBeUndefined();
        expect(degraded?.text).toBeUndefined();
        // the good photo of the same batch still goes out as an image
        expect(
          delivered.find((m) => m.waMessageId === 'wamid.4'),
        ).toMatchObject({ type: 'IMAGE', mediaId: MEDIA_ID });
        expect(calls.length).toBeLessThanOrEqual(30);
      });

      it('a single row at the cap is mirrored as UNSUPPORTED OTHER, never DEAD', async () => {
        const { delivery } = build(failing(['wamid.1']));
        const results = await delivery.deliverBatch([
          withAttempts(1, imagePayload('wamid.1'), 7),
        ]);
        expect(results).toEqual([{ outcome: 'DELIVERED' }]);
      });

      it('rows after a below-cap offender are RETRY too (backend seq order is kept)', async () => {
        const { delivery, calls } = build(failing(['wamid.2', 'wamid.3']));
        const results = await delivery.deliverBatch([
          rowEntry(1, textPayload('wamid.1')),
          withAttempts(2, imagePayload('wamid.2'), 0),
          withAttempts(3, imagePayload('wamid.3'), 3),
        ]);
        expect(outcomes(results)).toEqual(['DELIVERED', 'RETRY', 'RETRY']);
        const sentLast = calls.flatMap((c) => c.messages);
        expect(
          calls
            .filter((c) => c.messages.some((m) => m.waMessageId === 'wamid.3'))
            .every((c) => c.messages.some((m) => m.waMessageId === 'wamid.2')),
        ).toBe(true);
        expect(sentLast.length).toBeGreaterThan(0);
      });

      it('the lane is not blocked afterwards: the row retries, is mirrored as UNSUPPORTED, and a later row of the lane is delivered', async () => {
        const { delivery } = build(failing(['wamid.1']));
        const attempts = [0, 1, 2, 3];
        const seen: string[] = [];
        for (const attempt of attempts) {
          const [result] = await delivery.deliverBatch([
            withAttempts(1, imagePayload('wamid.1'), attempt),
          ]);
          seen.push(result.outcome);
        }
        expect(seen).toEqual(['RETRY', 'RETRY', 'RETRY', 'DELIVERED']);
        const later = await delivery.deliverBatch([
          rowEntry(2, textPayload('wamid.2')),
        ]);
        expect(outcomes(later)).toEqual(['DELIVERED']);
        expect(seen).not.toContain('PERMANENT');
      });

      it('finds the offender among 50 media rows inside the 30-call budget', async () => {
        const entries = Array.from({ length: 50 }, (_, i) =>
          withAttempts(
            i + 1,
            imagePayload(`wamid.${i + 1}`),
            i + 1 === 37 ? 3 : 0,
          ),
        );
        const { delivery, calls } = build(failing(['wamid.37']));
        const results = await delivery.deliverBatch(entries);
        expect(outcomes(results)).toEqual(entries.map(() => 'DELIVERED'));
        expect(calls.length).toBeLessThanOrEqual(30);
      });

      it('logs a masked warning: no phone, no wamid', async () => {
        const { delivery } = build(failing(['wamid.2']));
        await delivery.deliverBatch([
          withAttempts(2, imagePayload('wamid.2'), 3),
        ]);
        expect(warnLog).toHaveBeenCalledTimes(1);
        const text = String((warnLog.mock.calls as unknown[][])[0][0]);
        expect(text).toContain('wa:…1111');
        expect(text).not.toContain('5550001111');
        expect(text).not.toContain('wamid');
        expect(text).toContain('UNSUPPORTED');
      });
    });

    it('MEDIA_NOT_FOUND where the forced upload says unsupported mirrors that row as UNSUPPORTED', async () => {
      let first = true;
      const { delivery, calls } = build(
        (call) => {
          if (first) {
            first = false;
            return { kind: 'MEDIA_NOT_FOUND' };
          }
          return okAck(call.messages);
        },
        (_m, _t, options) =>
          options.force
            ? { kind: 'unsupported', reason: 'media_unavailable' }
            : okMedia(),
      );
      const results = await delivery.deliverBatch([
        rowEntry(1, imagePayload('wamid.1')),
      ]);
      expect(outcomes(results)).toEqual(['DELIVERED']);
      expect(calls[1].messages[0]).toMatchObject({
        type: 'UNSUPPORTED',
        kind: 'OTHER',
      });
      expect(calls[1].messages[0].mediaId).toBeUndefined();
    });

    it('MEDIA_NOT_FOUND where the forced upload asks to retry → RETRY the batch with that delay', async () => {
      const { delivery } = build(
        () => ({ kind: 'MEDIA_NOT_FOUND' }),
        (_m, _t, options) =>
          options.force
            ? { kind: 'retry', cause: 'rate_limited', retryAfterSeconds: 30 }
            : okMedia(),
      );
      const results = await delivery.deliverBatch([
        rowEntry(1, imagePayload('wamid.1')),
      ]);
      expect(results[0]).toMatchObject({
        outcome: 'RETRY',
        retryAfterMs: 30_000,
      });
    });

    describe('422 REPLY_NOT_FOUND (unit 10)', () => {
      const REPLY = '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09';
      const REPLY_2 = '9a1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a0a';
      const reply = (seq: number, id: string) =>
        rowEntry(
          seq,
          textPayload(`wamid.${seq}`, {
            direction: 'OUT',
            author: 'BOT',
            staffReplyId: id,
          }),
        );
      const hasReply = (call: Call) =>
        call.messages.some((m) => m.staffReplyId !== undefined);

      it('sends staffReplyId and DELIVERs when the backend accepts it', async () => {
        const { delivery, calls } = build();
        const results = await delivery.deliverBatch([reply(1, REPLY)]);
        expect(outcomes(results)).toEqual(['DELIVERED']);
        expect(calls[0].messages[0].staffReplyId).toBe(REPLY);
      });

      it('resends the offender WITHOUT staffReplyId (never DEAD) and keeps the rest', async () => {
        const { delivery, calls } = build((call) =>
          hasReply(call) ? { kind: 'REPLY_NOT_FOUND' } : okAck(call.messages),
        );
        const entries = [...texts(3), reply(4, REPLY), ...texts(3, 5)];
        const results = await delivery.deliverBatch(entries);
        expect(outcomes(results)).toEqual(Array(7).fill('DELIVERED'));
        expect(calls).toHaveLength(2);
        expect(calls[1].messages).toHaveLength(7);
        expect(hasReply(calls[1])).toBe(false);
        // our own text is still mirrored (as BOT)
        expect(calls[1].messages[3].text).toBe('texto wamid.4');
        expect(warnLog).toHaveBeenCalledWith(contains('REPLY_NOT_FOUND'));
        const logged = JSON.stringify(warnLog.mock.calls);
        expect(logged).not.toContain('5215550001111');
        expect(logged).not.toContain(REPLY);
      });

      it('with two staff replies and only one unknown, bisects and strips just that one', async () => {
        const { delivery, calls } = build((call) =>
          call.messages.some((m) => m.staffReplyId === REPLY_2)
            ? { kind: 'REPLY_NOT_FOUND' }
            : okAck(call.messages),
        );
        const entries = [reply(1, REPLY), ...texts(2, 2), reply(4, REPLY_2)];
        const results = await delivery.deliverBatch(entries);
        expect(outcomes(results)).toEqual(Array(4).fill('DELIVERED'));
        const last = calls[calls.length - 1];
        const sentIds = calls
          .flatMap((c) => c.messages)
          .filter((m) => m.staffReplyId !== undefined)
          .map((m) => m.staffReplyId);
        expect(sentIds).toContain(REPLY);
        expect(last.messages.some((m) => m.staffReplyId === REPLY_2)).toBe(
          false,
        );
      });

      it('a REPLY_NOT_FOUND with no staffReplyId in the batch is not a DEAD row (RETRY)', async () => {
        const { delivery } = build(() => ({ kind: 'REPLY_NOT_FOUND' }));
        const results = await delivery.deliverBatch(texts(2));
        expect(outcomes(results)).toEqual(['RETRY', 'RETRY']);
      });
    });

    describe.each([
      ['422 MEDIA_TYPE_MISMATCH', { kind: 'MEDIA_TYPE_MISMATCH' } as const],
      ['409 MESSAGE_ID_CONFLICT', { kind: 'MESSAGE_ID_CONFLICT' } as const],
      [
        '400 VALIDATION_ERROR',
        { kind: 'VALIDATION_ERROR', message: 'x', local: false } as const,
      ],
    ])('%s isolates the offender', (label, failure) => {
      it('a single row is DEAD', async () => {
        const { delivery } = build(() => failure);
        const [result] = await delivery.deliverBatch(texts(1));
        expect(result).toMatchObject({
          outcome: 'PERMANENT',
          error: contains(label.split(' ')[0]),
        });
      });

      it('bisects 8 rows to the one offender, DEADs only it and delivers the rest', async () => {
        const bad = ['wamid.6'];
        const { delivery, calls } = build((call) =>
          containsBad(call, bad) ? failure : okAck(call.messages),
        );
        const results = await delivery.deliverBatch(texts(8));
        expect(outcomes(results)).toEqual([
          'DELIVERED',
          'DELIVERED',
          'DELIVERED',
          'DELIVERED',
          'DELIVERED',
          'PERMANENT',
          'DELIVERED',
          'DELIVERED',
        ]);
        // 1 full call + probes: bounded by 2·log2(8) extra calls.
        expect(calls.length).toBeLessThanOrEqual(1 + 2 * 3);
        const delivered = calls
          .filter((c) => !containsBad(c, bad))
          .flatMap((c) => c.messages.map((m) => m.waMessageId));
        expect(delivered.sort()).toEqual([
          'wamid.1',
          'wamid.2',
          'wamid.3',
          'wamid.4',
          'wamid.5',
          'wamid.7',
          'wamid.8',
        ]);
      });

      it('isolates two offenders in a 50-row batch within a bounded number of calls', async () => {
        const bad = ['wamid.7', 'wamid.44'];
        const { delivery, calls } = build((call) =>
          containsBad(call, bad) ? failure : okAck(call.messages),
        );
        const results = await delivery.deliverBatch(texts(50));
        expect(results.filter((r) => r.outcome === 'PERMANENT')).toHaveLength(
          2,
        );
        expect(results.filter((r) => r.outcome === 'DELIVERED')).toHaveLength(
          48,
        );
        expect(results[6].outcome).toBe('PERMANENT');
        expect(results[43].outcome).toBe('PERMANENT');
        expect(calls.length).toBeLessThanOrEqual(30);
      });
    });

    it('stops isolating when the call budget is spent: the unresolved rows RETRY, nothing else dies', async () => {
      const { delivery, calls } = build(() => ({
        kind: 'VALIDATION_ERROR',
        message: 'x',
        local: false,
      }));
      const results = await delivery.deliverBatch(texts(50));
      expect(calls.length).toBeLessThanOrEqual(30);
      const retried = results.filter((r) => r.outcome === 'RETRY');
      expect(retried.length).toBeGreaterThan(0);
      expect(retried[0]).toMatchObject({
        error: contains('budget'),
      });
    });

    it.each([
      ['401', { kind: 'UNAUTHORIZED' } as const],
      ['403', { kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' } as const],
    ])(
      '%s STOPs: no row is killed, RETRY with a long backoff, ONE alert, other batches wait',
      async (_l, failure) => {
        let now = 1_000_000;
        const { delivery, mirrorMessages } = build(() => failure, undefined, {
          clock: () => now,
        });
        const first = await delivery.deliverBatch(texts(3));
        expect(first.every((r) => r.outcome === 'RETRY')).toBe(true);
        expect(first[0]).toMatchObject({ retryAfterMs: 15 * 60_000 });
        expect(mirrorMessages).toHaveBeenCalledTimes(1);
        // Another conversation's batch does not even hit the backend.
        const second = await delivery.deliverBatch(texts(2, 10));
        expect(second.every((r) => r.outcome === 'RETRY')).toBe(true);
        expect(mirrorMessages).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledTimes(1);
        now += 15 * 60_000 + 1;
      },
    );

    it('401 in the middle of an isolation keeps what was already delivered and retries the rest', async () => {
      const { delivery } = build((call, index) =>
        index === 0
          ? { kind: 'VALIDATION_ERROR', message: 'x', local: false }
          : index === 1
            ? okAck(call.messages)
            : { kind: 'UNAUTHORIZED' },
      );
      const results = await delivery.deliverBatch(texts(4));
      expect(outcomes(results)).toEqual([
        'DELIVERED',
        'DELIVERED',
        'RETRY',
        'RETRY',
      ]);
    });

    it('429 RETRYs the batch with Retry-After and stops calling', async () => {
      const { delivery, calls } = build(() => ({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 7,
      }));
      const results = await delivery.deliverBatch(texts(3));
      expect(results).toEqual(
        Array(3).fill({
          outcome: 'RETRY',
          error: contains('429'),
          retryAfterMs: 7000,
        }),
      );
      expect(calls).toHaveLength(1);
    });

    it('429 without Retry-After leaves the delay to the worker backoff', async () => {
      const { delivery } = build(() => ({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: null,
      }));
      const [result] = await delivery.deliverBatch(texts(1));
      expect(result).toEqual({
        outcome: 'RETRY',
        error: contains('429'),
      });
    });

    it.each([
      [
        'timeout',
        {
          kind: 'RETRYABLE',
          cause: 'timeout',
          status: null,
          retryAfterSeconds: null,
        } as const,
      ],
      [
        'network',
        {
          kind: 'RETRYABLE',
          cause: 'network',
          status: null,
          retryAfterSeconds: null,
        } as const,
      ],
      [
        '5xx',
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 503,
          retryAfterSeconds: 4,
        } as const,
      ],
    ])('%s retries the same body', async (_l, failure) => {
      const { delivery, calls } = build(() => failure);
      const results = await delivery.deliverBatch(texts(3));
      expect(results.every((r) => r.outcome === 'RETRY')).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it('an undocumented answer never kills rows: RETRY with a long backoff and an alert', async () => {
      const { delivery } = build(() => ({
        kind: 'UNEXPECTED',
        status: 404,
        code: null,
      }));
      const results = await delivery.deliverBatch(texts(2));
      expect(results).toEqual(
        Array(2).fill({
          outcome: 'RETRY',
          error: contains('404'),
          retryAfterMs: 15 * 60_000,
        }),
      );
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it('an aborted signal returns the unfinished rows as RETRY without more calls', async () => {
      const controller = new AbortController();
      const { delivery, calls } = build((call, index) => {
        if (index === 0) {
          controller.abort();
          return { kind: 'VALIDATION_ERROR', message: 'x', local: false };
        }
        return okAck(call.messages);
      });
      const results = await delivery.deliverBatch(texts(8), {
        signal: controller.signal,
      });
      expect(calls).toHaveLength(1);
      expect(results.every((r) => r.outcome === 'RETRY')).toBe(true);
    });
  });

  describe('handoff hint (live conversation T7, rule 9)', () => {
    const buildWithHint = (
      answer: Partial<{ mode: 'BOT' | 'HUMAN'; handoffEpoch: number }>,
      onHandoffHint: jest.Mock,
    ) => {
      const mirrorMessages = jest.fn(
        (_ref: string, messages: Array<{ waMessageId: string }>) =>
          Promise.resolve({ ...okAck(messages), ...answer }),
      );
      const delivery = new MirrorMessagesDelivery({
        client: { mirrorMessages } as never,
        media: { resolveMedia: jest.fn() },
        gate: new MirrorDeliveryGate({ random: () => 0 }),
        clock: () => NOW,
        onHandoffHint,
      });
      return { delivery, mirrorMessages };
    };

    it('hands the answered {mode, handoffEpoch} of an ok batch to the hook, with the conversation ref', async () => {
      const onHandoffHint = jest.fn();
      const { delivery } = buildWithHint(
        { mode: 'HUMAN', handoffEpoch: 4 },
        onHandoffHint,
      );
      const results = await delivery.deliverBatch(texts(2));
      expect(outcomes(results)).toEqual(['DELIVERED', 'DELIVERED']);
      expect(onHandoffHint).toHaveBeenCalledTimes(1);
      expect(onHandoffHint).toHaveBeenCalledWith(REF, {
        mode: 'HUMAN',
        handoffEpoch: 4,
      });
    });

    it('calls nothing when the answer carries no hint, and never without a hook', async () => {
      const onHandoffHint = jest.fn();
      const { delivery } = buildWithHint({}, onHandoffHint);
      await delivery.deliverBatch(texts(1));
      expect(onHandoffHint).not.toHaveBeenCalled();
      const plain = build();
      await expect(
        plain.delivery.deliverBatch(texts(1)),
      ).resolves.toBeDefined();
    });

    it('does not call it for a failed batch', async () => {
      const onHandoffHint = jest.fn();
      const mirrorMessages = jest.fn(() =>
        Promise.resolve({ kind: 'UNAUTHORIZED' as const }),
      );
      const delivery = new MirrorMessagesDelivery({
        client: { mirrorMessages },
        media: { resolveMedia: jest.fn() },
        gate: new MirrorDeliveryGate({ random: () => 0 }),
        clock: () => NOW,
        onHandoffHint,
      });
      await delivery.deliverBatch(texts(1));
      expect(onHandoffHint).not.toHaveBeenCalled();
    });

    it('a throwing hook never changes the delivery outcome', async () => {
      const onHandoffHint = jest.fn(() => {
        throw new Error('hook down');
      });
      const { delivery } = buildWithHint(
        { mode: 'BOT', handoffEpoch: 1 },
        onHandoffHint,
      );
      const results = await delivery.deliverBatch(texts(2));
      expect(outcomes(results)).toEqual(['DELIVERED', 'DELIVERED']);
    });
  });

  it('S6: neither results nor logs carry the phone or the conversationRef', async () => {
    const { delivery } = build(
      () => ({ kind: 'UNEXPECTED', status: 500, code: 'X' }),
      () => ({ kind: 'park', reason: 'invalid_payload' }),
    );
    const results = [
      ...(await delivery.deliverBatch([rowEntry(1, imagePayload('wamid.1'))])),
      ...(await delivery.deliverBatch([rowEntry(2, { broken: true })])),
    ];
    const everything = JSON.stringify([
      results,
      errorLog.mock.calls,
      warnLog.mock.calls,
    ]);
    expect(everything).not.toContain('5215550001111');
    expect(everything).not.toContain(REF);
  });
});

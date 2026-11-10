import { Logger } from '@nestjs/common';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { InMemoryBackendOutboxStore } from '../../backend-outbox/infrastructure/in-memory-backend-outbox.store';
import type { InboundMessage } from '../../whatsapp/domain/inbound-message';
import { InMemoryTranscriptStore } from '../infrastructure/in-memory-transcript.store';
import { TranscriptRecorder } from './transcript-recorder';

/** S1→S2: every inserted transcript row is mirrored through the outbox. */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-09T16:02:12.345Z');

const inbound: InboundMessage = {
  senderId: SENDER,
  text: 'hola',
  messageId: 'wamid.in-1',
  timestamp: '2026-11-09T16:02:11.000Z',
};

const mirrors = (outbox: InMemoryBackendOutboxStore) =>
  outbox
    .snapshot()
    .map(({ conversationRef, kind, idempotencyKey, payload }) => ({
      conversationRef,
      kind,
      idempotencyKey,
      payload,
    }));

describe('TranscriptRecorder mirror (S1→S2)', () => {
  let store: InMemoryTranscriptStore;
  let outbox: InMemoryBackendOutboxStore;
  let recorder: TranscriptRecorder;

  beforeEach(() => {
    store = new InMemoryTranscriptStore();
    outbox = new InMemoryBackendOutboxStore();
    recorder = new TranscriptRecorder(
      store,
      () => NOW,
      new BackendOutboxService(outbox),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('an inserted inbound enqueues exactly one MESSAGE_MIRROR with the stored values', async () => {
    await recorder.recordInbound(inbound, 'text');
    expect(mirrors(outbox)).toEqual([
      {
        conversationRef: `wa:${SENDER}`,
        kind: 'MESSAGE_MIRROR',
        idempotencyKey: 'mirror:wamid.in-1',
        payload: {
          waMessageId: 'wamid.in-1',
          direction: 'IN',
          author: 'CUSTOMER',
          type: 'text',
          text: 'hola',
          providerTimestamp: '2026-11-09T16:02:11.000Z',
          observedAt: '2026-11-09T16:02:12.345Z',
        },
      },
    ]);
  });

  it('an inbound document mirrors its provider media reference', async () => {
    await recorder.recordInbound(
      {
        ...inbound,
        messageId: 'wamid.doc',
        text: '',
        media: {
          kind: 'document',
          providerMediaId: 'media-9',
          declaredMimeType: 'application/pdf',
          filename: 'pago.pdf',
          sha256: 'abc',
        },
      },
      'document',
    );
    expect(mirrors(outbox)[0].payload).toEqual({
      waMessageId: 'wamid.doc',
      direction: 'IN',
      author: 'CUSTOMER',
      type: 'document',
      media: {
        providerMediaId: 'media-9',
        mimeType: 'application/pdf',
        filename: 'pago.pdf',
      },
      providerTimestamp: '2026-11-09T16:02:11.000Z',
      observedAt: '2026-11-09T16:02:12.345Z',
    });
  });

  it('an inserted outbound enqueues one OUT/BOT mirror without a provider time', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-1',
      type: 'image',
      text: 'Aquí está',
      media: { link: 'https://cdn.example.com/p.jpg' },
      details: { template: 'x' },
    });
    expect(mirrors(outbox)).toEqual([
      {
        conversationRef: `wa:${SENDER}`,
        kind: 'MESSAGE_MIRROR',
        idempotencyKey: 'mirror:wamid.out-1',
        payload: {
          waMessageId: 'wamid.out-1',
          direction: 'OUT',
          author: 'BOT',
          type: 'image',
          text: 'Aquí está',
          media: { link: 'https://cdn.example.com/p.jpg' },
          observedAt: '2026-11-09T16:02:12.345Z',
        },
      },
    ]);
  });

  it('a duplicate wamid enqueues nothing', async () => {
    await recorder.recordInbound(inbound, 'text');
    await recorder.recordInbound(inbound, 'text');
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.in-1',
      type: 'text',
      text: 'otra',
    });
    expect(outbox.snapshot()).toHaveLength(1);
  });

  it('an invalid message is neither recorded nor mirrored', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await recorder.recordInbound({ ...inbound, senderId: 'abc' }, 'text');
    expect(outbox.snapshot()).toEqual([]);
  });

  it('a failed enqueue rolls the inbound row back and fails the record (Meta redelivers)', async () => {
    const failing = new TranscriptRecorder(store, () => NOW, {
      enqueue: () => Promise.reject(new Error('outbox down')),
    });
    await expect(failing.recordInbound(inbound, 'text')).rejects.toThrow(
      'outbox down',
    );
    await expect(store.listRecent(SENDER, 5)).resolves.toEqual([]);
    // Meta's re-delivery then records and mirrors it once.
    await recorder.recordInbound(inbound, 'text');
    await expect(store.listRecent(SENDER, 5)).resolves.toHaveLength(1);
    expect(outbox.snapshot()).toHaveLength(1);
  });

  it('a failed outbound enqueue rolls the row back and only warns', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const failing = new TranscriptRecorder(store, () => NOW, {
      enqueue: () => Promise.reject(new Error('outbox down')),
    });
    await expect(
      failing.recordOutbound({
        to: SENDER,
        providerMessageId: 'wamid.out-x',
        type: 'text',
        text: 'hola',
      }),
    ).resolves.toBeUndefined();
    await expect(store.listRecent(SENDER, 5)).resolves.toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain('outbox down');
  });

  it('without an outbox the recorder only writes the transcript', async () => {
    const plain = new TranscriptRecorder(store, () => NOW);
    await plain.recordInbound(inbound, 'text');
    await expect(store.listRecent(SENDER, 5)).resolves.toHaveLength(1);
  });
});

describe('TranscriptRecorder mirror DI', () => {
  it('injects the outbox by its class token', () => {
    const tokens = Reflect.getMetadata(
      'self:paramtypes',
      TranscriptRecorder,
    ) as Array<{ index: number; param: unknown }>;
    expect(tokens).toContainEqual({ index: 2, param: BackendOutboxService });
  });
});

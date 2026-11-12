import { Logger } from '@nestjs/common';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { InMemoryBackendOutboxStore } from '../../backend-outbox/infrastructure/in-memory-backend-outbox.store';
import type { InboundMessage } from '../../whatsapp/domain/inbound-message';
import { InMemoryTranscriptStore } from '../infrastructure/in-memory-transcript.store';
import { mirrorPayload, TranscriptRecorder } from './transcript-recorder';

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
          contractType: 'TEXT',
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
      contractType: 'DOCUMENT',
      media: {
        providerMediaId: 'media-9',
        mimeType: 'application/pdf',
        filename: 'pago.pdf',
      },
      providerTimestamp: '2026-11-09T16:02:11.000Z',
      observedAt: '2026-11-09T16:02:12.345Z',
    });
  });

  it('an inserted outbound enqueues one OUT/BOT mirror stamped with the time Meta accepted it', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-1',
      type: 'image',
      text: 'Aquí está',
      media: { link: 'https://cdn.example.com/p.jpg' },
      details: { template: 'x' },
      acceptedAt: new Date('2026-11-09T16:02:12.100Z'),
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
          contractType: 'IMAGE',
          text: 'Aquí está',
          media: { link: 'https://cdn.example.com/p.jpg' },
          providerTimestamp: '2026-11-09T16:02:12.100Z',
          observedAt: '2026-11-09T16:02:12.345Z',
        },
      },
    ]);
  });

  it('an outbound without an acceptance time falls back to the recorder clock', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-2',
      type: 'text',
      text: 'hola',
    });
    expect(mirrors(outbox)[0].payload).toMatchObject({
      providerTimestamp: '2026-11-09T16:02:12.345Z',
    });
  });

  it('an outbound text sent for a staff reply mirrors staffReplyId (that row only)', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-reply',
      type: 'text',
      text: 'Le comparto la respuesta del equipo:\nSí',
      details: { staffReplyId: '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09' },
      acceptedAt: new Date('2026-11-09T16:02:12.100Z'),
    });
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-plain',
      type: 'text',
      text: 'otro',
    });
    const [reply, plain] = mirrors(outbox).map((m) => m.payload);
    expect(reply).toMatchObject({
      staffReplyId: '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09',
      direction: 'OUT',
    });
    expect(plain).not.toHaveProperty('staffReplyId');
  });

  it('staffReplyId is never mirrored for an inbound or a non-text outbound', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-img',
      type: 'image',
      media: { link: 'https://cdn.example.com/a.jpg' },
      details: { staffReplyId: '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09' },
    });
    expect(mirrors(outbox)[0].payload).not.toHaveProperty('staffReplyId');
  });

  it('an interactive outbound mirrors its body plus the offered option titles', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-int',
      type: 'interactive',
      text: '¿Confirma su pedido?',
      details: {
        interactive: { type: 'button' },
        options: ['Sí', 'No', 'Hablar con alguien'],
      },
      acceptedAt: new Date('2026-11-09T16:02:12.100Z'),
    });
    expect(mirrors(outbox)[0].payload).toEqual({
      waMessageId: 'wamid.out-int',
      direction: 'OUT',
      author: 'BOT',
      type: 'interactive',
      contractType: 'TEXT',
      text: '¿Confirma su pedido?',
      options: ['Sí', 'No', 'Hablar con alguien'],
      providerTimestamp: '2026-11-09T16:02:12.100Z',
      observedAt: '2026-11-09T16:02:12.345Z',
    });
  });

  it('a template outbound maps to the TEMPLATE contract type', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-tpl',
      type: 'template',
      details: { templateName: 'order_ready' },
    });
    expect(mirrors(outbox)[0].payload).toMatchObject({
      type: 'template',
      contractType: 'TEMPLATE',
    });
  });

  it('an inbound button reply mirrors the title the customer saw, keeping the reply id as a detail', async () => {
    await recorder.recordInbound(
      {
        ...inbound,
        messageId: 'wamid.btn',
        text: 'SÍ',
        interactiveReplyId: 'order_confirm:r1',
        interactiveReplyTitle: 'Sí, confirmar',
      },
      'interactive',
    );
    expect(mirrors(outbox)[0].payload).toMatchObject({
      type: 'interactive',
      contractType: 'TEXT',
      text: 'Sí, confirmar',
    });
    const [row] = await store.listRecent(SENDER, 5);
    expect(row.details).toEqual({ replyId: 'order_confirm:r1' });
  });

  it.each([
    ['audio', 'AUDIO', { providerMediaId: 'm1', mimeType: 'audio/ogg' }],
    ['sticker', 'STICKER', { providerMediaId: 'm2', mimeType: 'image/webp' }],
  ] as const)(
    'a mirror-only %s keeps its Meta media reference',
    async (type, contractType, media) => {
      await recorder.recordInbound(
        {
          ...inbound,
          messageId: `wamid.${type}`,
          text: '',
          mirrorOnly: { type, ...media },
        },
        type,
      );
      expect(mirrors(outbox)[0].payload).toEqual({
        waMessageId: `wamid.${type}`,
        direction: 'IN',
        author: 'CUSTOMER',
        type,
        contractType,
        media,
        providerTimestamp: '2026-11-09T16:02:11.000Z',
        observedAt: '2026-11-09T16:02:12.345Z',
      });
    },
  );

  it.each([
    ['video', 'VIDEO'],
    ['location', 'LOCATION'],
  ] as const)(
    'a mirror-only %s is an UNSUPPORTED marker without text or media',
    async (type, unsupportedKind) => {
      await recorder.recordInbound(
        {
          ...inbound,
          messageId: `wamid.${type}`,
          text: '',
          mirrorOnly: { type },
        },
        type,
      );
      expect(mirrors(outbox)[0].payload).toEqual({
        waMessageId: `wamid.${type}`,
        direction: 'IN',
        author: 'CUSTOMER',
        type,
        contractType: 'UNSUPPORTED',
        unsupportedKind,
        providerTimestamp: '2026-11-09T16:02:11.000Z',
        observedAt: '2026-11-09T16:02:12.345Z',
      });
    },
  );

  it('infers the type of a mirror-only message when no raw type is given', async () => {
    await recorder.recordInbound({
      ...inbound,
      messageId: 'wamid.v',
      text: '',
      mirrorOnly: { type: 'video' },
    });
    const [row] = await store.listRecent(SENDER, 5);
    expect(row.type).toBe('video');
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

describe('mirrorPayload backward compatibility', () => {
  it('still serializes a row written before the new fields (media object, no options)', () => {
    expect(
      mirrorPayload({
        senderId: SENDER,
        waMessageId: 'wamid.old',
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'image',
        text: null,
        media: { providerMediaId: 'm', mimeType: 'image/jpeg' },
        details: null,
        providerTimestamp: null,
        observedAt: '2026-11-09T16:02:12.345Z',
        purgeAfter: '2027-11-09T16:02:12.345Z',
      }),
    ).toEqual({
      waMessageId: 'wamid.old',
      direction: 'IN',
      author: 'CUSTOMER',
      type: 'image',
      contractType: 'IMAGE',
      media: { providerMediaId: 'm', mimeType: 'image/jpeg' },
      observedAt: '2026-11-09T16:02:12.345Z',
    });
  });

  it('maps an unknown provider type to UNSUPPORTED/OTHER', () => {
    const payload = mirrorPayload({
      senderId: SENDER,
      waMessageId: 'wamid.x',
      direction: 'IN',
      author: 'CUSTOMER',
      type: 'reaction',
      text: null,
      media: null,
      details: null,
      providerTimestamp: null,
      observedAt: '2026-11-09T16:02:12.345Z',
      purgeAfter: '2027-11-09T16:02:12.345Z',
    });
    expect(payload).toMatchObject({
      contractType: 'UNSUPPORTED',
      unsupportedKind: 'OTHER',
    });
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

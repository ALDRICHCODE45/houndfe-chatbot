import type { InboundMessage } from '../../whatsapp/domain/inbound-message';
import type { ConversationTranscriptStore } from '../domain/transcript.port';
import { InMemoryTranscriptStore } from '../infrastructure/in-memory-transcript.store';
import { TranscriptRecorder } from './transcript-recorder';

const SENDER = '5215550001111';
const NOW = new Date('2026-11-09T16:02:12.345Z');

const text: InboundMessage = {
  senderId: SENDER,
  text: 'hola',
  messageId: 'wamid.in-1',
  timestamp: '2026-11-09T16:02:11.000Z',
};

describe('TranscriptRecorder', () => {
  let store: InMemoryTranscriptStore;
  let recorder: TranscriptRecorder;

  beforeEach(() => {
    store = new InMemoryTranscriptStore();
    recorder = new TranscriptRecorder(store, () => NOW);
  });

  it('records a customer text with the Meta time and the observation time', async () => {
    await recorder.recordInbound(text, 'text');
    await expect(store.listRecent(SENDER, 5)).resolves.toEqual([
      {
        senderId: SENDER,
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
      },
    ]);
  });

  it('records media references and tapped reply ids', async () => {
    await recorder.recordInbound(
      {
        ...text,
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
    await recorder.recordInbound(
      {
        ...text,
        messageId: 'wamid.tap',
        text: 'SÍ',
        interactiveReplyId: 'confirm_yes',
      },
      'interactive',
    );
    const [doc, tap] = await store.listRecent(SENDER, 5);
    expect(doc).toMatchObject({
      type: 'document',
      text: null,
      media: {
        providerMediaId: 'media-9',
        mimeType: 'application/pdf',
        filename: 'pago.pdf',
      },
    });
    expect(tap).toMatchObject({
      type: 'interactive',
      text: 'SÍ',
      details: { replyId: 'confirm_yes' },
    });
  });

  it('derives the type when the raw one is unknown', async () => {
    await recorder.recordInbound({ ...text, interactiveReplyId: 'x' });
    await expect(store.listRecent(SENDER, 1)).resolves.toMatchObject([
      { type: 'interactive' },
    ]);
  });

  it('records a bot outbound message', async () => {
    await recorder.recordOutbound({
      to: SENDER,
      providerMessageId: 'wamid.out-1',
      type: 'template',
      details: { templateName: 'order_ready', languageCode: 'es_MX' },
    });
    await expect(store.listRecent(SENDER, 1)).resolves.toMatchObject([
      {
        waMessageId: 'wamid.out-1',
        direction: 'OUT',
        author: 'BOT',
        type: 'template',
        providerTimestamp: null,
        observedAt: '2026-11-09T16:02:12.345Z',
      },
    ]);
  });

  it('a failing store fails an inbound record so Meta redelivers it', async () => {
    const failing: ConversationTranscriptStore = {
      append: () => Promise.reject(new Error('db down')),
      listRecent: () => Promise.resolve([]),
      purgeExpired: () => Promise.resolve(0),
    };
    const broken = new TranscriptRecorder(failing, () => NOW);
    await expect(broken.recordInbound(text, 'text')).rejects.toThrow('db down');
  });

  it('outbound stays best effort: a failing store only warns', async () => {
    const failing: ConversationTranscriptStore = {
      append: () => Promise.reject(new Error('db down')),
      listRecent: () => Promise.resolve([]),
      purgeExpired: () => Promise.resolve(0),
    };
    const broken = new TranscriptRecorder(failing, () => NOW);
    const warn = jest
      .spyOn(broken['logger'], 'warn')
      .mockImplementation(() => undefined);
    await expect(
      broken.recordOutbound({
        to: SENDER,
        providerMessageId: 'w',
        type: 'text',
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('db down');
  });

  it('rejects a sender that is not a wa_id clearly, without throwing (a redelivery could never succeed)', async () => {
    const warn = jest
      .spyOn(recorder['logger'], 'warn')
      .mockImplementation(() => undefined);
    await expect(
      recorder.recordInbound({ ...text, senderId: 'not-a-wa-id' }, 'text'),
    ).resolves.toBeUndefined();
    await expect(
      recorder.recordOutbound({
        to: '+52 1',
        providerMessageId: 'w2',
        type: 'text',
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('not a WhatsApp wa_id');
  });

  it('an invalid message (not a store failure) only warns, inbound included', async () => {
    const warn = jest
      .spyOn(recorder['logger'], 'warn')
      .mockImplementation(() => undefined);
    await expect(
      recorder.recordInbound({ ...text, messageId: '' }, 'text'),
    ).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toContain('waMessageId');
  });
});

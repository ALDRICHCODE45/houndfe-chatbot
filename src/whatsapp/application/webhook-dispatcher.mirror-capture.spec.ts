import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { InMemoryBackendOutboxStore } from '../../backend-outbox/infrastructure/in-memory-backend-outbox.store';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { TranscriptRecorder } from '../../conversation-transcript/application/transcript-recorder';
import { InMemoryTranscriptStore } from '../../conversation-transcript/infrastructure/in-memory-transcript.store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { AUDIO_UNSUPPORTED_REPLY } from '../domain/inbound-reply-copy';
import {
  normalizeInboundMessages,
  WebhookDispatcherService,
} from './webhook-dispatcher.service';

/** T2: every inbound type reaches the transcript and the MESSAGE_MIRROR outbox. */
const SENDER = '5215550001111';
const OPS = '5215500000000';
const NOW = new Date('2026-11-12T10:00:05.000Z');
const META_TS = '1719000000';
const META_ISO = '2024-06-21T20:00:00.000Z';

const event = (messages: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages } }] }],
  }) as WebhookEventDto;

const base = (id: string, from = SENDER) => ({
  id,
  from,
  timestamp: META_TS,
});

function setup(options: { human?: boolean; style?: 'usted' | 'tu' } = {}) {
  const transcript = new InMemoryTranscriptStore();
  const outbox = new InMemoryBackendOutboxStore();
  const recorder = new TranscriptRecorder(
    transcript,
    () => NOW,
    new BackendOutboxService(outbox),
  );
  const sender = {
    sendText: jest.fn(() =>
      Promise.resolve({ providerMessageId: 'wamid.out' }),
    ),
    sendTemplate: jest.fn(),
    sendImage: jest.fn(),
    sendInteractive: jest.fn(),
  };
  const agent = {
    prepareCustomer: jest.fn(() => Promise.resolve()),
    customerStyle: jest.fn(() => ({
      register: options.style ?? 'usted',
      emojis: false,
      tone: 'neutral',
    })),
    tryHandle: jest.fn(() => Promise.resolve({ reply: 'Hola' })),
  };
  const runner = { handle: jest.fn() };
  const handoff = {
    isOpsSender: (id: string) => id === OPS,
    resolveReply: jest.fn(() =>
      Promise.resolve({ kind: 'no_pending', reply: 'ref?' }),
    ),
  };
  const dedup = {
    claim: jest.fn(() => Promise.resolve('claim-token')),
    release: jest.fn(() => Promise.resolve()),
    purgeBefore: jest.fn(() => Promise.resolve(0)),
    markSeen: jest.fn(() => Promise.resolve()),
  };
  const ingress = { admit: jest.fn() };
  const productImage = { recognize: jest.fn() };
  const service = new WebhookDispatcherService(
    runner as unknown as AgentRunner,
    sender,
    dedup,
    { remember: jest.fn(), isKnown: () => false },
    handoff as unknown as HumanHandoffService,
    {
      get: jest.fn(() => Promise.resolve(null)),
    } as unknown as ConversationStore,
    ingress as unknown as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    productImage as never,
    recorder,
    undefined,
    { isHumanMode: jest.fn(() => Promise.resolve(options.human === true)) },
  );
  const mirrors = () => outbox.snapshot().map((entry) => entry.payload);
  return {
    service,
    transcript,
    outbox,
    sender,
    agent,
    runner,
    dedup,
    ingress,
    productImage,
    handoff,
    mirrors,
  };
}

describe('normalizeInboundMessages — mirror-only types (T2)', () => {
  it('normalizes a voice note with its Meta media id and mime type', () => {
    const [message] = normalizeInboundMessages(
      event([
        {
          ...base('wamid.audio'),
          type: 'audio',
          audio: {
            id: 'media-a',
            mime_type: 'audio/ogg; codecs=opus',
            voice: true,
          },
        },
      ]),
    );
    expect(message).toMatchObject({
      senderId: SENDER,
      messageId: 'wamid.audio',
      text: '',
      timestamp: META_ISO,
      mirrorOnly: {
        type: 'audio',
        providerMediaId: 'media-a',
        mimeType: 'audio/ogg; codecs=opus',
        voice: true,
      },
    });
    expect(message.media).toBeUndefined();
  });

  it('normalizes a sticker with its Meta media id and mime type', () => {
    const [message] = normalizeInboundMessages(
      event([
        {
          ...base('wamid.sticker'),
          type: 'sticker',
          sticker: { id: 'media-s', mime_type: 'image/webp' },
        },
      ]),
    );
    expect(message.mirrorOnly).toEqual({
      type: 'sticker',
      providerMediaId: 'media-s',
      mimeType: 'image/webp',
    });
  });

  it('normalizes video and location as markers without media', () => {
    const messages = normalizeInboundMessages(
      event([
        {
          ...base('wamid.video'),
          type: 'video',
          video: { id: 'v', mime_type: 'video/mp4' },
        },
        {
          ...base('wamid.loc'),
          type: 'location',
          location: { latitude: 19.4, longitude: -99.1 },
        },
      ]),
    );
    expect(messages.map((message) => message.mirrorOnly)).toEqual([
      { type: 'video' },
      { type: 'location' },
    ]);
  });

  it('drops an audio or sticker without a usable media id', () => {
    expect(
      normalizeInboundMessages(
        event([
          {
            ...base('wamid.a'),
            type: 'audio',
            audio: { mime_type: 'audio/ogg' },
          },
          { ...base('wamid.s'), type: 'sticker' },
        ]),
      ),
    ).toEqual([]);
  });

  it('keeps the title the customer saw for a tapped button or list row', () => {
    const messages = normalizeInboundMessages(
      event([
        {
          ...base('wamid.btn'),
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: 'order_confirm:ref1', title: 'Sí, confirmar' },
          },
        },
        {
          ...base('wamid.list'),
          type: 'interactive',
          interactive: {
            type: 'list_reply',
            list_reply: { id: 'pick_product:p1', title: 'Croquetas 1 kg' },
          },
        },
        {
          ...base('wamid.legacy'),
          type: 'button',
          button: { text: 'Quiero info', payload: 'x' },
        },
      ]),
    );
    expect(messages.map((m) => [m.text, m.interactiveReplyTitle])).toEqual([
      ['SÍ', 'Sí, confirmar'],
      ['Croquetas 1 kg', 'Croquetas 1 kg'],
      ['Quiero info', 'Quiero info'],
    ]);
  });
});

describe('WebhookDispatcherService mirror capture (T2)', () => {
  it('records and mirrors a voice note with its media reference, in BOT mode', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        {
          ...base('wamid.audio'),
          type: 'audio',
          audio: {
            id: 'media-a',
            mime_type: 'audio/ogg; codecs=opus',
            voice: true,
          },
        },
      ]),
    );
    const [row] = await h.transcript.listRecent(SENDER, 5);
    expect(row).toMatchObject({
      direction: 'IN',
      author: 'CUSTOMER',
      type: 'audio',
      text: null,
      media: { providerMediaId: 'media-a', mimeType: 'audio/ogg; codecs=opus' },
      providerTimestamp: META_ISO,
    });
    expect(h.mirrors()).toEqual([
      {
        waMessageId: 'wamid.audio',
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'audio',
        contractType: 'AUDIO',
        media: {
          providerMediaId: 'media-a',
          mimeType: 'audio/ogg; codecs=opus',
        },
        providerTimestamp: META_ISO,
        observedAt: NOW.toISOString(),
      },
    ]);
  });

  it('records and mirrors a sticker, video and location without a bot reply', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        {
          ...base('wamid.sticker'),
          type: 'sticker',
          sticker: { id: 'media-s', mime_type: 'image/webp' },
        },
        {
          ...base('wamid.video'),
          type: 'video',
          video: { id: 'v', mime_type: 'video/mp4' },
        },
        {
          ...base('wamid.loc'),
          type: 'location',
          location: { latitude: 1, longitude: 2 },
        },
      ]),
    );
    const payloads = h.mirrors();
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({
      type: 'sticker',
      contractType: 'STICKER',
      media: { providerMediaId: 'media-s', mimeType: 'image/webp' },
    });
    expect(payloads[1]).toMatchObject({
      type: 'video',
      contractType: 'UNSUPPORTED',
      unsupportedKind: 'VIDEO',
    });
    expect(payloads[2]).toMatchObject({
      type: 'location',
      contractType: 'UNSUPPORTED',
      unsupportedKind: 'LOCATION',
    });
    for (const payload of payloads.slice(1)) {
      expect(payload).not.toHaveProperty('text');
      expect(payload).not.toHaveProperty('media');
    }
    // Behavior unchanged for the customer: silent, nothing reaches the LLM.
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
    expect(h.runner.handle).not.toHaveBeenCalled();
  });

  it('mirrors the title of a tapped button, not its payload', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        {
          ...base('wamid.btn'),
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: 'order_confirm:ref1', title: 'Sí, confirmar' },
          },
        },
      ]),
    );
    expect(h.mirrors()[0]).toMatchObject({
      type: 'interactive',
      contractType: 'TEXT',
      text: 'Sí, confirmar',
    });
    const [row] = await h.transcript.listRecent(SENDER, 5);
    expect(row.details).toEqual({ replyId: 'order_confirm:ref1' });
    // The agent still receives what the id stands for, unchanged.
    expect(h.agent.tryHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'SÍ',
        interactiveReplyId: 'order_confirm:ref1',
      }),
    );
  });

  it('S7: asks the customer to write a voice note when nobody is attending', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        {
          ...base('wamid.audio'),
          type: 'audio',
          audio: { id: 'media-a', mime_type: 'audio/ogg', voice: true },
        },
      ]),
    );
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: AUDIO_UNSUPPORTED_REPLY,
    });
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
    expect(h.runner.handle).not.toHaveBeenCalled();
    expect(h.ingress.admit).not.toHaveBeenCalled();
    expect(h.productImage.recognize).not.toHaveBeenCalled();
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.audio');
  });

  it('S7: the audio reply follows the customer style (tú)', async () => {
    const h = setup({ style: 'tu' });
    await h.service.dispatch(
      event([
        {
          ...base('wamid.audio'),
          type: 'audio',
          audio: { id: 'media-a', mime_type: 'audio/ogg', voice: true },
        },
      ]),
    );
    const [{ text }] = h.sender.sendText.mock.calls[0] as unknown as [
      { text: string },
    ];
    expect(text).toContain('¿Me puedes escribir tu mensaje');
    expect(text).not.toMatch(/\busted\b|¿Me puede /);
  });

  it('S7: in HUMAN mode the voice note is mirrored but nobody answers', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(
      event([
        {
          ...base('wamid.audio'),
          type: 'audio',
          audio: { id: 'media-a', mime_type: 'audio/ogg', voice: true },
        },
      ]),
    );
    expect(h.mirrors()).toHaveLength(1);
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
  });

  it('a redelivered voice note is answered once', async () => {
    const h = setup();
    h.dedup.claim
      .mockResolvedValueOnce('t')
      .mockResolvedValueOnce(null as never);
    const audio = event([
      {
        ...base('wamid.audio'),
        type: 'audio',
        audio: { id: 'media-a', mime_type: 'audio/ogg', voice: true },
      },
    ]);
    await h.service.dispatch(audio);
    await h.service.dispatch(audio);
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
    expect(h.mirrors()).toHaveLength(1);
  });

  it('an audio from the ops phone is ignored like before (no ops routing, no mirror)', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        {
          ...base('wamid.ops-audio', OPS),
          type: 'audio',
          audio: { id: 'media-o', mime_type: 'audio/ogg' },
        },
      ]),
    );
    expect(h.handoff.resolveReply).not.toHaveBeenCalled();
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.mirrors()).toEqual([]);
  });
});

import { Logger } from '@nestjs/common';
import { fingerprintMessageId } from '../../common/log-safe';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { ProductImageRecognitionService } from '../../product-image/application/product-image-recognition.service';
import type { InboundMessage } from '../domain/inbound-message';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * S7: while the conversation is in HUMAN mode the bot never calls the agent
 * and never speaks; the inbound is only recorded (mirrored) and marked seen.
 */
const SENDER = '5215550001111';
const OPS = '5215500000000';

const event = (messages: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages } }] }],
  }) as WebhookEventDto;

const text = (id: string, from = SENDER) => ({
  id,
  from,
  timestamp: '1719000000',
  type: 'text',
  text: { body: 'hola' },
});
const image = (id: string) => ({
  id,
  from: SENDER,
  timestamp: '1719000000',
  type: 'image',
  image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'mi pago' },
});
const document = (id: string) => ({
  id,
  from: SENDER,
  timestamp: '1719000000',
  type: 'document',
  document: { id: 'media-2', mime_type: 'application/pdf' },
});

function setup(
  options: {
    human?: boolean;
    handoffError?: Error;
    /** The nth isHumanMode call (1-based) rejects; the others answer false. */
    failReadAt?: number;
    pendingMarker?: boolean;
    awaitingPayment?: boolean;
    /** Successive isHumanMode answers (the last one repeats). */
    modes?: boolean[];
    opsResolved?: boolean;
    /** S5: what onCustomerInbound does (default: resolves). */
    inbound?: 'never' | 'reject' | 'throw';
    /** B1: what onHumanCustomerInbound does (default: resolves). */
    humanInbound?: 'never' | 'reject' | 'throw';
    /** S4: isSilenced answer (ENDING marker); absent = the reader lacks it. */
    silenced?: boolean;
  } = {},
) {
  const order: string[] = [];
  const sender = {
    sendText: jest.fn(() => {
      order.push('send');
      return Promise.resolve({ providerMessageId: 'wamid.out' });
    }),
    sendTemplate: jest.fn(),
    sendImage: jest.fn(),
    sendInteractive: jest.fn(),
  };
  const agent = {
    prepareCustomer: jest.fn(() => Promise.resolve()),
    customerStyle: jest.fn(() => undefined),
    tryHandle: jest.fn(() => {
      order.push('turn');
      return Promise.resolve({ kind: 'handled', reply: 'Hola' });
    }),
  };
  const runner = {
    handle: jest.fn(() => {
      order.push('runner');
      return Promise.resolve({ reply: 'Retomamos' });
    }),
  };
  const dedup = {
    claim: jest.fn(() => Promise.resolve<string | null>('claim-token')),
    release: jest.fn(() => Promise.resolve()),
    purgeBefore: jest.fn(() => Promise.resolve(0)),
    markSeen: jest.fn((id: string) => {
      order.push(`seen ${id}`);
      return Promise.resolve();
    }),
  };
  const handoff = {
    isOpsSender: (id: string) => id === OPS,
    resolveReply: jest.fn(() =>
      Promise.resolve(
        options.opsResolved
          ? {
              kind: 'resolved',
              customerId: SENDER,
              syntheticUserText: 'agent said yes',
            }
          : { kind: 'no_pending', reply: 'ref?' },
      ),
    ),
  };
  const store = {
    get: jest.fn(() =>
      Promise.resolve({
        senderId: SENDER,
        lastMessageAt: '2026-01-01T00:00:00.000Z',
        data: {
          ...(options.pendingMarker
            ? {
                pendingHumanRequest: {
                  requestId: 'abc123def456',
                  ref: 'HF-abc123def456',
                  createdAt: 'x',
                  customerNotifiedAt: 'x',
                },
              }
            : {}),
          ...(options.awaitingPayment
            ? { minimalCart: { placedSale: { saleId: 's' } } }
            : {}),
        },
      }),
    ),
  };
  const ingress = {
    admit: jest.fn(() => Promise.resolve({ kind: 'reserved' })),
  };
  const productImage = {
    recognize: jest.fn(() =>
      Promise.resolve({ kind: 'unavailable', reason: 'error' }),
    ),
  };
  const recorder = {
    recordInbound: jest.fn((message: InboundMessage) => {
      order.push(`record ${message.messageId}`);
      return Promise.resolve();
    }),
  };
  const modes = [...(options.modes ?? [])];
  let reads = 0;
  const handoffMode = {
    ...(options.silenced === undefined
      ? {}
      : {
          isSilenced: jest.fn((senderId: string) => {
            order.push(`silenced ${senderId}`);
            return Promise.resolve(options.silenced === true);
          }),
        }),
    isHumanMode: jest.fn((senderId: string) => {
      order.push(`mode ${senderId}`);
      reads += 1;
      if (reads === options.failReadAt)
        return Promise.reject(new Error('mode read failed'));
      if (options.handoffError) return Promise.reject(options.handoffError);
      if (modes.length > 0)
        return Promise.resolve(modes.length > 1 ? modes.shift()! : modes[0]);
      return Promise.resolve(options.human === true);
    }),
  };
  const humanRequests = {
    onCustomerInbound: jest.fn((ref: string) => {
      order.push(`inbound ${ref}`);
      if (options.inbound === 'throw') throw new Error('sync boom');
      if (options.inbound === 'reject')
        return Promise.reject(new Error('async boom'));
      if (options.inbound === 'never')
        return new Promise<void>(() => undefined);
      return Promise.resolve();
    }),
  };
  const humanRequestsHuman = {
    onHumanCustomerInbound: jest.fn((ref: string) => {
      order.push(`human-inbound ${ref}`);
      if (options.humanInbound === 'throw') throw new Error('sync boom');
      if (options.humanInbound === 'reject')
        return Promise.reject(new Error('async boom'));
      if (options.humanInbound === 'never')
        return new Promise<void>(() => undefined);
      return Promise.resolve();
    }),
  };
  const service = new WebhookDispatcherService(
    runner as unknown as AgentRunner,
    sender,
    dedup,
    { remember: jest.fn(), isKnown: () => false },
    handoff as unknown as HumanHandoffService,
    store as unknown as ConversationStore,
    ingress as unknown as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    productImage as unknown as ProductImageRecognitionService,
    recorder,
    undefined,
    handoffMode,
    { ...humanRequests, ...humanRequestsHuman },
  );
  return {
    humanRequests: { ...humanRequests, ...humanRequestsHuman },
    service,
    order,
    sender,
    agent,
    runner,
    dedup,
    store,
    ingress,
    productImage,
    recorder,
    handoffMode,
  };
}

const expectSilent = (h: ReturnType<typeof setup>) => {
  expect(h.agent.tryHandle).not.toHaveBeenCalled();
  expect(h.runner.handle).not.toHaveBeenCalled();
  expect(h.sender.sendText).not.toHaveBeenCalled();
  expect(h.sender.sendImage).not.toHaveBeenCalled();
  expect(h.sender.sendInteractive).not.toHaveBeenCalled();
  expect(h.sender.sendTemplate).not.toHaveBeenCalled();
};

describe('WebhookDispatcherService handoff gate (S7)', () => {
  it('HUMAN: a text never reaches the agent, sends nothing, is recorded and marked seen', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.h1')]));
    expectSilent(h);
    expect(h.order).toEqual([
      'record wamid.h1',
      `mode ${SENDER}`,
      `human-inbound wa:${SENDER}`,
      'seen wamid.h1',
    ]);
  });

  it('HUMAN: an image (even a receipt awaiting payment) gets no bot reply', async () => {
    const h = setup({ human: true, awaitingPayment: true });
    await h.service.dispatch(event([image('wamid.h2')]));
    expectSilent(h);
    expect(h.ingress.admit).not.toHaveBeenCalled();
    expect(h.productImage.recognize).not.toHaveBeenCalled();
    expect(h.recorder.recordInbound).toHaveBeenCalledTimes(1);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.h2');
  });

  it('HUMAN: a PDF document gets no receipt reply', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([document('wamid.h3')]));
    expectSilent(h);
    expect(h.ingress.admit).not.toHaveBeenCalled();
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.h3');
  });

  it('HUMAN wins over the pending-marker canned reply', async () => {
    const h = setup({ human: true, pendingMarker: true });
    await h.service.dispatch(event([text('wamid.h4')]));
    expectSilent(h);
  });

  it('HUMAN: the gate runs before the profile warm-up and state read', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.h5')]));
    expect(h.agent.prepareCustomer).not.toHaveBeenCalled();
    expect(h.store.get).not.toHaveBeenCalled();
  });

  it('ENDING: a silenced conversation (durable BOT, farewell pending) gets no bot reply', async () => {
    const h = setup({ human: false, silenced: true });
    await h.service.dispatch(event([text('wamid.e1')]));
    expectSilent(h);
    expect(h.order).toContain(`silenced ${SENDER}`);
    expect(h.order).toContain('seen wamid.e1');
  });

  it('BOT and not ENDING: the silenced read lets the turn run', async () => {
    const h = setup({ human: false, silenced: false });
    await h.service.dispatch(event([text('wamid.e2')]));
    expect(h.agent.tryHandle).toHaveBeenCalled();
  });

  it('BOT: the customer turn runs exactly as before', async () => {
    const h = setup({ human: false });
    await h.service.dispatch(event([text('wamid.b1')]));
    expect(h.order).toEqual([
      'record wamid.b1',
      `mode ${SENDER}`,
      `inbound wa:${SENDER}`,
      'turn',
      `mode ${SENDER}`,
      'send',
      'seen wamid.b1',
    ]);
  });

  it('the ops phone is never gated (it is not a customer conversation)', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.ops', OPS)]));
    expect(h.handoffMode.isHumanMode).not.toHaveBeenCalled();
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('fails closed: an unreadable mode sends nothing and lets Meta redeliver', async () => {
    const h = setup({ handoffError: new Error('db down') });
    await expect(
      h.service.dispatch(event([text('wamid.err')])),
    ).rejects.toThrow('db down');
    expectSilent(h);
    expect(h.dedup.markSeen).not.toHaveBeenCalled();
  });

  it('ops resolved while the customer is HUMAN: no runner turn, no customer send, ops message completed', async () => {
    const h = setup({ human: true, opsResolved: true });
    const log = jest
      .spyOn(h.service['logger'], 'log')
      .mockImplementation(() => undefined);
    await h.service.dispatch(event([text('wamid.ops-r', OPS)]));
    expect(h.handoffMode.isHumanMode).toHaveBeenCalledWith(SENDER);
    expectSilent(h);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.ops-r');
    expect(
      log.mock.calls.some(([line]) => String(line).includes('HUMAN')),
    ).toBe(true);
  });

  it('ops resolved with an unreadable customer mode fails closed (no turn, no send)', async () => {
    const h = setup({ handoffError: new Error('db down'), opsResolved: true });
    jest.spyOn(h.service['logger'], 'warn').mockImplementation(() => undefined);
    await h.service.dispatch(event([text('wamid.ops-e', OPS)]));
    expectSilent(h);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.ops-e');
  });

  it('ops resolved while the customer is BOT: the resume turn runs as before', async () => {
    const h = setup({ human: false, opsResolved: true });
    await h.service.dispatch(event([text('wamid.ops-b', OPS)]));
    expect(h.order).toEqual([
      `mode ${SENDER}`,
      'runner',
      `mode ${SENDER}`, // T6: re-read right before the customer send
      'send',
      'seen wamid.ops-b',
    ]);
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Retomamos',
    });
  });

  describe('a mode-read failure after a partial send (L13 b)', () => {
    const withPhoto = (h: ReturnType<typeof setup>, onSent = jest.fn()) =>
      h.agent.tryHandle.mockImplementation(() => {
        h.order.push('turn');
        return Promise.resolve({
          kind: 'handled',
          reply: 'Hola',
          media: [{ url: 'https://cdn.example.com/p.jpg' }],
          onSent,
        } as never);
      });
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('after the photo went out, an unreadable mode stops the turn and marks seen: no throw, no release, no text, no repeat', async () => {
      // reads: 1 gate, 2 before the photo, 3 before the text (fails)
      const h = setup({ failReadAt: 3 });
      const onSent = jest.fn();
      withPhoto(h, onSent);
      h.sender.sendImage.mockResolvedValue({ providerMessageId: 'wamid.img' });
      await expect(
        h.service.dispatch(event([text('wamid.pp1')])),
      ).resolves.toBeUndefined();
      expect(h.sender.sendImage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendText).not.toHaveBeenCalled();
      expect(onSent).not.toHaveBeenCalled();
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.pp1');
      expect(h.dedup.release).not.toHaveBeenCalled();
      // A redelivery is a duplicate: the turn does not run again.
      h.dedup.claim.mockResolvedValueOnce(null);
      await h.service.dispatch(event([text('wamid.pp1')]));
      expect(h.agent.tryHandle).toHaveBeenCalledTimes(1);
      expect(h.sender.sendImage).toHaveBeenCalledTimes(1);
    });

    it('before anything was sent, an unreadable mode still fails closed (throws, releases the claim, sends nothing)', async () => {
      const h = setup({ failReadAt: 2 });
      withPhoto(h);
      await expect(
        h.service.dispatch(event([text('wamid.pp2')])),
      ).rejects.toThrow('mode read failed');
      expect(h.sender.sendImage).not.toHaveBeenCalled();
      expect(h.sender.sendText).not.toHaveBeenCalled();
      expect(h.dedup.release).toHaveBeenCalled();
      expect(h.dedup.markSeen).not.toHaveBeenCalled();
    });

    it('a photo that failed to send is not a partial send: an unreadable mode still fails closed', async () => {
      const h = setup({ failReadAt: 3 });
      withPhoto(h);
      h.sender.sendImage.mockRejectedValue(new Error('meta 400'));
      await expect(
        h.service.dispatch(event([text('wamid.pp3')])),
      ).rejects.toThrow('mode read failed');
      expect(h.sender.sendText).not.toHaveBeenCalled();
    });
  });

  it('switched to HUMAN mid-turn: the agent reply is dropped, the message is still marked seen', async () => {
    const h = setup({ modes: [false, true] });
    const onSent = jest.fn();
    h.agent.tryHandle.mockImplementation(() => {
      h.order.push('turn');
      return Promise.resolve({
        kind: 'handled',
        reply: 'Hola',
        media: [{ url: 'https://cdn.example.com/p.jpg' }],
        onSent,
      } as never);
    });
    await h.service.dispatch(event([text('wamid.mid')]));
    expect(h.order).toEqual([
      'record wamid.mid',
      `mode ${SENDER}`,
      `inbound wa:${SENDER}`,
      'turn',
      `mode ${SENDER}`,
      'seen wamid.mid',
    ]);
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.sender.sendImage).not.toHaveBeenCalled();
    expect(h.sender.sendInteractive).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });
});

describe('WebhookDispatcherService pending deliveries hook (S5)', () => {
  it('BOT: calls onCustomerInbound after the gate, before the turn', async () => {
    const h = setup();
    await h.service.dispatch(event([text('wamid.p1')]));
    expect(h.humanRequests.onCustomerInbound).toHaveBeenCalledWith(
      `wa:${SENDER}`,
    );
    const at = h.order.indexOf(`inbound wa:${SENDER}`);
    expect(at).toBeGreaterThan(h.order.indexOf(`mode ${SENDER}`));
    expect(at).toBeLessThan(h.order.indexOf('turn'));
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('never awaits it: a hook that never settles does not delay the reply', async () => {
    const h = setup({ inbound: 'never' });
    await h.service.dispatch(event([text('wamid.p2')]));
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.p2');
  });

  it.each(['reject', 'throw'] as const)(
    'a hook that fails (%s) never breaks the reply',
    async (inbound) => {
      const h = setup({ inbound });
      await expect(
        h.service.dispatch(event([text('wamid.p3')])),
      ).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.sender.sendText).toHaveBeenCalledTimes(1);
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.p3');
    },
  );

  it('HUMAN: the held request.* replay is not called (they stay held) but the deferred staff messages are resent (B1)', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.p4')]));
    expect(h.humanRequests.onCustomerInbound).not.toHaveBeenCalled();
    expect(h.humanRequests.onHumanCustomerInbound).toHaveBeenCalledTimes(1);
    expect(h.humanRequests.onHumanCustomerInbound).toHaveBeenCalledWith(
      `wa:${SENDER}`,
    );
    expectSilent(h);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.p4');
  });

  it('BOT: the HUMAN-mode replay is not called', async () => {
    const h = setup();
    await h.service.dispatch(event([text('wamid.p4b')]));
    expect(h.humanRequests.onHumanCustomerInbound).not.toHaveBeenCalled();
  });

  it('HUMAN: never awaits it, and a hook that fails never breaks the turn', async () => {
    const never = setup({ human: true, humanInbound: 'never' });
    await never.service.dispatch(event([text('wamid.p4c')]));
    expect(never.dedup.markSeen).toHaveBeenCalledWith('wamid.p4c');
    for (const humanInbound of ['reject', 'throw'] as const) {
      const h = setup({ human: true, humanInbound });
      await expect(
        h.service.dispatch(event([text('wamid.p4d')])),
      ).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.p4d');
      expect(h.dedup.release).not.toHaveBeenCalled();
    }
  });

  it('HUMAN: an unreadable mode still fails closed and calls neither replay', async () => {
    const h = setup({ handoffError: new Error('db down') });
    await expect(
      h.service.dispatch(event([text('wamid.p4e')])),
    ).rejects.toThrow('db down');
    expect(h.humanRequests.onCustomerInbound).not.toHaveBeenCalled();
    expect(h.humanRequests.onHumanCustomerInbound).not.toHaveBeenCalled();
  });

  it('forwards the inbound time to the turn (S6 askTeam)', async () => {
    const h = setup();
    await h.service.dispatch(event([text('wamid.p5')]));
    expect(h.agent.tryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ inboundAt: '2024-06-21T20:00:00.000Z' }),
    );
  });

  it('ops messages never call it', async () => {
    const h = setup();
    await h.service.dispatch(event([text('wamid.p6', OPS)]));
    expect(h.humanRequests.onCustomerInbound).not.toHaveBeenCalled();
    expect(h.humanRequests.onHumanCustomerInbound).not.toHaveBeenCalled();
  });
});

describe('WebhookDispatcherService handoff logs mask the phone (S6)', () => {
  const MASKED = 'wa:…1111';
  const spyAll = () => ({
    log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {}),
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
    debug: jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {}),
  });
  const lines = (spy: jest.SpyInstance) =>
    spy.mock.calls.map(([line]) => String(line)).join('\n');
  const expectMasked = (out: string, needle: string) => {
    expect(out).toContain(needle);
    expect(out).not.toContain(SENDER);
    expect(out).not.toMatch(/wamid\.m\d/);
    expect(out).toContain(MASKED);
  };
  afterEach(() => jest.restoreAllMocks());

  it('HUMAN mirror-only line', async () => {
    const spies = spyAll();
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.m1')]));
    expectMasked(
      lines(spies.debug),
      `mirror-only ${fingerprintMessageId('wamid.m1')}`,
    );
  });

  it('HUMAN skip-resume-turn line', async () => {
    const spies = spyAll();
    const h = setup({ human: true, opsResolved: true });
    await h.service.dispatch(event([text('wamid.m2', OPS)]));
    expectMasked(lines(spies.log), 'skip resume turn');
  });

  it('unreadable-mode skip-resume-turn line', async () => {
    const spies = spyAll();
    const h = setup({ handoffError: new Error('db down'), opsResolved: true });
    await h.service.dispatch(event([text('wamid.m3', OPS)]));
    expectMasked(lines(spies.warn), 'handoff mode unreadable');
  });

  it('mid-turn drop-reply line', async () => {
    const spies = spyAll();
    const h = setup({ modes: [false, true] });
    await h.service.dispatch(event([text('wamid.m4')]));
    expectMasked(
      lines(spies.log),
      `drop reply for ${fingerprintMessageId('wamid.m4')}`,
    );
  });

  it('pending-marker short-circuit line', async () => {
    const spies = spyAll();
    const h = setup({ pendingMarker: true });
    h.agent.customerStyle.mockReturnValue({
      register: 'usted',
      emojis: false,
    } as never);
    await h.service.dispatch(event([text('wamid.m5')]));
    expectMasked(lines(spies.log), 'short-circuit pending-marker');
  });
});

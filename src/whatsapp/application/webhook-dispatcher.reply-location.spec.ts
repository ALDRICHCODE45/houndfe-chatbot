import { Logger } from '@nestjs/common';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * T2 H3 (S3): a reply carrying the store pin sends the text FIRST, then the
 * WhatsApp location message. A failed or unsupported pin is only logged:
 * the text is sent exactly once and never repeated.
 */
const SENDER = '5215550001111';
const PIN = {
  latitude: 19.4326,
  longitude: -99.1332,
  name: 'Sucursal Centro',
  address: 'Av. Juárez 123, Centro',
};

const textEvent = (body: string): WebhookEventDto => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: 'wamid.in',
                from: SENDER,
                timestamp: '1719000000',
                type: 'text',
                text: { body },
              },
            ],
          },
        },
      ],
    },
  ],
});

function setup(
  decision: Record<string, unknown>,
  options: { humanAfterText?: true } = {},
) {
  const order: string[] = [];
  const sender = {
    sendText: jest.fn(async () => {
      order.push('text');
      return { providerMessageId: 'wamid.text' };
    }),
    sendTemplate: jest.fn(),
    sendInteractive: jest.fn(async () => {
      order.push('interactive');
      return {
        providerMessageId: 'wamid.int',
        providerMessageIds: ['wamid.int'],
      };
    }),
    sendLocation: jest.fn(async () => {
      order.push('location');
      return { providerMessageId: 'wamid.pin' };
    }),
  };
  const onSent = jest.fn(() => order.push('onSent'));
  const agent = {
    tryHandle: jest.fn(async () => ({ kind: 'handled', onSent, ...decision })),
  };
  const recentOutbound = { remember: jest.fn(), isKnown: () => false };
  const dedup = {
    claim: jest.fn(async () => 'claim-token'),
    release: jest.fn(async () => undefined),
    purgeBefore: jest.fn(async () => 0),
    markSeen: jest.fn(async () => {
      order.push('markSeen');
    }),
  };
  // The handoff mode is read before each send; `humanAfterText` flips it to
  // HUMAN once the text went out.
  const handoffMode = {
    isHumanMode: jest.fn(async () =>
      Promise.resolve(
        options.humanAfterText === true && order.includes('text'),
      ),
    ),
  };
  const service = new WebhookDispatcherService(
    {} as AgentRunner,
    sender,
    dedup,
    recentOutbound,
    { isOpsSender: () => false } as unknown as HumanHandoffService,
    { get: jest.fn(async () => null) } as unknown as ConversationStore,
    {} as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    undefined,
    undefined,
    undefined,
    handoffMode,
  );
  return { service, sender, order, recentOutbound, dedup };
}

const order = (h: { order: string[] }) => h.order;

describe('WebhookDispatcherService reply location (T2 H3)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the text first, then the pin, and remembers both ids', async () => {
    const h = setup({
      reply: 'Nos encuentra en *Sucursal Centro*',
      location: PIN,
    });
    await h.service.dispatch(textEvent('¿dónde están?'));

    expect(h.order).toEqual(['text', 'onSent', 'markSeen', 'location']);
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Nos encuentra en *Sucursal Centro*',
    });
    expect(h.sender.sendLocation).toHaveBeenCalledWith({ to: SENDER, ...PIN });
    expect(h.recentOutbound.remember).toHaveBeenCalledWith('wamid.text');
    expect(h.recentOutbound.remember).toHaveBeenCalledWith('wamid.pin');
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.in');
  });

  it('sends the pin after the buttons of an interactive reply', async () => {
    const h = setup({
      reply: '¡Pedido registrado!',
      interactive: { type: 'buttons', buttons: [{ id: 'a', title: 'A' }] },
      location: PIN,
    });
    await h.service.dispatch(textEvent('SÍ'));
    expect(h.order).toEqual(['interactive', 'onSent', 'markSeen', 'location']);
  });

  it('a failed pin send is logged; the text went out once and is not repeated', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = setup({
      reply: 'Nos encuentra en *Sucursal Centro*',
      location: PIN,
    });
    h.sender.sendLocation.mockRejectedValueOnce(new Error('Meta 131000'));

    await h.service.dispatch(textEvent('¿dónde están?'));

    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(['text', 'onSent', 'markSeen']);
    expect(h.recentOutbound.remember).not.toHaveBeenCalledWith('wamid.pin');
    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('reply location failed');
    expect(logged).not.toContain(SENDER);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.in');
  });

  it('a sender without sendLocation sends only the text', async () => {
    const h = setup({
      reply: 'Nos encuentra en *Sucursal Centro*',
      location: PIN,
    });
    delete (h.sender as Partial<typeof h.sender>).sendLocation;
    await h.service.dispatch(textEvent('¿dónde están?'));
    expect(h.order).toEqual(['text', 'onSent', 'markSeen']);
  });

  it('the conversation switched to HUMAN after the text: the pin is dropped', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const h = setup(
      { reply: 'Nos encuentra en *Sucursal Centro*', location: PIN },
      { humanAfterText: true },
    );
    await h.service.dispatch(textEvent('¿dónde están?'));
    expect(h.order).toEqual(['text', 'onSent', 'markSeen']);
    expect(h.sender.sendLocation).not.toHaveBeenCalled();
  });

  it('a reply without a location sends exactly what it sent before', async () => {
    const h = setup({ reply: 'Hola' });
    await h.service.dispatch(textEvent('hola'));
    expect(h.order).toEqual(['text', 'onSent', 'markSeen']);
    expect(h.sender.sendLocation).not.toHaveBeenCalled();
  });

  describe('T2-fix J1: the pin goes after markSeen, bounded by a timeout', () => {
    afterEach(() => jest.useRealTimers());

    it('the message is marked seen BEFORE the pin is sent (a crash there never replays the text)', async () => {
      const h = setup({
        reply: 'Nos encuentra en *Sucursal Centro*',
        location: PIN,
      });
      h.sender.sendLocation.mockImplementationOnce(async () => {
        // At the moment the pin goes out, the turn is already DONE.
        expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.in');
        order(h).push('location');
        return { providerMessageId: 'wamid.pin' };
      });
      await h.service.dispatch(textEvent('¿dónde están?'));
      expect(h.order).toEqual(['text', 'onSent', 'markSeen', 'location']);
    });

    it('a pin that never answers times out after 5 s: the text went out once, markSeen first', async () => {
      jest.useFakeTimers();
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const h = setup({
        reply: 'Nos encuentra en *Sucursal Centro*',
        location: PIN,
      });
      h.sender.sendLocation.mockImplementationOnce(() => {
        order(h).push('location');
        return new Promise<never>(() => undefined);
      });
      let done = false;
      const dispatched = h.service
        .dispatch(textEvent('¿dónde están?'))
        .then(() => {
          done = true;
        });
      await jest.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await dispatched;
      expect(done).toBe(true);
      expect(h.sender.sendText).toHaveBeenCalledTimes(1);
      expect(h.order).toEqual(['text', 'onSent', 'markSeen', 'location']);
      expect(h.dedup.release).not.toHaveBeenCalled();
      const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain('reply location timed out');
      expect(logged).not.toContain(SENDER);
    });
  });
});

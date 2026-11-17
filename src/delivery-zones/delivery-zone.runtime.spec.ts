import type { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { ChatbotApiClient } from '../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../conversation/domain/conversation-store';
import type { WhatsappSenderPort } from '../whatsapp/domain/whatsapp-sender.port';
import type { DeliveryZoneIntakeService } from './application/delivery-zone-intake.service';
import { DeliveryZonePoller } from './application/delivery-zone-poller';
import { DeliveryZoneRuntime } from './delivery-zone.runtime';
import { InMemoryDeliveryZoneRequesterStore } from './infrastructure/in-memory-delivery-zone-requester.store';
import type { HandoffModeService } from '../conversation/application/handoff-mode.service';
import { PostgresCustomerInboundObservationStore } from '../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import type { DeliveryZoneRequesterRow } from './domain/delivery-zone-requester';
import type { DeliveryZoneNotifier } from './application/delivery-zone-notifier';
import { DeliveryZoneResumeRegistry } from './domain/delivery-zone-resume';

function build(
  phone: unknown = '123456789',
  overrides: {
    store?: InMemoryDeliveryZoneRequesterStore;
    sender?: WhatsappSenderPort;
    handoff?: Pick<HandoffModeService, 'isHumanMode'>;
    resume?: DeliveryZoneResumeRegistry;
  } = {},
) {
  const config = { get: () => phone } as unknown as ConfigService;
  return new DeliveryZoneRuntime(
    config,
    {} as Pool,
    overrides.store ?? new InMemoryDeliveryZoneRequesterStore(),
    {} as DeliveryZoneIntakeService,
    {
      recordRestockApplicationOutcome: jest.fn(),
    } as unknown as ChatbotApiClient,
    overrides.sender ?? ({} as WhatsappSenderPort),
    {} as ConversationStore,
    {},
    (overrides.handoff ?? {
      isHumanMode: () => Promise.resolve(false),
    }) as HandoffModeService,
    undefined,
    overrides.resume,
  );
}

const SOURCE = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
const SENDER = '5215512345678';

/** A RESOLVED requester row due for delivery. */
const resolvedRow = (): DeliveryZoneRequesterRow => ({
  sourceRequestId: SOURCE,
  senderId: SENDER,
  zipCode: '06700',
  intake: {
    sourceRequestId: SOURCE,
    type: 'DELIVERY_ZONE',
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
    phoneCountryCode: '52',
    phone: '5512345678',
    conversationRef: `wa:${SENDER}`,
    lastCustomerMessageAt: '2026-11-05T10:00:00.000Z',
  },
  requesterId: 'c41b2c3d-1111-4222-8333-444455556666',
  status: 'RESOLVED',
  lastPolledAt: null,
  resolution: {
    source: 'VALIDATION',
    zoneType: 'FREE',
    resolvedAt: '2026-11-05T18:00:00.000Z',
  },
  applyBefore: '2099-01-01T00:00:00.000Z',
  channel: null,
  attemptId: null,
  attemptedAt: null,
  deliveryOutcome: null,
  providerMessageId: null,
  providerAcceptedObservedAt: null,
  notifiedAt: null,
  ackOutcome: null,
  ackedAt: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
});

describe('DeliveryZoneRuntime', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts the poller once on boot and drains it on shutdown', async () => {
    const start = jest
      .spyOn(DeliveryZonePoller.prototype, 'start')
      .mockImplementation();
    const stop = jest
      .spyOn(DeliveryZonePoller.prototype, 'stop')
      .mockResolvedValue();
    const runtime = build();
    runtime.onApplicationBootstrap();
    runtime.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
    await runtime.onModuleDestroy();
    runtime.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('fails startup without the Meta receiving phone identity', () => {
    expect(() => build('  ').onApplicationBootstrap()).toThrow(
      'DELIVERY_ZONE runtime requires the Meta receiving phone identity',
    );
  });

  describe('S7 handoff hold (wired from HandoffModeService)', () => {
    /** Boots the runtime and runs one notifier pass over a RESOLVED row. */
    const run = async (isHumanMode: (id: string) => Promise<boolean>) => {
      let notifier!: Pick<DeliveryZoneNotifier, 'process'>;
      jest
        .spyOn(DeliveryZonePoller.prototype, 'start')
        .mockImplementation(function (this: DeliveryZonePoller) {
          notifier = (this as unknown as { notifier: typeof notifier })
            .notifier;
        });
      jest.spyOn(DeliveryZonePoller.prototype, 'stop').mockResolvedValue();
      jest
        .spyOn(PostgresCustomerInboundObservationStore.prototype, 'readLatest')
        .mockResolvedValue({ kind: 'missing' } as never);
      const store = new InMemoryDeliveryZoneRequesterStore();
      store.rows.set(SOURCE, resolvedRow());
      const sender = {
        sendText: jest.fn().mockResolvedValue({ providerMessageId: 'w.t' }),
        sendTemplate: jest
          .fn()
          .mockResolvedValue({ providerMessageId: 'w.tpl' }),
      };
      const handoff = { isHumanMode: jest.fn(isHumanMode) };
      const runtime = build('123456789', {
        store,
        sender: sender as unknown as WhatsappSenderPort,
        handoff,
      });
      runtime.onApplicationBootstrap();
      await notifier.process(resolvedRow());
      await runtime.onModuleDestroy();
      return { store, sender, handoff };
    };

    it.each([
      ['HUMAN', () => Promise.resolve(true)],
      ['an unreadable mode', () => Promise.reject(new Error('db down'))],
    ])('%s: no send and the row stays RESOLVED', async (_label, mode) => {
      const { store, sender, handoff } = await run(mode);
      expect(handoff.isHumanMode).toHaveBeenCalledWith(SENDER);
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(sender.sendTemplate).not.toHaveBeenCalled();
      expect(store.rows.get(SOURCE)).toMatchObject({
        status: 'RESOLVED',
        attemptId: null,
      });
    });

    it('BOT: the notice is sent', async () => {
      const { store, sender, handoff } = await run(() =>
        Promise.resolve(false),
      );
      expect(handoff.isHumanMode).toHaveBeenCalledWith(SENDER);
      expect(sender.sendTemplate).toHaveBeenCalledTimes(1);
      expect(store.rows.get(SOURCE)?.status).not.toBe('RESOLVED');
    });
  });
});

describe('DeliveryZoneRuntime S4 checkout resume wiring', () => {
  afterEach(() => jest.restoreAllMocks());

  const run = async (registry: DeliveryZoneResumeRegistry | undefined) => {
    let notifier!: Pick<DeliveryZoneNotifier, 'process'>;
    jest
      .spyOn(DeliveryZonePoller.prototype, 'start')
      .mockImplementation(function (this: DeliveryZonePoller) {
        notifier = (this as unknown as { notifier: typeof notifier }).notifier;
      });
    jest.spyOn(DeliveryZonePoller.prototype, 'stop').mockResolvedValue();
    jest
      .spyOn(PostgresCustomerInboundObservationStore.prototype, 'readLatest')
      .mockResolvedValue({
        kind: 'found',
        observation: {
          senderId: SENDER,
          receivingPhoneNumberId: '123456789',
          messageId: 'wamid.in',
          providerTimestampSeconds: String(Math.floor(Date.now() / 1000) - 60),
          observedAt: new Date().toISOString(),
        },
      });
    const store = new InMemoryDeliveryZoneRequesterStore();
    store.rows.set(SOURCE, resolvedRow());
    const sender = {
      sendText: jest.fn().mockResolvedValue({ providerMessageId: 'w.t' }),
      sendTemplate: jest.fn().mockResolvedValue({ providerMessageId: 'w.tpl' }),
      sendInteractive: jest.fn().mockResolvedValue({
        providerMessageId: 'w.i',
        providerMessageIds: ['w.i'],
      }),
    };
    const runtime = build('123456789', {
      store,
      sender: sender as unknown as WhatsappSenderPort,
      ...(registry === undefined ? {} : { resume: registry }),
    });
    runtime.onApplicationBootstrap();
    await notifier.process(resolvedRow());
    await runtime.onModuleDestroy();
    return { sender };
  };

  it('resolves the registered resumer at call time and sends the summary with buttons', async () => {
    const registry = new DeliveryZoneResumeRegistry();
    const arm = jest.fn();
    const prepare = jest.fn().mockResolvedValue({
      shippingSentence: 'el envío no tiene costo',
      summary: {
        text: 'Resumen de su pedido:',
        buttons: [{ id: 'order_confirm:r', title: '✅ Confirmar pedido' }],
        prompt: '¿Confirma su pedido?',
      },
      arm,
      discard: jest.fn(),
    });
    registry.register({ prepare });
    const { sender } = await run(registry);
    expect(prepare).toHaveBeenCalledWith({
      senderId: SENDER,
      zipCode: '06700',
      zoneType: 'FREE',
      sourceRequestId: SOURCE,
      receivingPhoneNumberId: '123456789',
    });
    expect(sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: '¡Listo! Ya tenemos entrega a su código postal 06700: el envío no tiene costo.',
    });
    expect(sender.sendInteractive).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no registry', undefined],
    ['no registered resumer', new DeliveryZoneResumeRegistry()],
  ] as const)(
    '%s: the current notice text, no summary',
    async (_label, registry) => {
      const { sender } = await run(registry);
      expect(sender.sendText).toHaveBeenCalledWith({
        to: SENDER,
        text: '¡Listo! Ya tenemos entrega a su código postal 06700. Pídame de nuevo el envío y le muestro el costo actualizado.',
      });
      expect(sender.sendInteractive).not.toHaveBeenCalled();
    },
  );
});

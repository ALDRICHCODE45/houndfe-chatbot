import type { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { ChatbotApiClient } from '../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../conversation/domain/conversation-store';
import type { WhatsappSenderPort } from '../whatsapp/domain/whatsapp-sender.port';
import type { DeliveryZoneIntakeService } from './application/delivery-zone-intake.service';
import { DeliveryZonePoller } from './application/delivery-zone-poller';
import { DeliveryZoneRuntime } from './delivery-zone.runtime';
import { InMemoryDeliveryZoneRequesterStore } from './infrastructure/in-memory-delivery-zone-requester.store';

function build(phone: unknown = '123456789') {
  const config = { get: () => phone } as unknown as ConfigService;
  return new DeliveryZoneRuntime(
    config,
    {} as Pool,
    new InMemoryDeliveryZoneRequesterStore(),
    {} as DeliveryZoneIntakeService,
    {} as ChatbotApiClient,
    {} as WhatsappSenderPort,
    {} as ConversationStore,
    {},
  );
}

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
});

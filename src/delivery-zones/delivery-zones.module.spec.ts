import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { HandoffModeService } from '../conversation/application/handoff-mode.service';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import { MetaWhatsappSender } from '../whatsapp/infrastructure/meta-whatsapp.sender';
import { DeliveryZoneRuntime } from './delivery-zone.runtime';
import { DeliveryZonesModule } from './delivery-zones.module';

/** Synthetic DI proof (no init, no SQL): the always-on runtime receives the
 * shared S7 `HandoffModeService`, and the graph refuses to build without it. */
const fakePool = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
};
const config = {
  get: (key: string) =>
    key === 'meta.phoneNumberId' ? '123456789' : undefined,
};

describe('DeliveryZonesModule S7 wiring', () => {
  it('injects the shared HandoffModeService into the runtime', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, DeliveryZonesModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .overrideProvider(ChatbotApiHttpClient)
      .useValue({})
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue({})
      .overrideProvider(MetaWhatsappSender)
      .useValue({})
      .overrideProvider(WHATSAPP_SENDER)
      .useValue({ sendText: jest.fn(), sendTemplate: jest.fn() })
      .compile();
    const handoff = moduleRef.get(HandoffModeService, { strict: false });
    expect(handoff).toBeInstanceOf(HandoffModeService);
    const runtime = moduleRef.get(DeliveryZoneRuntime, { strict: false });
    // SAFETY: test-only introspection of the private constructor field.
    expect((runtime as unknown as { handoff: unknown }).handoff).toBe(handoff);
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(fakePool.query).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});

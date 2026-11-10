import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  MINIMAL_EXPIRATION_OPEN_LIMIT_REPLY,
  MinimalExpirationRequestService,
} from './minimal-expiration-request.service';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const INBOUND = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.E1',
};
const stock: StockCheckResponse = {
  productId: PRODUCT,
  name: 'Ibuprofeno 400 mg',
  stock: { status: 'available', quantity: 5 },
  variants: [],
};

// S5: the per-sender open-request cap gets its own customer wording.
describe('MinimalExpirationRequestService open-request cap (S5)', () => {
  it('words a sender-cap refusal and never POSTs', async () => {
    const orchestrateExpirationPost = jest.fn();
    const service = new MinimalExpirationRequestService({
      chatbotApi: { getStock: jest.fn().mockResolvedValue(stock) },
      reservations: {
        reserve: jest.fn().mockResolvedValue({
          action: 'limit_reached',
          reason: 'sender_open_limit',
          limit: 20,
        }),
      },
      orchestrator: { orchestrateExpirationPost },
    });

    await expect(
      service.prepare({
        senderId: SENDER,
        inboundEvent: INBOUND,
        allowedProductIds: new Set([PRODUCT]),
        productId: PRODUCT,
      }),
    ).resolves.toEqual({
      kind: 'open_limit',
      reply: MINIMAL_EXPIRATION_OPEN_LIMIT_REPLY,
    });
    expect(orchestrateExpirationPost).not.toHaveBeenCalled();
  });
});

import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type {
  CheckoutContextAddress,
  CustomerCheckoutContext,
} from '../../../chatbot-api/domain/dtos/checkout-context.dto';
import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import { InMemoryConversationStore } from '../../../conversation/infrastructure/in-memory-conversation.store';
import { MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS } from '../../domain/minimal-checkout-address-references';
import { MinimalCheckoutService } from '../minimal-checkout.service';

const SENDER = '5215550001111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const T0 = Date.parse('2026-11-09T16:00:00.000Z');
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

const savedAddress = (): CheckoutContextAddress => ({
  id: ADDRESS,
  version: '2026-10-01T00:00:00.000Z',
  label: 'Casa',
  street: 'Av. Juárez',
  exteriorNumber: '10',
  interiorNumber: null,
  zipCode: '06000',
  neighborhood: 'Centro',
  municipality: 'Cuauhtémoc',
  city: null,
  state: 'Ciudad de México',
  visualReferences: null,
  carrierPhone: null,
});
const unique = (): CustomerCheckoutContext => ({
  status: 'unique',
  customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
  addresses: [savedAddress()],
  nextAfterAddressId: null,
});

function world() {
  let now = T0;
  const clock = () => now;
  const gateStore = new InMemoryConversationGateStore(() => new Date(now));
  const conversations = new InMemoryConversationStore();
  const api = {
    getCustomerCheckoutContext: jest.fn(() => Promise.resolve(unique())),
  } as unknown as ChatbotApiClient;
  const boot = () => {
    const gates = new ConversationGates(gateStore, clock);
    return {
      gates,
      checkout: new MinimalCheckoutService(api, conversations, gates),
    };
  };
  return {
    boot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function lookedUp(w: ReturnType<typeof world>) {
  const first = w.boot();
  const page = await first.checkout.lookup(SENDER, null);
  if (!page.ok || page.status !== 'unique') throw new Error('expected a page');
  await first.gates.settle(SENDER);
  return page.addresses[0].addressRef;
}

describe('checkout address references survive a restart (S4)', () => {
  it('a reference offered before the restart still selects the address', async () => {
    const w = world();
    const ref = await lookedUp(w);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    await expect(
      restarted.checkout.selectAddress(SENDER, ref),
    ).resolves.toEqual({ ok: true, ready: true, missing: [] });
  });

  it('the selection survives too: the summary is offered without re-selecting', async () => {
    const w = world();
    const ref = await lookedUp(w);
    const second = w.boot();
    await second.gates.begin(SENDER);
    await second.checkout.selectAddress(SENDER, ref);
    await second.gates.settle(SENDER);
    const third = w.boot();
    await third.gates.begin(SENDER);
    const offer = await third.checkout.prepareConfirmation(
      SENDER,
      EVENT('wamid.offer'),
    );
    expect(offer.reply).toContain('Av. Juárez');
    expect(offer.onSent).toBeDefined();
  });

  it('is absent after the five-minute TTL', async () => {
    const w = world();
    const ref = await lookedUp(w);
    w.advance(MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    await expect(
      restarted.checkout.selectAddress(SENDER, ref),
    ).resolves.toEqual({ ok: false, error: 'unknown_reference' });
  });
});

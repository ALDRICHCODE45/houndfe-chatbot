/**
 * The bot process the conversation eval drives (scripts/eval/README.md): the
 * real customer route, `MinimalCatalogAgentService`, with the production
 * services over in-memory stores and the backend fakes. Kept apart from
 * `conversation-eval.ts` (which runs on import) so specs can build the same
 * agent with a scripted model.
 */
import type { ConfigService } from '@nestjs/config';
import { ConversationGates } from '../../src/conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../src/conversation-gates/infrastructure/in-memory-conversation-gate.store';
import { InMemoryConversationStore } from '../../src/conversation/infrastructure/in-memory-conversation.store';
import { CustomerPetsService } from '../../src/customer-profile/application/customer-pets.service';
import { CustomerProfileService } from '../../src/customer-profile/application/customer-profile.service';
import { InMemoryCustomerProfileStore } from '../../src/customer-profile/infrastructure/in-memory-customer-profile.store';
import { InMemoryLocalPetStore } from '../../src/customer-profile/infrastructure/in-memory-local-pet.store';
import { CostGuardService } from '../../src/llm-agent/application/cost-guard.service';
import { MinimalCartService } from '../../src/llm-agent/application/minimal-cart.service';
import { MinimalCatalogAgentService } from '../../src/llm-agent/application/minimal-catalog-agent.service';
import { MinimalCheckoutService } from '../../src/llm-agent/application/minimal-checkout.service';
import { MinimalOrderService } from '../../src/llm-agent/application/minimal-order.service';
import { MinimalPaymentService } from '../../src/llm-agent/application/minimal-payment.service';
import { MinimalShippingService } from '../../src/llm-agent/application/minimal-shipping.service';
import type { CustomerReplyInteractive } from '../../src/llm-agent/domain/customer-reply';
import type { GenerateTextFn } from '../../src/llm-agent/infrastructure/generate-text.provider';
import { InMemoryMinimalCatalogSessionStore } from '../../src/llm-agent/infrastructure/in-memory-minimal-catalog-session.store';
import { EvalFakeApi, type FixtureCustomer } from './fixtures/fake-api';
import {
  EvalFakePetsClient,
  evalCustomerLookup,
} from './fixtures/fake-pets-client';

export const EVAL_SENDER = '5215550001111';
export const EVAL_CASHIER = '99999999-9999-4999-8999-999999999999';

/**
 * What outlives a bot restart in one scenario: the databases and the
 * backend. S1: the customer-profile store (`customer_profiles`, also the
 * prospects' local pets); S4: the conversation-gate store (`pet_choice` and
 * the other durable gates); the backend fake and its pets (T7).
 */
export interface EvalWorld {
  customer: FixtureCustomer;
  profiles: InMemoryCustomerProfileStore;
  gateStore: InMemoryConversationGateStore;
  api: EvalFakeApi;
  pets: EvalFakePetsClient;
}

export function createEvalWorld(customer: FixtureCustomer): EvalWorld {
  const api = new EvalFakeApi(customer);
  return {
    customer,
    profiles: new InMemoryCustomerProfileStore(),
    gateStore: new InMemoryConversationGateStore(),
    api,
    // Pet writes show up in the transcript next to the other backend calls.
    pets: new EvalFakePetsClient({ events: api.events }),
  };
}

export interface EvalLlmConfig {
  model: string;
  maxSteps: number;
  historyTurns: number;
}

/**
 * One bot process over `world`. A restart builds a new harness over the same
 * world: only the in-memory session, cart conversation store and the
 * services' process caches are lost.
 */
export function buildEvalHarness(
  world: EvalWorld,
  generate: GenerateTextFn,
  llm: EvalLlmConfig,
) {
  const { api } = world;
  const profileService = new CustomerProfileService(world.profiles);
  // Production: one ConversationGates for the route over the durable store.
  const gates = new ConversationGates(world.gateStore);
  const pets = new CustomerPetsService(
    new InMemoryLocalPetStore(world.profiles),
    evalCustomerLookup(world.customer, world.pets, api.orders),
    world.pets,
    profileService,
  );
  const store = new InMemoryConversationStore();
  const values: Record<string, unknown> = {
    'chatbotApi.cashierUserId': EVAL_CASHIER,
    llm,
  };
  // SAFETY: the services only call config.get with the keys in `values`.
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  const cart = new MinimalCartService(api, store);
  const checkout = new MinimalCheckoutService(api, store);
  const shipping = new MinimalShippingService(store, cart, checkout, api, {
    register: (request) => {
      api.events.push(`deliveryZoneIntake(zip ${request.zipCode ?? '?'})`);
      return Promise.resolve();
    },
  });
  const order = new MinimalOrderService(
    api,
    store,
    cart,
    checkout,
    config,
    shipping,
    undefined,
    profileService,
    gates,
    undefined,
    // S8: after an order a prospect's local pets upload to the new Customer.
    pets,
  );
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(10_000_000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    cart,
    checkout,
    order,
    shipping,
    profileService,
    gates,
    undefined,
    // The payment step after an order (bank details from the fake backend).
    new MinimalPaymentService(api, store),
    undefined,
    undefined,
    undefined,
    // Multi-pet: backend pets of a Customer, a local list for a prospect.
    pets,
  );
  return { api, agent, pets };
}

/**
 * Lets the reply-path background work (pet capture, afterCheckout upload)
 * finish against the in-memory fakes before the turn's backend activity is
 * read, so a write lands on the turn that caused it.
 */
export async function settleBackground(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** S4: "🔘 Botones: [a] [b]" / "📋 Lista (Ver opciones): a · b", or null. */
export function describeInteractive(
  interactive: CustomerReplyInteractive | undefined,
): string | null {
  if (interactive === undefined) return null;
  return interactive.type === 'buttons'
    ? `🔘 Botones: ${interactive.buttons.map((b) => `[${b.title}]`).join(' ')}`
    : `📋 Lista (${interactive.buttonText}): ${interactive.rows
        .map((r) => r.title)
        .join(' · ')}`;
}

import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type {
  BackorderBot,
  BackorderClient,
} from '../../backorders/domain/backorder';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService } from './cost-guard.service';
import { BackorderGates } from './gates/backorder.gates';
import { MinimalBackorderManageService } from './minimal-backorder-manage.service';
import { MinimalBackorderOfferService } from './minimal-backorder-offer.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { money } from '../domain/whatsapp-format';

/**
 * Restock backorder S1/S14 through the real customer turn: the reply right
 * after the estimate's offer is answered by code, never by the model, and the
 * durable gate still answers after a restart.
 */
const SENDER = '5215512349901';
const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const SCHEDULE = `backorder:schedule:${DECISION}`;
const DECLINE = `backorder:decline:${DECISION}`;
const OFFER = {
  senderId: SENDER,
  decisionId: DECISION,
  productId: PRODUCT,
  variantId: null,
  productName: 'Croquetas Adulto 18 kg',
  estimatedAt: '2026-11-27T15:00:00.000Z',
  statedQuantity: 2 as number | null,
};
const backorder = (quantity: number): BackorderBot => ({
  id: '8c1d0000-1111-4222-8333-444455556666',
  folio: 'BO-000012',
  status: 'WAITING',
  productId: PRODUCT,
  productName: 'Croquetas Adulto 18 kg',
  variantId: null,
  variantName: null,
  quantity,
  referencePriceCents: 114900,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: '2026-11-20T12:00:00.000Z',
  estimatedAt: '2026-11-27T15:00:00.000Z',
  estimatedArrivalDays: 7,
  reservedAt: null,
  reservedUntil: null,
  reminderAt: null,
  queuePosition: 1,
  saleId: null,
  cancelledByKind: null,
  cancelReason: null,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
});
const scheduled = (quantity: number) =>
  `Listo, quedó agendado su pedido *BO-000012*:\n• Croquetas Adulto 18 kg\n   ${quantity} × $1,149.00 = *${money(quantity * 114900)}*\n\nLe aviso en cuanto llegue (aprox. el 27 de noviembre); no paga nada hasta entonces.`;

function world() {
  const gateStore = new InMemoryConversationGateStore(() => new Date(T0));
  const createBackorder = jest.fn((input: { quantity: number }) =>
    Promise.resolve({ created: true, backorder: backorder(input.quantity) }),
  );
  const backorders = {
    createBackorder,
    getBackorder: jest.fn(),
    listBackorders: jest.fn(() => Promise.resolve([backorder(2)])),
    cancelBackorder: jest.fn(() => Promise.resolve(backorder(2))),
  } as unknown as BackorderClient;
  const api = {
    getCustomerCheckoutContext: jest.fn(() =>
      Promise.resolve({
        status: 'unique',
        customer: { customerId: CUSTOMER, firstName: 'Rosa', lastName: null },
        addresses: [],
        nextAfterAddressId: null,
      }),
    ),
  };
  const config = {
    get: () => ({ model: 'm', maxSteps: 5, historyTurns: 12 }),
  } as unknown as ConfigService;
  const seen: unknown[] = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    return generateText({
      ...input,
      model: new MockLanguageModelV4({
        doGenerate: async () =>
          ({
            content: [{ type: 'text', text: 'Respuesta del modelo.' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            warnings: [],
          }) as unknown as Awaited<
            ReturnType<MockLanguageModelV4['doGenerate']>
          >,
      }),
    });
  };
  /** One "process": gates, service and agent over the shared durable store. */
  const boot = () => {
    const gates = new ConversationGates(gateStore, () => T0);
    const service = new MinimalBackorderOfferService({
      backorders,
      chatbotApi: api as unknown as ChatbotApiClient,
      gates: new BackorderGates(gates),
      clock: () => T0,
    });
    const agent = new MinimalCatalogAgentService(
      api as unknown as ChatbotApiClient,
      generate,
      new CostGuardService(),
      config,
      new InMemoryMinimalCatalogSessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      gates,
      undefined,
      undefined,
      service,
      new MinimalBackorderManageService({ backorders, clock: () => T0 }),
    );
    return { agent, service, gates };
  };
  const first = boot();
  return {
    ...first,
    boot,
    createBackorder,
    backorders,
    modelCalls: () => seen.length,
    say: (
      p: ReturnType<typeof boot>,
      text: string,
      interactiveReplyId?: string,
    ) =>
      p.agent.tryHandle({
        senderId: SENDER,
        text,
        ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
      }),
  };
}

describe('the offer after the RESTOCK estimate, through the customer turn', () => {
  it.each([
    // The dispatcher turns a tapped button into its inbound text.
    ['the tapped button', 'SÍ', SCHEDULE],
    ['a bare yes', 'sí', undefined],
  ])('%s schedules the backorder without the model', async (_l, text, id) => {
    const w = world();
    await w.service.arm(OFFER);
    const decision = await w.say(w, text, id);
    expect(decision).toEqual({ kind: 'handled', reply: scheduled(2) });
    expect(w.createBackorder).toHaveBeenCalledTimes(1);
    expect(w.modelCalls()).toBe(0);
  });

  it.each([
    ['the tapped button', 'No, gracias', DECLINE],
    ['a bare no', 'no', undefined],
  ])('%s declines without the model', async (_l, text, id) => {
    const w = world();
    await w.service.arm(OFFER);
    const decision = await w.say(w, text, id);
    expect(decision).toEqual({
      kind: 'handled',
      reply: 'Entendido. ¡Que esté muy bien!',
    });
    expect(w.createBackorder).not.toHaveBeenCalled();
    expect(w.modelCalls()).toBe(0);
  });

  it('asks the count when none was stated, then a number schedules it (no model)', async () => {
    const w = world();
    await w.service.arm({ ...OFFER, statedQuantity: null });
    await expect(w.say(w, 'sí')).resolves.toEqual({
      kind: 'handled',
      reply: '¿Cuántas piezas le aparto?',
    });
    await expect(w.say(w, '3')).resolves.toEqual({
      kind: 'handled',
      reply: scheduled(3),
    });
    expect(w.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 3 }),
      `backorder:${DECISION}:${SENDER}`,
    );
    expect(w.modelCalls()).toBe(0);
  });

  it('any other message spends the offer and the normal turn answers it', async () => {
    const w = world();
    await w.service.arm(OFFER);
    const decision = await w.say(w, '¿cuánto cuesta el envío?');
    expect(decision).toMatchObject({
      kind: 'handled',
      reply: 'Respuesta del modelo.',
    });
    expect(w.modelCalls()).toBe(1);
    expect(w.createBackorder).not.toHaveBeenCalled();
    // The offer is gone: a later yes is no longer an answer to it.
    await w.say(w, 'sí');
    expect(w.createBackorder).not.toHaveBeenCalled();
  });

  it('a button of another decision is stale: nothing is scheduled, no model', async () => {
    const w = world();
    await w.service.arm(OFFER);
    const decision = await w.say(w, 'SÍ', `backorder:schedule:${OTHER}`);
    expect(decision).toMatchObject({ kind: 'handled' });
    expect(w.createBackorder).not.toHaveBeenCalled();
    expect(w.modelCalls()).toBe(0);
  });

  it('a tap with no offer at all is stale too', async () => {
    const w = world();
    const decision = await w.say(w, 'SÍ', SCHEDULE);
    expect(decision).toMatchObject({ kind: 'handled' });
    expect(w.createBackorder).not.toHaveBeenCalled();
    expect(w.modelCalls()).toBe(0);
  });

  it('restart: a new process still answers the durable offer', async () => {
    const w = world();
    await w.service.arm(OFFER);
    const restarted = w.boot();
    const decision = await w.say(restarted, 'SÍ', SCHEDULE);
    expect(decision).toEqual({ kind: 'handled', reply: scheduled(2) });
    expect(w.createBackorder).toHaveBeenCalledTimes(1);
    expect(w.modelCalls()).toBe(0);
  });

  it('restart: the asked-count state is durable too', async () => {
    const w = world();
    await w.service.arm({ ...OFFER, statedQuantity: null });
    await w.say(w, 'sí');
    const restarted = w.boot();
    await expect(w.say(restarted, '4')).resolves.toEqual({
      kind: 'handled',
      reply: scheduled(4),
    });
  });

  it('a double tap schedules once (the durable row is spent atomically)', async () => {
    const w = world();
    await w.service.arm(OFFER);
    const other = w.boot();
    const [a, b] = await Promise.all([
      w.say(w, 'SÍ', SCHEDULE),
      w.say(other, 'SÍ', SCHEDULE),
    ]);
    expect(w.createBackorder).toHaveBeenCalledTimes(1);
    expect([a, b].filter((d) => d.kind === 'handled')).toHaveLength(2);
  });
});

describe('the offer and the S8 cancel share the turn', () => {
  it('a cancel request spends a live offer; the next yes cancels, it never schedules', async () => {
    const w = world();
    await w.service.arm(OFFER);
    const asked = await w.say(w, 'cancela mi pedido por reposición');
    expect(asked).toMatchObject({
      kind: 'handled',
      reply: '¿Cancelo su pedido BO-000012 de 2 × Croquetas Adulto 18 kg?',
    });
    await expect(w.say(w, 'sí')).resolves.toMatchObject({
      reply: 'Listo, cancelé su pedido BO-000012.',
    });
    expect(w.createBackorder).not.toHaveBeenCalled();
    expect(w.modelCalls()).toBe(0);
  });

  it('a tapped offer button is still the offer’s, not the cancel flow’s', async () => {
    const w = world();
    await w.service.arm(OFFER);
    await expect(w.say(w, 'SÍ', SCHEDULE)).resolves.toEqual({
      kind: 'handled',
      reply: scheduled(2),
    });
    expect(w.backorders.cancelBackorder).not.toHaveBeenCalled();
  });

  it('with a live offer a bare yes still answers the offer (not a cancel)', async () => {
    const w = world();
    await w.service.arm(OFFER);
    await expect(w.say(w, 'sí')).resolves.toEqual({
      kind: 'handled',
      reply: scheduled(2),
    });
    expect(w.backorders.listBackorders).not.toHaveBeenCalled();
  });
});

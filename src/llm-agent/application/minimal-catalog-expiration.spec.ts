import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { deriveExpirationSourceRequestId } from '../../human-decisions/domain/expiration-source-identity';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import type { MinimalRestockRequestService } from './minimal-restock-request.service';
import {
  MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
  MinimalExpirationRequestService,
} from './minimal-expiration-request.service';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const BACKEND = '99999999-9999-4999-8999-999999999999';
const INBOUND = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.E1',
};
const SOURCE = deriveExpirationSourceRequestId(INBOUND) as string;
const REGISTERED =
  '¡Listo! 😊 Su consulta ya quedó registrada con el equipo de HoundFe.';
const usage = {
  inputTokens: { total: 1 },
  outputTokens: { total: 1 },
} as never;
const step = (content: unknown[], finish: string) => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage,
  warnings: [],
});
const say = (text: string) => step([{ type: 'text', text }], 'stop');
const call = (id: string, name: string, input: unknown) =>
  step(
    [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    'tool-calls',
  );
const STOCK = {
  productId: PRODUCT,
  name: 'Ibuprofeno 400 mg',
  stock: { status: 'available', quantity: 5 },
  variants: [],
};

function expiration(outcome: unknown, enabled = true) {
  const reserve = jest
    .fn()
    .mockResolvedValue({ action: 'claim', reason: 'single_sender_vacant' });
  const orchestrate = jest.fn().mockResolvedValue(outcome);
  return {
    reserve,
    orchestrate,
    service: new MinimalExpirationRequestService({
      chatbotApi: { getStock: jest.fn().mockResolvedValue(STOCK) },
      reservations: { reserve },
      orchestrator: { orchestrateExpirationPost: orchestrate },
      enabled,
    }),
  };
}

function build(
  steps: unknown,
  expirationService?: MinimalExpirationRequestService,
  restock?: MinimalRestockRequestService,
) {
  const model = new MockLanguageModelV4({ doGenerate: steps } as never);
  const chatbotApi = {
    searchCatalog: jest.fn().mockResolvedValue([STOCK]),
    getStock: jest.fn().mockResolvedValue(STOCK),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: (path: string) =>
      path === 'minimalCatalogAgent'
        ? { enabled: true, allowedSenders: [SENDER] }
        : { model: 'm', maxSteps: 4, historyTurns: 12 },
  } as unknown as ConfigService;
  const captured: Array<{ system?: unknown; tools?: Record<string, unknown> }> =
    [];
  const generate = async (options: unknown) => {
    captured.push(options as never);
    return generateText({ ...(options as object), model } as never);
  };
  return {
    service: new MinimalCatalogAgentService(
      chatbotApi,
      generate as never,
      new CostGuardService(1_000_000),
      config,
      new InMemoryMinimalCatalogSessionStore(),
      restock,
      expirationService,
    ),
    chatbotApi,
    captured,
  };
}

const invoke = (service: MinimalCatalogAgentService, inboundEvent?: unknown) =>
  service.tryHandle({
    senderId: SENDER,
    text: '¿cuándo caduca?',
    ...(inboundEvent === undefined ? {} : { inboundEvent }),
  });

describe('MinimalCatalogAgentService EXPIRATION capability (default-off E1)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exposes prepareExpiration only when enabled and the inbound is bound', async () => {
    const off = build([say('hola')], expiration({}, false).service);
    const unbound = build([say('hola')], expiration({}).service);
    const bound = build([say('hola')], expiration({}).service);
    await invoke(off.service);
    await invoke(unbound.service);
    await invoke(bound.service, INBOUND);
    expect(off.captured[0].tools).not.toHaveProperty('prepareExpiration');
    expect(unbound.captured[0].tools).not.toHaveProperty('prepareExpiration');
    expect(bound.captured[0].tools).toHaveProperty('prepareExpiration');
    expect(String(off.captured[0].system)).not.toContain('prepareExpiration');
    expect(String(bound.captured[0].system)).toContain('prepareExpiration');
  });

  it.each(['receipt_recorded', 'blocked'])(
    'returns the SERVER reply for %s',
    async (action) => {
      const h = expiration({ action, backendDecisionId: BACKEND });
      const { service, chatbotApi } = build(
        [
          call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
          call('e1', 'prepareExpiration', { productId: PRODUCT }),
          say('¡Listo! ya quedó registrado (texto del modelo)'),
        ],
        h.service,
      );
      await expect(invoke(service, INBOUND)).resolves.toEqual({
        kind: 'handled',
        reply:
          action === 'receipt_recorded'
            ? REGISTERED
            : MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
      });
      expect(chatbotApi.searchCatalog).toHaveBeenCalledWith('ibuprofeno');
      expect(h.reserve).toHaveBeenCalledWith({
        senderId: SENDER,
        route: 'EXPIRATION',
        requestKey: SOURCE,
        intake: {
          sourceRequestId: SOURCE,
          type: 'EXPIRATION',
          productId: PRODUCT,
          variantId: null,
        },
      });
      expect(h.orchestrate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['repeat', 'restock-first', 'expiration-first', 'restock-only'])(
    'preserves the EXPIRATION acknowledgement: %s',
    async (order) => {
      const h = expiration({
        action: 'receipt_recorded',
        backendDecisionId: BACKEND,
      });
      const prepare = jest.spyOn(h.service, 'prepare');
      const onSent = jest.fn();
      const restock = {
        enabled: true,
        consume: jest.fn().mockResolvedValue(null),
        prepare: jest
          .fn()
          .mockResolvedValue({ kind: 'offer', reply: 'RESTOCK?', onSent }),
      };
      const expiry = call('e1', 'prepareExpiration', { productId: PRODUCT });
      const other =
        order === 'repeat'
          ? call('e2', 'prepareExpiration', { productId: BACKEND })
          : call('r1', 'prepareRestock', { productId: PRODUCT });
      const calls =
        order === 'restock-only'
          ? [other]
          : order === 'restock-first'
            ? [other, expiry]
            : [expiry, other];
      const { service } = build(
        [
          call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
          ...calls,
          say('model'),
        ],
        h.service,
        restock as unknown as MinimalRestockRequestService,
      );
      const restockOnly = order === 'restock-only';
      await expect(invoke(service, INBOUND)).resolves.toEqual({
        kind: 'handled',
        reply: restockOnly ? 'RESTOCK?' : REGISTERED,
        ...(restockOnly ? { onSent } : {}),
      });
      expect(prepare).toHaveBeenCalledTimes(restockOnly ? 0 : 1);
      expect(h.reserve).toHaveBeenCalledTimes(restockOnly ? 0 : 1);
      expect(h.orchestrate).toHaveBeenCalledTimes(restockOnly ? 0 : 1);
      expect(restock.prepare).toHaveBeenCalledTimes(order === 'repeat' ? 0 : 1);
      expect(onSent).not.toHaveBeenCalled();
    },
  );
});

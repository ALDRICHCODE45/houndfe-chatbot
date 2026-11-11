import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  AskTeamOutcome,
  HumanRequestCreateService,
} from '../../human-requests/application/human-request-create.service';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MINIMAL_EXPIRATION_CAUTIOUS_REPLY } from './minimal-expiration-request.service';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const INBOUND = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.Q1',
};
const QUESTION = '¿Este collar sirve para un gato de 3 kg?';
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

const ASK = {
  question: QUESTION,
  summary: 'Compatibilidad de collar con gato de 3 kg',
  productIds: [PRODUCT],
};

function build(
  steps: unknown,
  askTeam?: Pick<HumanRequestCreateService, 'askTeam'>,
) {
  const model = new MockLanguageModelV4({ doGenerate: steps } as never);
  const chatbotApi = {
    searchCatalog: jest.fn().mockResolvedValue([]),
    getStock: jest.fn(),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: () => ({ model: 'm', maxSteps: 4, historyTurns: 12 }),
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      askTeam,
    ),
    captured,
  };
}

const team = (outcome: AskTeamOutcome | Error) => ({
  askTeam: jest.fn(() =>
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome),
  ),
});

const invoke = (
  service: MinimalCatalogAgentService,
  text = QUESTION,
  extra: { inboundAt?: string } = { inboundAt: '2026-11-10T16:19:30.000Z' },
) =>
  service.tryHandle({
    senderId: SENDER,
    text,
    inboundEvent: INBOUND,
    ...extra,
  });

describe('MinimalCatalogAgentService askTeam (S6 UNKNOWN_QUESTION)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exposes askTeam and its prompt rule only when the create path is wired', async () => {
    const off = build([say('hola')]);
    const on = build([say('hola')], team({ kind: 'queued' }));
    await invoke(off.service);
    await invoke(on.service);
    expect(off.captured[0].tools).not.toHaveProperty('askTeam');
    expect(on.captured[0].tools).toHaveProperty('askTeam');
    expect(String(off.captured[0].system)).not.toContain('askTeam');
    const system = String(on.captured[0].system);
    expect(system).toContain('Herramienta askTeam');
    expect(system).toContain(
      'Nunca inventes lo que decide una persona del equipo',
    );
    expect(system).toContain('sigue ayudando con lo demás');
  });

  it('creates with the customer question, the inbound time and wamid', async () => {
    const h = team({ kind: 'registered', requestId: 'r-1' });
    const app = build([call('a1', 'askTeam', ASK), say('texto del modelo')], h);
    await invoke(app.service);
    expect(h.askTeam).toHaveBeenCalledWith({
      senderId: SENDER,
      question: QUESTION,
      summary: 'Compatibilidad de collar con gato de 3 kg',
      productIds: [PRODUCT],
      inboundAt: '2026-11-10T16:19:30.000Z',
      triggerWaMessageId: 'wamid.Q1',
    });
  });

  it.each([
    [
      { kind: 'registered', requestId: 'r-1' },
      'Ya le pregunté al equipo, le aviso por aquí en cuanto me respondan.',
    ],
    [
      { kind: 'open_limit' },
      'Ya tiene varias consultas abiertas con el equipo; en cuanto respondan le aviso por aquí.',
    ],
    [
      { kind: 'customer_rate_limited' },
      'El equipo ya tiene sus consultas recientes; por favor espere un poco antes de enviar otra.',
    ],
    [
      { kind: 'queued' },
      'Estoy registrando su consulta con el equipo; le aviso por aquí.',
    ],
    [
      { kind: 'failed', reason: 'SUBTYPE_DISABLED' },
      MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
    ],
  ] as const)('%j → the fixed server reply', async (outcome, reply) => {
    const app = build(
      [
        call('a1', 'askTeam', ASK),
        say('¡Listo! El equipo ya respondió que sí (texto del modelo)'),
      ],
      team(outcome),
    );
    await expect(invoke(app.service)).resolves.toMatchObject({ reply });
  });

  it('a throwing create path still answers the cautious reply', async () => {
    const app = build(
      [call('a1', 'askTeam', ASK), say('texto')],
      team(new Error('boom')),
    );
    await expect(invoke(app.service)).resolves.toMatchObject({
      reply: MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
    });
  });

  it('styles the fixed reply for a customer who tutea', async () => {
    const app = build(
      [call('a1', 'askTeam', ASK), say('texto')],
      team({ kind: 'registered', requestId: 'r-1' }),
    );
    await expect(
      invoke(app.service, 'oye, ¿sabes si este collar le queda a mi gato?'),
    ).resolves.toMatchObject({
      reply:
        'Ya le pregunté al equipo, te aviso por aquí en cuanto me respondan.',
    });
  });

  it('creates at most once per turn', async () => {
    const h = team({ kind: 'registered', requestId: 'r-1' });
    const app = build(
      [
        call('a1', 'askTeam', ASK),
        call('a2', 'askTeam', { ...ASK, question: 'otra' }),
        say('texto'),
      ],
      h,
    );
    await invoke(app.service);
    expect(h.askTeam).toHaveBeenCalledTimes(1);
  });

  it('rejects an over-long summary before executing the tool', async () => {
    const h = team({ kind: 'registered', requestId: 'r-1' });
    const app = build(
      [
        call('a1', 'askTeam', { ...ASK, summary: 'x'.repeat(141) }),
        say('No pude registrarla.'),
      ],
      h,
    );
    await invoke(app.service);
    expect(h.askTeam).not.toHaveBeenCalled();
  });

  it('omits the trigger and inbound time when the turn has none', async () => {
    const h = team({ kind: 'queued' });
    const app = build([call('a1', 'askTeam', ASK), say('texto')], h);
    await app.service.tryHandle({ senderId: SENDER, text: QUESTION });
    expect(h.askTeam).toHaveBeenCalledWith({
      senderId: SENDER,
      question: QUESTION,
      summary: 'Compatibilidad de collar con gato de 3 kg',
      productIds: [PRODUCT],
    });
  });
});

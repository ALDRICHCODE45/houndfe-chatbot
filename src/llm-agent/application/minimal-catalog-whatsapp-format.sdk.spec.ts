import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

/**
 * H1: model-authored customer text is rewritten for WhatsApp at the return
 * boundary, and the session history stores the formatted text.
 */
const SENDER = '5215550002222';

const say = (text: string) => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});

function harness(modelText: string) {
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? ''
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  const seen: Array<{ system?: unknown }> = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    return generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: [say(modelText)] } as never),
    });
  };
  const sessions = new InMemoryMinimalCatalogSessionStore();
  const agent = new MinimalCatalogAgentService(
    new EvalFakeApi({ kind: 'new' }),
    generate,
    new CostGuardService(100000),
    config,
    sessions,
  );
  return { agent, seen, sessions };
}

const assistantTexts = (
  sessions: InMemoryMinimalCatalogSessionStore,
): string[] =>
  sessions.read(SENDER).flatMap((turn) =>
    turn.messages.flatMap((message) => {
      if (message.role !== 'assistant') return [];
      if (typeof message.content === 'string') return [message.content];
      return message.content.flatMap((part) =>
        part.type === 'text' ? [part.text] : [],
      );
    }),
  );

describe('H1 WhatsApp formatting of model text', () => {
  const markdown = [
    '## Opciones',
    '- **Pro Plan 3 kg**  ',
    '  Precio: $649.00',
    '  ![Imagen](https://cdn.example.test/products/a.jpg)',
    '  [Imagen](https://cdn.example.test/products/a.jpg)',
  ].join('\n');
  const formatted = 'Opciones\n• *Pro Plan 3 kg*\n  Precio: $649.00';

  it('sends WhatsApp text without Markdown bold, images, links or headings', async () => {
    const h = harness(markdown);
    const decision = await h.agent.tryHandle({
      senderId: SENDER,
      text: 'hola',
    });
    expect(decision).toMatchObject({ kind: 'handled', reply: formatted });
  });

  it('stores the formatted text in the session history', async () => {
    const h = harness(markdown);
    await h.agent.tryHandle({ senderId: SENDER, text: 'hola' });
    const stored = assistantTexts(h.sessions);
    expect(stored).toContain(formatted);
    expect(stored.join('\n')).not.toContain('**');
    expect(stored.join('\n')).not.toContain('https://');
  });

  it('tells the model to write for WhatsApp', async () => {
    const h = harness('Hola');
    await h.agent.tryHandle({ senderId: SENDER, text: 'hola' });
    const value = h.seen.at(-1)?.system;
    const system = typeof value === 'string' ? value : '';
    expect(system).toMatch(/WhatsApp/);
    expect(system).toMatch(/un solo asterisco/);
    expect(system).toMatch(/sin im[aá]genes ni enlaces Markdown/);
  });
});

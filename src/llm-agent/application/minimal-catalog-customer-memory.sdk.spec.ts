import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import type { CustomerProfileStore } from '../../customer-profile/domain/customer-profile';
import { InMemoryCustomerProfileStore } from '../../customer-profile/infrastructure/in-memory-customer-profile.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { applyCustomerStyle } from '../domain/customer-style';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import {
  FORGET_MY_DATA_REPLY,
  MinimalCatalogAgentService,
} from './minimal-catalog-agent.service';

/**
 * S1 persistent customer memory on the real customer route: the stored
 * style seeds a fresh session, the "Cliente conocido" prompt line, the
 * rememberPetDetails tool, per-turn style/name writes and "olvida mis datos".
 */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-07T12:00:00.000Z');

const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (toolName: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${toolName}-${Math.random()}`,
      toolName,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Texto del modelo.') =>
  step([{ type: 'text', text }], 'stop');

function harness(profileStore: CustomerProfileStore) {
  const api = new EvalFakeApi({ kind: 'new' });
  const store = new InMemoryConversationStore();
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? ''
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  const seen: Array<{ system?: unknown; tools?: Record<string, unknown> }> = [];
  let scripts: unknown[][] = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const script = scripts.shift() ?? [say()];
    return generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: script } as never),
    });
  };
  const profiles = new CustomerProfileService(profileStore, () => NOW);
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    new MinimalCartService(api, store),
    undefined,
    undefined,
    undefined,
    profiles,
  );
  const turn = async (
    text: string,
    runs: unknown[][] = [],
    extra: { profileName?: string } = {},
  ) => {
    scripts = runs.length === 0 ? [[say()]] : runs;
    return agent.tryHandle({ senderId: SENDER, text, ...extra });
  };
  const system = () => {
    const value = seen.at(-1)?.system;
    return typeof value === 'string' ? value : '';
  };
  return { agent, seen, system, turn };
}

describe('S1 persistent customer memory', () => {
  it('a fresh session (after a restart) starts with the stored tú style', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      { register: 'tu', emojis: true, tone: 'casual' },
      NOW,
    );
    const h = harness(profileStore);
    expect(h.agent.customerStyle(SENDER, 'hola').register).toBe('usted');
    await h.turn('hola');
    expect(h.system()).toContain('Estilo del cliente: tutea');
    expect(h.agent.customerStyle(SENDER, 'gracias').register).toBe('tu');
  });

  it('the current explicit usted wins over the stored tú', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(SENDER, { register: 'tu' }, NOW);
    const h = harness(profileStore);
    await h.turn('Buenas tardes, ¿usted me podría ayudar?');
    expect(h.system()).toContain('Estilo del cliente: de usted');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      register: 'usted',
    });
  });

  it('persists the latest explicit style; a message with no signal keeps it', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    await h.turn('oye, ¿tienes croquetas? 😄');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      register: 'tu',
      emojis: true,
      tone: 'casual',
    });
    // A restart later: "hola" carries no register, the stored tú stays.
    const next = harness(profileStore);
    await next.turn('hola');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      register: 'tu',
      // No emoji in the latest messages: no emojis (S5 rule).
      emojis: false,
    });
    expect(next.system()).toContain('Estilo del cliente: tutea');
  });

  it('adds the "Cliente conocido" line with name, pet and last order (never the phone)', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      {
        displayName: 'Ana P',
        preferredName: 'Anita',
        pet: { name: 'Luna', species: 'perro', breed: 'labrador' },
        lastOrder: {
          folio: 'A-12',
          confirmedAt: '2026-11-01T10:00:00.000Z',
          totalCents: 89900,
        },
      },
      NOW,
    );
    const h = harness(profileStore);
    await h.turn('hola');
    const line = h
      .system()
      .split('\n')
      .find((text) => text.startsWith('Cliente conocido:'));
    expect(line).toBeDefined();
    expect(line).toContain('"Anita"');
    expect(line).toContain('"Luna"');
    expect(line).toContain('A-12');
    expect(h.system()).not.toContain(SENDER);
  });

  it('has no "Cliente conocido" line for an unknown customer', async () => {
    const h = harness(new InMemoryCustomerProfileStore());
    await h.turn('hola');
    expect(h.system()).not.toContain('Cliente conocido:');
  });

  it('rememberPetDetails stores only what the model passes, merged with earlier facts', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    expect(Object.keys(h.seen.at(-1)?.tools ?? {})).toEqual([]);
    await h.turn('mi perrita Luna es una labrador de 3 años', [
      [
        call('rememberPetDetails', {
          name: 'Luna',
          species: 'perro',
          breed: 'labrador',
          ageText: '3 años',
        }),
        say('¡Qué linda Luna!'),
      ],
    ]);
    expect(Object.keys(h.seen[0].tools ?? {})).toContain('rememberPetDetails');
    expect(h.system()).toMatch(/rememberPetDetails/);
    expect(h.system()).toMatch(/una sola pregunta sobre la mascota/i);
    await h.turn('ya está grande, pesa 30 kg', [
      [call('rememberPetDetails', { size: 'grande' }), say('Entendido.')],
    ]);
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      pet: {
        name: 'Luna',
        species: 'perro',
        breed: 'labrador',
        ageText: '3 años',
        size: 'grande',
      },
    });
  });

  it('stores the WhatsApp profile name and an explicit "llámame X"', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    await h.turn('hola', [], { profileName: 'Ana Pérez' });
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      displayName: 'Ana Pérez',
    });
    await h.turn('llámame Anita por favor');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      displayName: 'Ana Pérez',
      preferredName: 'Anita',
    });
  });

  it('"olvida mis datos" deletes the profile, confirms without the model and stops writing', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      { preferredName: 'Anita', register: 'tu', pet: { name: 'Luna' } },
      NOW,
    );
    const h = harness(profileStore);
    await h.turn('hola');
    const calls = h.seen.length;
    const forgot = await h.turn('olvida mis datos porfa');
    expect(h.seen).toHaveLength(calls);
    // Styled with the style known when the request arrived (tú).
    expect(forgot.reply).toBe(
      applyCustomerStyle(FORGET_MY_DATA_REPLY, {
        register: 'tu',
        emojis: false,
        tone: 'casual',
      }),
    );
    expect(forgot.reply).not.toMatch(/\b(usted|su|sus)\b/);
    await expect(profileStore.read(SENDER)).resolves.toBeNull();
    await h.turn('oye, ¿tienes collares?', [], { profileName: 'Ana' });
    await expect(profileStore.read(SENDER)).resolves.toBeNull();
    expect(h.system()).not.toContain('Cliente conocido:');
  });

  it('a failing profile store never blocks the reply', async () => {
    const failing: CustomerProfileStore = {
      read: () => Promise.reject(new Error('down')),
      upsert: () => Promise.reject(new Error('down')),
      delete: () => Promise.reject(new Error('down')),
    };
    const h = harness(failing);
    const result = await h.turn('hola', [[say('Hola, ¿en qué le ayudo?')]]);
    expect(result.reply).toBe('Hola, ¿en qué le ayudo?');
    expect(h.system()).toContain('Estilo del cliente: de usted');
  });
});

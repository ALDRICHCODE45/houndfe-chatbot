import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  CheckoutContextAddress,
  CustomerCheckoutContext,
} from '../../chatbot-api/domain/dtos/checkout-context.dto';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import {
  MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
  MINIMAL_CHECKOUT_CHANGED_REPLY,
  MINIMAL_CHECKOUT_CONFIRMED_REPLY,
  MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
} from '../domain/minimal-checkout-confirmation';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCartService } from './minimal-cart.service';
import {
  MINIMAL_CHECKOUT_INCOMPLETE_REPLY,
  MINIMAL_CHECKOUT_RESELECT_REPLY,
  MinimalCheckoutService,
} from './minimal-checkout.service';

const SENDER = '5215550001111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const ADDRESS_2 = '44444444-4444-4444-8444-444444444444';
const VERSION = '2026-10-01T00:00:00.000Z';
const EVENT = (messageId: string, senderId = SENDER) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId,
  messageId,
});

const savedAddress = (
  overrides: Partial<CheckoutContextAddress> = {},
): CheckoutContextAddress => ({
  id: ADDRESS,
  version: VERSION,
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
  ...overrides,
});
const unique = (
  addresses: CheckoutContextAddress[] = [savedAddress()],
  nextAfterAddressId: string | null = null,
): CustomerCheckoutContext => ({
  status: 'unique',
  customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
  addresses,
  nextAfterAddressId,
});
const absent = (
  status: 'not_found' | 'ambiguous',
): CustomerCheckoutContext => ({
  status,
  customer: null,
  addresses: [],
  nextAfterAddressId: null,
});

const DETAILS_KEYS = [
  'firstName',
  'lastName',
  'label',
  'street',
  'exteriorNumber',
  'interiorNumber',
  'zipCode',
  'neighborhood',
  'municipality',
  'city',
  'state',
  'visualReferences',
  'carrierPhone',
] as const;
const details = (
  values: Partial<Record<(typeof DETAILS_KEYS)[number], string>>,
  useNewAddress = true,
) => ({
  ...Object.fromEntries(DETAILS_KEYS.map((key) => [key, values[key] ?? null])),
  useNewAddress,
});
const COMPLETE = {
  firstName: 'Ana',
  street: 'Calle 5',
  exteriorNumber: 'S/N',
  neighborhood: 'Roma',
  zipCode: '06700',
  city: 'CDMX',
  state: 'Ciudad de México',
};

const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (name: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${name}-${Math.random()}`,
      toolName: name,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Listo.') => step([{ type: 'text', text }], 'stop');

function setup(
  options: { checkout?: boolean; context?: () => Promise<unknown> } = {},
) {
  const store = new InMemoryConversationStore();
  const getCustomerCheckoutContext = jest.fn(
    options.context ?? (() => Promise.resolve(unique())),
  );
  const forbidden = {
    upsertCustomer: jest.fn(),
    createSale: jest.fn(),
    attachReceipt: jest.fn(),
    getPaymentDetails: jest.fn(),
    cancelSale: jest.fn(),
    updateDelivery: jest.fn(),
    evaluateCart: jest.fn(),
  };
  const api = {
    searchCatalog: jest.fn().mockResolvedValue([]),
    getStock: jest.fn(),
    getCustomerCheckoutContext,
    ...forbidden,
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: (key: string) =>
      key === 'minimalCatalogAgent'
        ? { enabled: true, allowedSenders: [SENDER] }
        : { model: 'm', maxSteps: 5, historyTurns: 12 },
  } as unknown as ConfigService;
  let steps: unknown[] = [];
  const seen: Array<{ system?: unknown; tools?: Record<string, unknown> }> = [];
  const outputs: unknown[] = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const result = await generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: steps } as never),
    });
    outputs.push(
      ...result.steps.flatMap((s) => s.toolResults.map((r) => r.output)),
    );
    return result;
  };
  const build = () =>
    new MinimalCatalogAgentService(
      api,
      generate,
      new CostGuardService(100000),
      config,
      new InMemoryMinimalCatalogSessionStore(),
      undefined,
      undefined,
      new MinimalCartService(api, store),
      options.checkout === false
        ? undefined
        : new MinimalCheckoutService(api, store),
    );
  let agent = build();
  return {
    store,
    api,
    forbidden,
    getCustomerCheckoutContext,
    seen,
    outputs,
    restart: () => {
      agent = build();
    },
    turn: async (text: string, script: unknown[], event?: unknown) => {
      steps = script;
      outputs.length = 0;
      return agent.tryHandle({
        senderId: SENDER,
        text,
        ...(event === undefined ? {} : { inboundEvent: event }),
      });
    },
    draft: async () =>
      (await store.get(SENDER))?.data.minimalCheckoutDraft as
        | Record<string, unknown>
        | undefined,
  };
}

const lookup = (nextPageRef: string | null = null) =>
  call('lookupCheckoutCustomer', { nextPageRef });
const firstRef = (output: unknown): string =>
  (output as { addresses: Array<{ addressRef: string }> }).addresses[0]
    .addressRef;

async function collectComplete(h: ReturnType<typeof setup>) {
  await h.turn('Mis datos', [
    call('updateCheckoutDetails', details(COMPLETE)),
    say(),
  ]);
}

describe('MinimalCheckoutService through the minimal SDK route', () => {
  it('looks up the trusted sender and offers opaque sender-owned address references', async () => {
    const h = setup();
    await h.turn('Quiero comprar', [lookup(), say()]);
    expect(h.getCustomerCheckoutContext).toHaveBeenCalledWith(
      '52',
      '5550001111',
      { limit: 10, afterAddressId: null },
    );
    const output = h.outputs[0] as Record<string, unknown>;
    expect(output).toMatchObject({
      ok: true,
      status: 'unique',
      customerFirstName: 'Ana',
      nextPageRef: null,
    });
    expect(JSON.stringify(output)).not.toContain(ADDRESS);
    expect(JSON.stringify(output)).not.toContain(CUSTOMER);
    expect(firstRef(output)).toEqual(expect.any(String));
    expect(await h.draft()).toBeUndefined();
  });

  it.each([
    ['not_found', () => Promise.resolve(absent('not_found'))],
    ['ambiguous', () => Promise.resolve(absent('ambiguous'))],
  ] as const)(
    'reports a distinct %s lookup without touching the draft',
    async (status, context) => {
      const h = setup({ context });
      await h.turn('Quiero comprar', [lookup(), say()]);
      expect(h.outputs[0]).toEqual({ ok: true, status, addresses: [] });
      expect(await h.draft()).toBeUndefined();
    },
  );

  it('reports a failed lookup as unavailable, never as absence', async () => {
    const h = setup({ context: () => Promise.reject(new Error('boom')) });
    await h.turn('Quiero comprar', [lookup(), say()]);
    expect(h.outputs[0]).toEqual({ ok: false, error: 'lookup_unavailable' });
    expect(await h.draft()).toBeUndefined();
  });

  it('follows only a server-issued next-page reference, one bounded page at a time', async () => {
    const h = setup({
      context: jest
        .fn()
        .mockResolvedValueOnce(unique([savedAddress()], ADDRESS))
        .mockResolvedValueOnce(
          unique([savedAddress({ id: ADDRESS_2, label: 'Trabajo' })]),
        ),
    });
    await h.turn('Mis direcciones', [lookup(), say()]);
    const next = (h.outputs[0] as { nextPageRef: string }).nextPageRef;
    expect(next).toEqual(expect.any(String));
    await h.turn('Más', [lookup(next), say()]);
    expect(h.getCustomerCheckoutContext).toHaveBeenLastCalledWith(
      '52',
      '5550001111',
      { limit: 10, afterAddressId: ADDRESS },
    );
    expect(h.outputs[0]).toMatchObject({ ok: true, status: 'unique' });
    await h.turn('Otra', [lookup('forged-ref'), say()]);
    expect(h.outputs[0]).toEqual({ ok: false, error: 'unknown_reference' });
    expect(h.getCustomerCheckoutContext).toHaveBeenCalledTimes(2);
  });

  it('selects a saved address only through a valid reference and stores an exact snapshot', async () => {
    const h = setup();
    await h.turn('Quiero comprar', [lookup(), say()]);
    const ref = firstRef(h.outputs[0]);
    await h.turn('La primera', [
      call('selectCheckoutAddress', { addressRef: 'forged' }),
      say(),
    ]);
    expect(h.outputs[0]).toEqual({ ok: false, error: 'unknown_reference' });
    expect(await h.draft()).toBeUndefined();

    await h.turn('La primera', [
      call('selectCheckoutAddress', { addressRef: ref }),
      say(),
    ]);
    expect(h.outputs[0]).toMatchObject({ ok: true, ready: true, missing: [] });
    expect(await h.draft()).toEqual({
      schemaVersion: 1,
      senderId: SENDER,
      revision: 0,
      sourceCustomerId: CUSTOMER,
      customer: { firstName: 'Ana', lastName: null },
      address: { kind: 'saved', snapshot: savedAddress() },
    });
  });

  it('collects new delivery data across turns and bumps the revision per change', async () => {
    const h = setup();
    await h.turn('Me llamo Ana', [
      call('updateCheckoutDetails', details({ firstName: 'Ana' })),
      say(),
    ]);
    expect(h.outputs[0]).toMatchObject({
      ok: true,
      ready: false,
      missing: [
        'street',
        'exteriorNumber',
        'neighborhood',
        'zipCode',
        'state',
        'cityOrMunicipality',
      ],
    });
    await h.turn('Calle 5 S/N', [
      call(
        'updateCheckoutDetails',
        details({ street: 'Calle 5', exteriorNumber: 'S/N' }),
      ),
      say(),
    ]);
    const draft = await h.draft();
    expect(draft).toMatchObject({
      revision: 1,
      customer: { firstName: 'Ana', lastName: null },
      address: {
        kind: 'new',
        fields: { street: 'Calle 5', exteriorNumber: 'S/N', city: null },
      },
    });
  });

  it('rejects malformed details without modifying the draft', async () => {
    const h = setup();
    await collectComplete(h);
    const before = await h.draft();
    await h.turn('Calle larga', [
      call('updateCheckoutDetails', details({ street: 'x'.repeat(201) })),
      say(),
    ]);
    expect(h.outputs[0]).toEqual({ ok: false, error: 'invalid_details' });
    expect(await h.draft()).toEqual(before);
  });

  it('does not edit a saved address unless a new address is explicitly requested', async () => {
    const h = setup();
    await h.turn('Quiero comprar', [lookup(), say()]);
    await h.turn('La primera', [
      call('selectCheckoutAddress', { addressRef: firstRef(h.outputs[0]) }),
      say(),
    ]);
    const before = await h.draft();
    await h.turn('Cambie la calle', [
      call('updateCheckoutDetails', details({ street: 'Otra' }, false)),
      say(),
    ]);
    expect(h.outputs[0]).toEqual({
      ok: false,
      error: 'saved_address_not_editable',
    });
    expect(await h.draft()).toEqual(before);
  });

  it('blocks confirmation with the missing-data reply while the draft is incomplete', async () => {
    const h = setup();
    const result = await h.turn(
      'Me llamo Ana',
      [
        call('updateCheckoutDetails', details({ firstName: 'Ana' })),
        call('confirmCheckoutDetails'),
        say('Su pedido quedó confirmado.'),
      ],
      EVENT('wamid.1'),
    );
    expect(result).toEqual({
      kind: 'handled',
      reply:
        MINIMAL_CHECKOUT_INCOMPLETE_REPLY +
        ' calle, número exterior o S/N, colonia, código postal, estado, ciudad o municipio.',
    });
  });

  it('presents a server-owned summary and confirms only a strict armed SÍ through the CAS checkpoint', async () => {
    const h = setup();
    await collectComplete(h);
    const offer = await h.turn(
      'Ya están mis datos',
      [call('confirmCheckoutDetails'), say('Su pedido quedó confirmado.')],
      EVENT('wamid.offer'),
    );
    expect(offer).toMatchObject({ kind: 'handled' });
    const reply = (offer as { reply: string }).reply;
    expect(reply).toContain('Calle 5');
    expect(reply).not.toContain('Su pedido quedó confirmado.');
    const before = await h.draft();

    const unarmed = await h.turn('SÍ', [say()], EVENT('wamid.early'));
    expect(unarmed).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
    });

    (offer as { onSent: () => void }).onSent();
    const confirmed = await h.turn('Sí.', [say()], EVENT('wamid.yes'));
    expect(confirmed).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_CONFIRMED_REPLY,
    });
    expect(await h.draft()).toEqual(before);
    for (const fn of Object.values(h.forbidden))
      expect(fn).not.toHaveBeenCalled();
  });

  it('lets a mixed correction reach the model instead of confirming', async () => {
    const h = setup();
    await collectComplete(h);
    const offer = await h.turn(
      'Listo',
      [call('confirmCheckoutDetails'), say()],
      EVENT('wamid.offer'),
    );
    (offer as { onSent: () => void }).onSent();
    const mixed = await h.turn(
      'Sí, pero cambie la calle',
      [say('¿Cuál es la calle correcta?')],
      EVENT('wamid.mixed'),
    );
    expect(mixed).toEqual({
      kind: 'handled',
      reply: '¿Cuál es la calle correcta?',
    });
  });

  it('invalidates a presented summary when the draft changes', async () => {
    const h = setup();
    await collectComplete(h);
    const offer = await h.turn(
      'Listo',
      [call('confirmCheckoutDetails'), say()],
      EVENT('wamid.offer'),
    );
    (offer as { onSent: () => void }).onSent();
    await h.turn('Mejor calle 6', [
      call('updateCheckoutDetails', details({ street: 'Calle 6' })),
      say(),
    ]);
    expect(await h.turn('SÍ', [say()], EVENT('wamid.yes'))).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_CHANGED_REPLY,
    });
  });

  it('rejects a SÍ from a foreign receiving phone', async () => {
    const h = setup();
    await collectComplete(h);
    const offer = await h.turn(
      'Listo',
      [call('confirmCheckoutDetails'), say()],
      EVENT('wamid.offer'),
    );
    (offer as { onSent: () => void }).onSent();
    expect(
      await h.turn('SÍ', [say()], {
        ...EVENT('wamid.yes'),
        receivingPhoneNumberId: '999999999999999',
      }),
    ).toEqual({ kind: 'handled', reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY });
  });

  it('does not confirm when the saved address changed upstream before acceptance', async () => {
    const context = jest
      .fn()
      .mockResolvedValueOnce(unique())
      .mockResolvedValueOnce(unique())
      .mockResolvedValueOnce(
        unique([savedAddress({ version: '2026-10-02T00:00:00.000Z' })]),
      );
    const h = setup({ context });
    await h.turn('Quiero comprar', [lookup(), say()]);
    await h.turn('La primera', [
      call('selectCheckoutAddress', { addressRef: firstRef(h.outputs[0]) }),
      say(),
    ]);
    const offer = await h.turn(
      'Confirmo',
      [call('confirmCheckoutDetails'), say()],
      EVENT('wamid.offer'),
    );
    expect((offer as { reply: string }).reply).toContain('Av. Juárez');
    (offer as { onSent: () => void }).onSent();
    expect(await h.turn('SÍ', [say()], EVENT('wamid.yes'))).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
  });

  it('asks to re-select a saved address after a restart instead of trusting cached data', async () => {
    const h = setup();
    await h.turn('Quiero comprar', [lookup(), say()]);
    await h.turn('La primera', [
      call('selectCheckoutAddress', { addressRef: firstRef(h.outputs[0]) }),
      say(),
    ]);
    const before = await h.draft();
    h.restart();
    expect(await h.draft()).toEqual(before);
    const result = await h.turn(
      'Confirmo',
      [call('confirmCheckoutDetails'), say()],
      EVENT('wamid.offer'),
    );
    expect(result).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_RESELECT_REPLY,
    });
  });

  it('keeps the durable new-address draft across a restart but requires a fresh presentation', async () => {
    const h = setup();
    await collectComplete(h);
    const offer = await h.turn(
      'Listo',
      [call('confirmCheckoutDetails'), say()],
      EVENT('wamid.offer'),
    );
    (offer as { onSent: () => void }).onSent();
    const before = await h.draft();
    h.restart();
    expect(await h.draft()).toEqual(before);
    expect(
      await h.turn('SÍ', [say('¿En qué le ayudo?')], EVENT('wamid.yes')),
    ).toEqual({ kind: 'handled', reply: '¿En qué le ayudo?' });
  });

  it('preserves cart and sibling state and never calls forbidden business endpoints', async () => {
    const h = setup();
    await h.store.create(SENDER, {
      lastMessageAt: '2026-10-10T00:00:00.000Z',
      data: {
        minimalCart: { items: [], idempotencyKey: '', expectedTotalCents: 0 },
        cart: { legacy: 'preserved' },
      },
    });
    await collectComplete(h);
    const data = (await h.store.get(SENDER))?.data;
    expect(data?.minimalCart).toEqual({
      items: [],
      idempotencyKey: '',
      expectedTotalCents: 0,
    });
    expect(data?.cart).toEqual({ legacy: 'preserved' });
    for (const fn of Object.values(h.forbidden))
      expect(fn).not.toHaveBeenCalled();
  });

  it('exposes no checkout tools without the checkout capability', async () => {
    const h = setup({ checkout: false });
    await h.turn('Hola', [say()]);
    const tools = Object.keys(h.seen[0].tools ?? {});
    expect(tools).not.toContain('lookupCheckoutCustomer');
    expect(tools).not.toContain('confirmCheckoutDetails');
    expect(tools).toContain('reviewCheckout');
  });
});

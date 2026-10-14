import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { ShippingQuoteProviderResult } from '../../shipping/domain/shipping-quote.port';
import type { MeasuredDemoShippingConfig } from '../../shipping/application/measured-demo-shipping-config';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import {
  MinimalCatalogAgentService,
  CHECKOUT_TOOL_CLARIFICATION,
} from './minimal-catalog-agent.service';
import { MinimalCartService, parseMinimalCart } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';
import {
  decideApproval,
  expireApproval,
  shippingDigest,
} from './minimal-shipping-approval';
import { CostGuardService } from './cost-guard.service';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const event = (messageId: string) => ({
  senderId: SENDER,
  messageId,
  receivingPhoneNumberId: '123456789012345',
});
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
const say = () =>
  step([{ type: 'text', text: 'Inventado $999. Pedido creado.' }], 'stop');

// prettier-ignore
async function setup(options: { gate?: boolean; absent?: boolean; free?: boolean; order?: boolean; unconfirmed?: boolean } = {}) {
  const price = options.free ? 50001 : 1500;
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(async () => [{ productId: PRODUCT, name: 'Producto', price: { priceCents: price }, variants: [] }]),
    getStock: jest.fn(async () => ({ productId: PRODUCT, name: 'Producto', stock: { status: 'available', quantity: 10 }, variants: [] })),
    evaluateCart: jest.fn(async (items: Array<{ quantity: number }>) => ({ items: items.map(item => ({ productId: PRODUCT, variantId: null, quantity: item.quantity, unitPriceCents: price, originalPriceCents: price * item.quantity, finalPriceCents: price * item.quantity, discountAmountCents: 0, appliedPromotionTitle: null })), promotionEvaluationStatus: 'fully_evaluated' })),
    getCustomerCheckoutContext: jest.fn(async () => ({ status: 'unique', customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null }, addresses: [{ id: ADDRESS, version: '2026-10-01T00:00:00.000Z', label: 'Casa', street: 'Juárez', exteriorNumber: '10', interiorNumber: null, zipCode: '06000', neighborhood: 'Centro', municipality: 'Cuauhtémoc', city: null, state: 'Ciudad de México', visualReferences: null, carrierPhone: null }], nextAfterAddressId: null })),
    createSale: jest.fn(async (...args: unknown[]) => { void args; return ({ saleId: '55555555-5555-4555-8555-555555555555', folio: 'B-42', paymentStatus: 'CREDIT', channel: 'ONLINE', deliveryStatus: 'PENDING', totalCents: price * 2 + (options.free || options.gate === false ? 0 : 20000), paidCents: 0, debtCents: price * 2, confirmedAt: null, discountCents: 0 }); }),
    getPaymentDetails: jest.fn(async () => ({ id: 'pd', bankName: 'BBVA', beneficiary: 'HoundFe', clabe: '012180001234567891', accountNumber: null, isActive: true, updatedAt: '2026-10-01T00:00:00.000Z' })),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = { get: (key: string) => key === 'minimalCatalogAgent' ? { enabled: true, allowedSenders: [SENDER], orderEnabled: options.order !== false, shippingEnabled: options.gate !== false } : key === 'chatbotApi.cashierUserId' ? '99999999-9999-4999-8999-999999999999' : { model: 'm', maxSteps: 6, historyTurns: 12 } } as unknown as ConfigService;
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const order = new MinimalOrderService(client, store, cart, checkout, config);
  const measured: MeasuredDemoShippingConfig = { origin: { postalCode: '06000', state: 'Ciudad de México', municipality: 'Cuauhtémoc', neighborhood: 'Centro' }, profile: { version: 1, items: [{ productId: PRODUCT, variantId: null, quantity: 2, measurement: { weightGrams: 100, lengthCm: 10, widthCm: 10, heightCm: 10 } }], parcel: { weightGrams: 200, lengthCm: 20, widthCm: 20, heightCm: 20 } } };
  const provider = { quote: jest.fn(async (): Promise<ShippingQuoteProviderResult> => ({ kind: 'quoted' as const, quoteId: 'q1', expiresAt: null, rates: [{ rateId: 'r1', carrierName: 'Carrier', serviceName: 'Ground', priceCents: 20000, currency: 'MXN' as const, estimatedDeliveryDays: 3, validUntil: null }] })) };
  const handoff = { create: jest.fn(async () => {
    const date = new Date().toISOString();
    await store.setPendingHumanRequest(SENDER, { requestId: 'abcdef123456', ref: 'HF-abcdef123456', createdAt: date, customerNotifiedAt: date }, date);
    return { ok: true as const, requestId: 'abcdef123456', ref: 'HF-abcdef123456', customerNotified: true as const };
  }) };
  const shipping = new MinimalShippingService(store, cart, checkout, provider, measured, handoff);
  let script: unknown[] = [];
  const seen: Array<{ tools?: Record<string, unknown>; system?: unknown }> = [];
  const generate: GenerateTextFn = async input => { seen.push(input); return generateText({ ...input, model: new MockLanguageModelV4({ doGenerate: script } as never) }); };
  const agent = new MinimalCatalogAgentService(client, generate, new CostGuardService(100000), config, new InMemoryMinimalCatalogSessionStore(), undefined, undefined, cart, checkout, order, options.absent ? undefined : shipping);
  await store.create(SENDER, { lastMessageAt: new Date().toISOString(), data: { minimalCart: { items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: price }], idempotencyKey: '', expectedTotalCents: price * 2 } } });
  const lookup = await checkout.lookup(SENDER, null);
  if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
  await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
  const offer = await checkout.prepareConfirmation(SENDER, event('d1')); offer.onSent?.();
  if (!options.unconfirmed) await checkout.consume({ senderId: SENDER, text: 'SÍ', inboundEvent: event('d2') });
  const turn = (text: string, steps: unknown[]) => { script = steps; return agent.tryHandle({ senderId: SENDER, text, inboundEvent: event(`wamid.${Math.random()}`) }); };
  const decide = async (decision: 'approved' | 'rejected', now = Date.now()) => {
    const s = parseMinimalCart((await store.get(SENDER))?.data.minimalCart)?.shipping;
    if (!s) throw new Error('shipping');
    const result = await decideApproval(store, SENDER, 'abcdef123456', shippingDigest(s), decision, now);
    await store.clearPendingHumanRequest(SENDER, 'abcdef123456');
    return result;
  };
  return { api, store, provider, handoff, seen, turn, decide };
}

// prettier-ignore
describe('minimal shipping SDK public seam', () => {
  it.each([{ gate: false }, { absent: true }, { order: false }])('S5: hidden without both capabilities (%j)', async options => {
    const h = await setup(options); await h.turn('Hola', [say()]);
    expect(h.seen[0].tools).not.toHaveProperty('requestShippingQuote');
    expect(h.seen[0].system).not.toContain('Herramienta requestShippingQuote');
  });
  it('S5: gate-off and service-absent preserve identical tools and prompt', async () => {
    const off = await setup({ gate: false }); const absent = await setup({ absent: true });
    await off.turn('Hola', [say()]); await absent.turn('Hola', [say()]);
    expect(Object.keys(off.seen[0].tools!)).toEqual(Object.keys(absent.seen[0].tools!));
    expect(off.seen[0].system).toBe(absent.seen[0].system);
  });
  it.each([false, true])('S1/S2/S3/S4: approval then single order SÍ, free=%s', async free => {
    const h = await setup({ free });
    const pending = await h.turn('Quiero envío a domicilio', [call('requestShippingQuote'), say()]);
    expect(pending.kind).toBe('handled');
    if (pending.kind !== 'handled') throw new Error('reply');
    expect(pending.reply).toContain('aprobación');
    expect(pending.reply).not.toMatch(/\$|200|999/);
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
    expect(h.handoff.create).toHaveBeenCalledTimes(1);
    expect(h.seen[0].tools).not.toHaveProperty('requestStorePickup');
    expect(h.api.createSale).not.toHaveBeenCalled();
    expect(await h.decide('approved')).toMatchObject({ state: 'approved' });
    const offer = await h.turn('Prepare mi pedido', [call('prepareOrder'), say()]);
    if (offer.kind !== 'handled') throw new Error('offer');
    expect(offer.reply).toContain(free ? 'envío cubierto por su compra' : 'Envío: $200.00 MXN');
    offer.onSent?.();
    await h.turn('SÍ', []);
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    const payload: unknown = h.api.createSale.mock.calls[0]?.[0];
    if (free) expect(payload).not.toHaveProperty('shipping');
    else expect(payload).toMatchObject({ shipping: { chargeCents: 20000, approvalId: 'abcdef123456', quoteId: 'q1' }, expectedTotalCents: 23000 });
  });
  it('S7: rejected quote offers requote, no order', async () => {
    const h = await setup(); await h.turn('Envío', [call('requestShippingQuote'), say()]);
    const decision = await h.decide('rejected');
    expect(decision?.state).toBe('rejected');
    expect(decision?.reply).toContain('otra cotización');
    await h.turn('Pedido', [call('prepareOrder'), say()]);
    expect(h.api.createSale).not.toHaveBeenCalled();
  });
  it('S6: pending approval expires after 30 minutes through public expiry path', async () => {
    const h = await setup(); await h.turn('Envío', [call('requestShippingQuote'), say()]);
    expect(await expireApproval(h.store, SENDER, Date.now() + 31 * 60000)).toBe(true);
    expect(await h.store.get(SENDER)).toHaveProperty('data.pendingHumanRequest', null);
    await h.turn('Pedido', [call('prepareOrder'), say()]);
    expect(h.api.createSale).not.toHaveBeenCalled();
  });
  it('S1/S4: strict arguments fail closed before provider execution', async () => {
    const h = await setup();
    expect(await h.turn('Envío', [call('requestShippingQuote', { senderId: 'attacker' }), say()])).toMatchObject({ reply: CHECKOUT_TOOL_CLARIFICATION });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('S1/S4: shipping shares the first presentation slot and pending reply contains no amounts', async () => {
    const h = await setup();
    await h.turn('Envío', [call('requestShippingQuote'), call('prepareOrder'), call('requestShippingQuote'), say()]);
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
    const pending = await h.turn('Envío de nuevo', [call('requestShippingQuote'), say()]);
    if (pending.kind !== 'handled') throw new Error('pending');
    expect(pending.reply).toContain('pendiente');
    expect(pending.reply).not.toContain('$');
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
  });
  it('S1/S4: unconfirmed delivery is refused without amounts or provider calls', async () => {
    const h = await setup({ unconfirmed: true });
    const result = await h.turn('Envío', [call('requestShippingQuote'), say()]);
    if (result.kind !== 'handled') throw new Error('reply');
    expect(result.reply).toContain('delivery_unconfirmed');
    expect(result.reply).not.toContain('$');
    expect(h.provider.quote).not.toHaveBeenCalled();
    expect(h.api.createSale).not.toHaveBeenCalled();
  });
  it('S4: earlier delivery presentation prevents quoting in the same run', async () => {
    const h = await setup();
    await h.turn('Datos y envío', [call('confirmCheckoutDetails'), call('requestShippingQuote'), say()]);
    expect(h.provider.quote).not.toHaveBeenCalled();
    expect(h.handoff.create).not.toHaveBeenCalled();
  });
  it('S5: gate off keeps existing order flow without shipping', async () => {
    const h = await setup({ gate: false });
    const offer = await h.turn('Pedido', [call('prepareOrder'), say()]);
    if (offer.kind !== 'handled') throw new Error('offer');
    offer.onSent?.(); await h.turn('SÍ', []);
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    expect(h.api.createSale.mock.calls[0]?.[0]).not.toHaveProperty('shipping');
  });
});

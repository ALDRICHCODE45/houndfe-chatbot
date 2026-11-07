import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import {
  CUSTOMER_PHONE_AMBIGUOUS,
  NO_SHIPPING_BOX_FITS,
  PACKAGING_DATA_MISSING,
  PRICE_OUT_OF_DATE,
  SHIPPING_ADDRESS_INCOMPLETE,
  SHIPPING_QUOTE_UNAVAILABLE,
  VARIANT_NOT_FOUND,
  type ShippingQuoteResponse,
} from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import {
  MinimalCatalogAgentService,
  CHECKOUT_TOOL_CLARIFICATION,
  minimalPickupReply,
  minimalShippingReply,
} from './minimal-catalog-agent.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import {
  MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY,
  MinimalOrderService,
} from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';
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
const backendQuote = (
  overrides: Record<string, unknown> = {},
): ShippingQuoteResponse => ({
  quoteId: 'q1',
  expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
  zoneStatus: 'CARRIER_ONLY',
  option: { carrier: 'Carrier', service: 'Ground', etaDays: 3 },
  costCents: 20000,
  creditCents: 0,
  customerChargeCents: 20000,
  currency: 'MXN',
  eta: { days: 3, reason: null },
  ...overrides,
});
const undeliverable = (zoneStatus: 'PENDING' | 'DENIED') =>
  backendQuote({
    zoneStatus,
    quoteId: null,
    expiresAt: null,
    option: null,
    eta: { days: null, reason: null },
    costCents: 0,
    creditCents: 0,
    customerChargeCents: 0,
  });
const say = () =>
  step([{ type: 'text', text: 'Inventado $999. Pedido creado.' }], 'stop');

// prettier-ignore
async function setup(options: { absent?: boolean; free?: boolean; unconfirmed?: boolean } = {}) {
  const price = options.free ? 50001 : 1500;
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(async () => [{ productId: PRODUCT, name: 'Producto', price: { priceCents: price }, variants: [] }]),
    getStock: jest.fn(async () => ({ productId: PRODUCT, name: 'Producto', stock: { status: 'available', quantity: 10 }, variants: [] })),
    evaluateCart: jest.fn(async (items: Array<{ quantity: number }>) => ({ items: items.map(item => ({ productId: PRODUCT, variantId: null, quantity: item.quantity, unitPriceCents: price, originalPriceCents: price * item.quantity, finalPriceCents: price * item.quantity, discountAmountCents: 0, appliedPromotionTitle: null })), promotionEvaluationStatus: 'fully_evaluated' })),
    getCustomerCheckoutContext: jest.fn(async () => ({ status: 'unique', customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null }, addresses: [{ id: ADDRESS, version: '2026-10-01T00:00:00.000Z', label: 'Casa', street: 'Juárez', exteriorNumber: '10', interiorNumber: null, zipCode: '06000', neighborhood: 'Centro', municipality: 'Cuauhtémoc', city: null, state: 'Ciudad de México', visualReferences: null, carrierPhone: null }], nextAfterAddressId: null })),
    createSale: jest.fn(),
    createCheckout: jest.fn(async (...args: unknown[]) => { void args; return ({ status: 'created', sale: { saleId: '55555555-5555-4555-8555-555555555555', folio: 'B-42', paymentStatus: 'CREDIT', channel: 'ONLINE', deliveryStatus: 'PENDING', totalCents: price * 2 + (options.free ? 0 : 20000), paidCents: 0, debtCents: price * 2, confirmedAt: null, discountCents: 0 } }); }),
    getPaymentDetails: jest.fn(async () => ({ id: 'pd', bankName: 'BBVA', beneficiary: 'HoundFe', clabe: '012180001234567891', accountNumber: null, isActive: true, updatedAt: '2026-10-01T00:00:00.000Z' })),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = { get: (key: string) => key === 'chatbotApi.cashierUserId' ? '99999999-9999-4999-8999-999999999999' : { model: 'm', maxSteps: 6, historyTurns: 12 } } as unknown as ConfigService;
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const quotes = new FakeShippingQuoteClient();
  const shipping = new MinimalShippingService(store, cart, checkout, quotes, { register: async () => undefined });
  const order = new MinimalOrderService(client, store, cart, checkout, config, shipping);
  let script: unknown[] = [];
  const seen: Array<{ tools?: Record<string, unknown>; system?: unknown }> = [];
  const models: MockLanguageModelV4[] = [];
  const generate: GenerateTextFn = async input => { seen.push(input); const model = new MockLanguageModelV4({ doGenerate: script } as never); models.push(model); return generateText({ ...input, model }); };
  const agent = new MinimalCatalogAgentService(client, generate, new CostGuardService(100000), config, new InMemoryMinimalCatalogSessionStore(), undefined, undefined, cart, checkout, order, options.absent ? undefined : shipping);
  await store.create(SENDER, { lastMessageAt: new Date().toISOString(), data: { minimalCart: { items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: price }], idempotencyKey: '', expectedTotalCents: price * 2 } } });
  const lookup = await checkout.lookup(SENDER, null);
  if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
  await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
  const offer = await checkout.prepareConfirmation(SENDER, event('d1')); offer.onSent?.();
  if (!options.unconfirmed) await checkout.consume({ senderId: SENDER, text: 'SÍ', inboundEvent: event('d2') });
  const turn = (text: string, steps: unknown[]) => { script = steps; return agent.tryHandle({ senderId: SENDER, text, inboundEvent: event(`wamid.${Math.random()}`) }); };
  return { api, store, quotes, seen, models, turn };
}

// prettier-ignore
describe('minimal shipping SDK public seam', () => {
  it('S9: shipping tools are always offered when the service is wired (no flag)', async () => {
    const h = await setup(); await h.turn('Hola', [say()]);
    expect(h.seen[0].tools).toHaveProperty('requestShippingQuote');
    expect(h.seen[0].tools).toHaveProperty('chooseStorePickup');
  });
  it('S5: hidden only when the service itself is absent (test seam)', async () => {
    const h = await setup({ absent: true }); await h.turn('Hola', [say()]);
    expect(h.seen[0].tools).not.toHaveProperty('requestShippingQuote');
    expect(h.seen[0].system).not.toContain('Herramienta requestShippingQuote');
  });
  it.each([false, true])('[S1,S2,S3] backend quote then single order SÍ with its quoteId, free=%s', async free => {
    const h = await setup({ free });
    h.quotes.enqueue(backendQuote(free ? { zoneStatus: 'FREE', option: null, creditCents: 20000, customerChargeCents: 0 } : {}));
    const quoted = await h.turn('Quiero envío a domicilio', [call('requestShippingQuote'), say()]);
    if (quoted.kind !== 'handled') throw new Error('reply');
    expect(quoted.reply).toContain(free ? 'Su envío al código postal 06000 no tiene costo.' : 'Usted paga $200.00 MXN');
    expect(quoted.reply).not.toMatch(/aprobaci|999/);
    expect(h.quotes.calls).toHaveLength(1);
    expect(h.seen[0].tools).toHaveProperty('chooseStorePickup');
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    const offer = await h.turn('Prepare mi pedido', [call('prepareOrder'), say()]);
    if (offer.kind !== 'handled') throw new Error('offer');
    expect(offer.reply).toContain(free ? 'sin costo para usted' : 'Envío con Carrier (Ground): $200.00 MXN');
    offer.onSent?.();
    await h.turn('SÍ', []);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    const payload: unknown = (h.api.createCheckout.mock.calls[0]?.[0] as { sale?: unknown } | undefined)?.sale;
    expect(payload).toMatchObject({ shipping: { quoteId: 'q1' }, expectedTotalCents: free ? 100002 : 23000 });
    expect(payload).not.toHaveProperty('shipping.chargeCents');
    expect(payload).not.toHaveProperty('shipping.approvalId');
  });
  it.each([
    [undeliverable('PENDING'), 'zone_pending', 'Estamos validando la entrega a su código postal 06000'],
    [undeliverable('DENIED'), 'zone_denied', 'Por ahora no tenemos entrega a su código postal 06000'],
    [new ChatbotApiError('quote', 409, {}, PRICE_OUT_OF_DATE), 'prices_changed', 'precios'],
    [new ChatbotApiError('quote', 404, {}, VARIANT_NOT_FOUND), 'cart_invalid', 'carrito'],
    [new ChatbotApiError('quote', 422, {}, SHIPPING_ADDRESS_INCOMPLETE), 'address_invalid', 'dirección'],
    [new ChatbotApiError('quote', 409, {}, CUSTOMER_PHONE_AMBIGUOUS), 'phone_ambiguous', 'registro único'],
    [new ChatbotApiError('quote', 422, {}, NO_SHIPPING_BOX_FITS), 'unavailable', 'en este momento'],
    [new ChatbotApiError('quote', 422, {}, PACKAGING_DATA_MISSING), 'packaging_missing', 'empaque'],
    [new ChatbotApiError('quote', 503, {}, SHIPPING_QUOTE_UNAVAILABLE), 'unavailable', 'en este momento'],
  ] as const)('tool result reflects %#: %s and no order is possible', async (answer, kind, text) => {
    const h = await setup();
    h.quotes.enqueue(answer);
    const result = await h.turn('Envío', [call('requestShippingQuote'), say()]);
    if (result.kind !== 'handled') throw new Error('reply');
    expect(result.reply).toContain(text);
    expect(result.reply).not.toContain('$');
    // The model's next step sees the tool result carrying the new kind.
    const prompts = JSON.stringify(h.models.at(-1)!.doGenerateCalls.map(c => c.prompt));
    expect(prompts).toContain(`"shipping":"${kind}"`);
    expect(prompts).toContain('"ok":false');
    await h.turn('Pedido', [call('prepareOrder'), say()]);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });
  it('[S7] a STOCK_PENDING eta says the delivery date depends on restock', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote({ eta: { days: null, reason: 'STOCK_PENDING' } }));
    const result = await h.turn('Envío', [call('requestShippingQuote'), say()]);
    if (result.kind !== 'handled') throw new Error('reply');
    expect(result.reply).toContain('La fecha de entrega depende de la reposición de existencias; se la confirmamos en cuanto la tengamos.');
    expect(result.reply).not.toContain('Llega en');
  });
  it('S1/S4: strict arguments fail closed before provider execution', async () => {
    const h = await setup();
    expect(await h.turn('Envío', [call('requestShippingQuote', { senderId: 'attacker' }), say()])).toMatchObject({ reply: CHECKOUT_TOOL_CLARIFICATION });
    expect(h.quotes.calls).toHaveLength(0);
  });
  it('S1/S4: shipping shares the first presentation slot', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote()).enqueue(backendQuote({ quoteId: 'q2' }));
    await h.turn('Envío', [call('requestShippingQuote'), call('prepareOrder'), call('requestShippingQuote'), say()]);
    expect(h.quotes.calls).toHaveLength(1);
    await h.turn('Envío de nuevo', [call('requestShippingQuote'), say()]);
    expect(h.quotes.calls).toHaveLength(2);
  });
  it('S1/S4: unconfirmed delivery is refused without amounts or provider calls', async () => {
    const h = await setup({ unconfirmed: true });
    const result = await h.turn('Envío', [call('requestShippingQuote'), say()]);
    if (result.kind !== 'handled') throw new Error('reply');
    // L10: the customer sees a sentence, never the internal reason code.
    expect(result.reply).toContain('confirme sus datos de entrega');
    expect(result.reply).not.toContain('delivery_unconfirmed');
    expect(result.reply).not.toContain('$');
    expect(h.quotes.calls).toHaveLength(0);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });
  it('S4/F1: confirmed data continue to one quote; a second quote in the same run is refused', async () => {
    const h = await setup();
    await h.turn('Datos y envío', [call('confirmCheckoutDetails'), call('requestShippingQuote'), say()]);
    expect(h.quotes.calls).toHaveLength(1);
  });
  it('S4: an unconfirmed delivery presentation prevents quoting in the same run', async () => {
    const h = await setup({ unconfirmed: true });
    await h.turn('Datos y envío', [call('confirmCheckoutDetails'), call('requestShippingQuote'), say()]);
    expect(h.quotes.calls).toHaveLength(0);
  });
  it('S9: no order without a backend quote or store pickup', async () => {
    const h = await setup();
    const offer = await h.turn('Pedido', [call('prepareOrder'), say()]);
    if (offer.kind !== 'handled') throw new Error('offer');
    expect(offer.reply).toBe(MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY);
    offer.onSent?.(); await h.turn('SÍ', [say()]);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    expect(h.api.createSale).not.toHaveBeenCalled();
  });
});

// prettier-ignore
describe('U4 customer shipping conversation', () => {
  const quoted = (overrides: Partial<Extract<Parameters<typeof minimalShippingReply>[0], { kind: 'quoted' }>> = {}) =>
    minimalShippingReply({ kind: 'quoted', zoneStatus: 'SURCHARGE', costCents: 30000, creditCents: 24000, customerChargeCents: 6000,
      option: { carrier: 'Envíos Perros', service: 'Estándar', etaDays: 4 }, eta: null, zipCode: '06000', ...overrides });
  it.each(['cart_unverified', 'empty_cart', 'promotion_review', 'delivery_unconfirmed', 'new_address_unsupported', 'invalid_state', 'order_unresolved', 'cart_changed', 'address_changed', 'address_unverified', 'unsupported_destination'] as const)('[L10] refusal %s maps to a customer sentence without the reason code', reason => {
    const reply = minimalShippingReply({ kind: 'refused', reason });
    expect(reply).not.toContain(reason);
    expect(reply).not.toMatch(/[a-z]+_[a-z]+/);
    expect(reply.length).toBeGreaterThan(20);
  });
  it('[S3] SURCHARGE shows carrier, cost, credit, customer charge, ETA and the next step', () => {
    expect(quoted()).toBe(
      'Envío a domicilio con Envíos Perros (Estándar): $300.00 MXN. Usted tiene un crédito de $240.00 MXN por sus productos. Usted paga $60.00 MXN. ' +
      'Llega en aproximadamente 4 días hábiles.');
  });
  it('[S3] CARRIER_ONLY without credit or carrier omits those parts', () => {
    const reply = quoted({ zoneStatus: 'CARRIER_ONLY', creditCents: 0, customerChargeCents: 30000, option: null });
    expect(reply).toContain('Envío a domicilio: $300.00 MXN. Usted paga $300.00 MXN.');
    expect(reply).not.toContain('crédito');
    expect(reply).not.toContain('Llega en');
  });
  it('[S3] FREE says there is no cost for that ZIP, with the ETA line', () => {
    expect(quoted({ zoneStatus: 'FREE', costCents: 0, creditCents: 0, customerChargeCents: 0, option: null, eta: { days: 1, reason: null } })).toBe(
      'Su envío al código postal 06000 no tiene costo. Llega en aproximadamente 1 día hábil.');
  });
  it('[S7] STOCK_PENDING replaces the day count', () => {
    expect(quoted({ eta: { days: null, reason: 'STOCK_PENDING' } })).toContain(
      'La fecha de entrega depende de la reposición de existencias; se la confirmamos en cuanto la tengamos.');
  });
  it('[S5] PENDING zone', () => {
    expect(minimalShippingReply({ kind: 'zone_pending', zipCode: '06000' })).toBe(
      'Estamos validando la entrega a su código postal 06000. Le avisamos por aquí en cuanto quede lista; mientras tanto, si prefiere, puede recoger su pedido en tienda.');
  });
  it('[S4] DENIED zone', () => {
    expect(minimalShippingReply({ kind: 'zone_denied', zipCode: '06000' })).toBe(
      'Por ahora no tenemos entrega a su código postal 06000. Puede recoger su pedido en tienda sin costo de envío. ¿Le parece?');
  });
  it('[U1b] a price change asks to review the cart prices before quoting again', () => {
    const reply = minimalShippingReply({ kind: 'prices_changed' });
    expect(reply).toBe('Los precios de su carrito cambiaron. Pídame ver su carrito para revisar los precios actualizados y después le cotizo el envío; no se creó ningún pedido.');
  });
  it('[U1b] a cart the backend cannot quote asks to fix the cart', () => {
    expect(minimalShippingReply({ kind: 'cart_invalid' })).toBe(
      'Un producto de su carrito ya no está disponible así. Revise su carrito, elija de nuevo el producto o su presentación, o quítelo, y vuelva a pedirme el envío; no se creó ningún pedido.');
  });
  it('[U1b] an address the backend cannot quote asks to confirm or correct it', () => {
    expect(minimalShippingReply({ kind: 'address_invalid' })).toBe(
      'No pude cotizar el envío con esa dirección. ¿Me confirma o corrige su dirección de entrega (calle, número, colonia, código postal, municipio y estado)? No se creó ningún pedido.');
  });
  it('[U1b] an ambiguous phone uses the order phone-ambiguous reply', () => {
    expect(minimalShippingReply({ kind: 'phone_ambiguous' })).toBe(MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY);
  });
  it.each(['prices_changed', 'cart_invalid', 'address_invalid', 'phone_ambiguous', 'packaging_missing', 'unavailable'] as const)('[U1b] %s never shows an internal code or amount', kind => {
    const reply = minimalShippingReply({ kind });
    expect(reply).not.toMatch(/[A-Z]{3,}_[A-Z]+|[a-z]+_[a-z]+/);
    expect(reply).not.toContain('$');
  });
  it.each(['packaging_missing', 'unavailable'] as const)('[S6] %s is honest, has no amount and offers pickup or a retry', kind => {
    const reply = minimalShippingReply({ kind });
    expect(reply).not.toContain('$');
    expect(reply).toContain('recoger su pedido en tienda');
    expect(reply).toMatch(/más tarde|en unos minutos/);
  });
  it('[S4] pickup replies', () => {
    expect(minimalPickupReply({ kind: 'pickup' })).toBe(
      'Listo, usted recoge su pedido en tienda, sin costo de envío.');
    expect(minimalPickupReply({ kind: 'refused', reason: 'cart_changed' })).not.toContain('Listo');
  });
  it('[S4] prompt: quote after confirmation, never invent costs, pickup on DENIED/PENDING, no approval', async () => {
    const h = await setup(); await h.turn('Hola', [say()]);
    const system = String(h.seen[0].system);
    expect(system).toContain('chooseStorePickup');
    expect(system).toContain('Nunca invente');
    expect(system).not.toContain('No ofrece recoger en tienda');
    expect(system).not.toMatch(/(env[ií]o|cotizaci[oó]n)[^.]{0,80}aprob|aprob[^.]{0,80}(env[ií]o|cotizaci[oó]n)/i);
  });
  it('[S4] chooseStorePickup then SÍ creates a pickup order with a products-only total', async () => {
    const h = await setup();
    const chosen = await h.turn('Mejor paso a recogerlo', [call('chooseStorePickup'), say()]);
    if (chosen.kind !== 'handled') throw new Error('reply');
    expect(chosen.reply).toContain('recoge su pedido en tienda');
    expect(h.quotes.calls).toHaveLength(0);
    const offer = await h.turn('Pedido', [call('prepareOrder'), say()]);
    if (offer.kind !== 'handled') throw new Error('offer');
    expect(offer.reply).toContain('Recoge en tienda (sin costo de envío)');
    offer.onSent?.(); await h.turn('SÍ', []);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect((h.api.createCheckout.mock.calls[0]?.[0] as { sale?: unknown } | undefined)?.sale).toMatchObject({ shipping: { mode: 'pickup' }, expectedTotalCents: 3000 });
  });
  it('[S4] strict arguments fail closed for chooseStorePickup', async () => {
    const h = await setup();
    expect(await h.turn('Recoger', [call('chooseStorePickup', { senderId: 'attacker' }), say()])).toMatchObject({ reply: CHECKOUT_TOOL_CLARIFICATION });
  });
});

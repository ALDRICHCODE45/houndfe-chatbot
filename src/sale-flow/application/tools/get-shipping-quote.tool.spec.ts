/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// prettier-ignore
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(() => Promise.reject(new Error('axios blocked in tests'))), post: jest.fn(() => Promise.reject(new Error('axios blocked in tests'))) } }));

import type { ConversationState } from '../../../conversation/domain/conversation-store';
import type { MeasuredDemoShippingConfig } from '../../../shipping/application/measured-demo-shipping-config';
import type { ShippingQuoteDraft } from '../../../shipping/application/shipping-quote-draft';
// prettier-ignore
import { buildShippingQuoteDraftRecord, SHIPPING_QUOTE_DRAFT_KEY as KEY } from '../../../shipping/application/shipping-quote-draft-record';
// prettier-ignore
import { makeGetShippingQuoteTool, type GetShippingQuoteToolDeps, type GetShippingQuoteToolResult } from './get-shipping-quote.tool';

/** SQ-5B2B2 core: server-owned inputs, finite non-price results, exact ordering, strict schema. Mocks only; axios blocked. */
const SENDER = '525551234567',
  ISO = '2026-06-23T12:00:00.000Z',
  MS = Date.parse(ISO);
const P = '11111111-1111-1111-1111-111111111111';
const M = { weightGrams: 500, lengthCm: 10, widthCm: 20, heightCm: 30 };
// prettier-ignore
const ORIGIN = { postalCode: '06000', state: 'CDMX', municipality: 'Cuauhtémoc', neighborhood: 'Centro' };
// prettier-ignore
const CONFIG: MeasuredDemoShippingConfig = { profile: { version: 1, items: [{ productId: P, variantId: null, quantity: 1, measurement: M }], parcel: M }, origin: ORIGIN };
// prettier-ignore
const LINE = { productId: P, variantId: null, quantity: 1, unitPriceCents: 1500 };
// prettier-ignore
const DEST = { id: 'a', label: null, street: 'Calle Falsa 123', exteriorNumber: '1', interiorNumber: null, zipCode: '06700', neighborhood: 'Roma', municipality: 'Cuauhtémoc', state: 'CDMX', visualReferences: 'portón azul', carrierPhone: '5512340000' };
// prettier-ignore
const LOOKUP = { found: true, customer: { customerId: 'c', firstName: 'Ana', lastName: null, phoneCountryCode: '52', phone: '5551234567', preferredPaymentMethod: null, address: DEST } };
// prettier-ignore
const DRAFT: ShippingQuoteDraft = { quoteId: 'q1', selectedRate: { rateId: 'r1', carrierName: 'Carrier', serviceName: 'Service', priceCents: 12900, currency: 'MXN', estimatedDeliveryDays: 2, validUntil: null }, providerExpiresAt: null, bestRateCents: 12900, totalCreditCents: 12000, appliedCreditCents: 12000, unusedCreditCents: 0, qualifyingUnitCount: 1, customerPaysCents: 900 };
// prettier-ignore
const stateOf = (data: Record<string, unknown>): ConversationState => ({ senderId: SENDER, lastMessageAt: ISO, data });
// prettier-ignore
const cartState = (): ConversationState => stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' } });
// prettier-ignore
const freshDraft = (): ConversationState => stateOf({ [KEY]: buildShippingQuoteDraftRecord(DRAFT, MS)! });
// prettier-ignore
const withAddress = (address: unknown): unknown => ({ ...LOOKUP, customer: { ...LOOKUP.customer, address } });

// prettier-ignore
function setup(over: { state?: unknown; lookup?: unknown; outcome?: unknown; update?: jest.Mock; now?: jest.Mock } = {}) {
  const get = jest.fn().mockResolvedValue(over.state === undefined ? cartState() : over.state);
  const update = over.update ?? jest.fn().mockResolvedValue(cartState());
  const getCustomerByPhone = jest.fn().mockResolvedValue(over.lookup ?? LOOKUP);
  const quote = jest.fn().mockResolvedValue(over.outcome ?? { kind: 'draft', draft: DRAFT });
  const now = over.now ?? jest.fn().mockReturnValue(MS);
  const deps: GetShippingQuoteToolDeps = { chatbotApi: { getCustomerByPhone }, store: { get, update }, shippingQuoteOrchestrator: { quote }, measuredDemoConfig: CONFIG, now };
  return { tool: makeGetShippingQuoteTool(deps), get, update, getCustomerByPhone, quote, now };
}
// prettier-ignore
const run = async (tool: ReturnType<typeof makeGetShippingQuoteTool>, senderId = SENDER): Promise<GetShippingQuoteToolResult> => (await tool.execute({}, { toolCallId: 't', messages: [], context: { senderId } })) as GetShippingQuoteToolResult;
type SchemaView = { safeParse: (v: unknown) => { success: boolean } };
// prettier-ignore
const schemaOf = (tool: object, key: string): SchemaView => (tool as unknown as Record<string, SchemaView>)[key];
// prettier-ignore
const expectUnavailable = (r: GetShippingQuoteToolResult, reason: string) => { expect(r).toEqual({ ok: false, status: 'unavailable', reason }); expect(Object.isFrozen(r)).toBe(true); };
// prettier-ignore
const expectHandoff = (r: GetShippingQuoteToolResult, reason: string) => { expect(r).toEqual({ ok: false, status: 'handoff_required', reason }); expect(Object.isFrozen(r)).toBe(true); };

describe('makeGetShippingQuoteTool', () => {
  // prettier-ignore
  it('inputSchema is strict-empty; contextSchema requires a non-empty senderId', () => {
    const { tool } = setup();
    const input = schemaOf(tool, 'inputSchema');
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ phone: '1' }).success).toBe(false);
    expect(input.safeParse({ address: {} }).success).toBe(false);
    expect(input.safeParse(undefined).success).toBe(false);
    const context = schemaOf(tool, 'contextSchema');
    expect(context.safeParse({ senderId: SENDER }).success).toBe(true);
    expect(context.safeParse({ senderId: '' }).success).toBe(false);
    expect(context.safeParse({}).success).toBe(false);
  });

  // prettier-ignore
  it('quotes once, persists once, strips destination, returns quoted', async () => {
    const m = setup();
    const result = await run(m.tool);
    expect(result).toEqual({ ok: true, status: 'quoted' });
    expect(Object.keys(result).sort().join()).toBe('ok,status');
    expect(m.now).toHaveBeenCalledTimes(1);
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(m.get).toHaveBeenCalledWith(SENDER);
    expect(m.getCustomerByPhone).toHaveBeenCalledTimes(1);
    expect(m.getCustomerByPhone).toHaveBeenCalledWith('52', '5551234567');
    expect(m.quote).toHaveBeenCalledTimes(1);
    expect(m.update).toHaveBeenCalledTimes(1);
    const arg = m.quote.mock.calls[0][0] as { requestInput: Record<string, unknown> };
    expect(arg.requestInput.origin).toEqual(ORIGIN);
    expect(arg.requestInput.destination).toEqual({ zipCode: '06700', state: 'CDMX', municipality: 'Cuauhtémoc', neighborhood: 'Roma' });
    expect(Object.keys(arg.requestInput.destination as object).sort().join()).toBe('municipality,neighborhood,state,zipCode');
    expect(arg.requestInput.items).toEqual([{ ...LINE, measurement: { ...M } }]);
    expect(arg.requestInput.parcels).toEqual([{ ...M }]);
    const wire = JSON.stringify(arg);
    for (const secret of ['Calle Falsa', 'Ana', 'portón', '5512340000']) expect(wire).not.toContain(secret);
    const [senderId, patch] = m.update.mock.calls[0] as [string, { lastMessageAt: string; data: Record<string, unknown> }];
    expect(senderId).toBe(SENDER);
    expect(patch.lastMessageAt).toBe(ISO);
    expect(patch.data.cart).toEqual({ items: [{ ...LINE }], idempotencyKey: '' });
    expect(patch.data[KEY]).toBeDefined();
  });

  // prettier-ignore
  it.each<[string, jest.Mock]>([
    ['non-numeric', jest.fn().mockReturnValue('now')],
    ['NaN', jest.fn().mockReturnValue(NaN)],
    ['negative', jest.fn().mockReturnValue(-1)],
    ['fraction', jest.fn().mockReturnValue(1.5)],
    ['throwing', jest.fn(() => { throw new Error('clock'); })],
  ])('invalid clock (%s) short-circuits before any call', async (_l, now) => {
    const m = setup({ now });
    expectUnavailable(await run(m.tool), 'invalid_clock');
    expect(m.now).toHaveBeenCalledTimes(1);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('store rejection returns state_failure with no later call', async () => {
    const m = setup();
    m.get.mockRejectedValue(new Error('store down'));
    expectHandoff(await run(m.tool), 'state_failure');
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('reuses a fresh draft with zero phone/cart/backend/orchestrator/update calls', async () => {
    const m = setup({ state: freshDraft() });
    expect(await run(m.tool)).toEqual({ ok: true, status: 'reused' });
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('reuse precedes sender parsing', async () => {
    const m = setup({ state: freshDraft() });
    expect(await run(m.tool, 'x')).toEqual({ ok: true, status: 'reused' });
    expect(m.get).toHaveBeenCalledWith('x');
    expect(m.quote).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('unsupported sender is rejected before the backend', async () => {
    const m = setup();
    expectUnavailable(await run(m.tool, '+52 555 123 4567'), 'unsupported_sender');
    expect(m.get).toHaveBeenCalledWith('+52 555 123 4567');
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, unknown]>([
    ['empty cart', stateOf({ cart: { items: [], idempotencyKey: '' } })],
    ['malformed cart', stateOf({ cart: 'x' })],
    ['mismatched quantity', stateOf({ cart: { items: [{ ...LINE, quantity: 2 }], idempotencyKey: '' } })],
    ['hostile state', { senderId: SENDER, lastMessageAt: ISO, get data(): never { throw new Error('x'); } }],
  ])('cart mismatch (%s) short-circuits before the backend', async (_l, state) => {
    const m = setup({ state });
    expectUnavailable(await run(m.tool), 'cart_mismatch');
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('customer lookup rejection and hostile response hand off', async () => {
    const rejected = setup();
    rejected.getCustomerByPhone.mockRejectedValue(new Error('backend'));
    expectHandoff(await run(rejected.tool), 'customer_lookup_failure');
    expect(rejected.quote).not.toHaveBeenCalled();
    expect(rejected.update).not.toHaveBeenCalled();
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); } });
    const m = setup({ lookup: hostile });
    expectHandoff(await run(m.tool), 'customer_lookup_failure');
    expect(m.quote).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, unknown]>([
    ['not found', { found: false, customer: null }],
    ['null customer', { found: true, customer: null }],
    ['null address', withAddress(null)],
    ['missing zip', withAddress({ ...DEST, zipCode: null })],
    ['empty zip', withAddress({ ...DEST, zipCode: '' })],
    ['untrimmed state', withAddress({ ...DEST, state: ' CDMX ' })],
    ['missing municipality', withAddress({ ...DEST, municipality: undefined })],
  ])('address unavailable (%s) returns address_unavailable', async (_l, lookup) => {
    const m = setup({ lookup });
    expectUnavailable(await run(m.tool), 'address_unavailable');
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, unknown, string]>([
    ['unavailable', { kind: 'unavailable', reason: 'invalid_input' }, 'quote_unavailable'],
    ['handoff', { kind: 'handoff', reason: 'no_rates' }, 'quote_review_required'],
    ['manual packing', { kind: 'handoff', reason: 'manual_packing_required', minimumPackageCount: 2 }, 'quote_review_required'],
  ])('orchestrator %s maps to a finite result', async (label, outcome, reason) => {
    const m = setup({ outcome });
    const result = await run(m.tool);
    if (label === 'unavailable') expectUnavailable(result, reason);
    else expectHandoff(result, reason);
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('orchestrator rejection/hostile result is a redacted handoff', async () => {
    const rejected = setup();
    rejected.quote.mockRejectedValue(new Error('provider_secret_token'));
    const result = await run(rejected.tool);
    expect(JSON.stringify(result)).not.toContain('provider_secret_token');
    expectHandoff(result, 'quote_review_required');
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); } });
    expectHandoff(await run(setup({ outcome: hostile }).tool), 'quote_review_required');
  });

  // prettier-ignore
  it('persistence null/rejection returns persistence_failure', async () => {
    const nul = setup({ update: jest.fn().mockResolvedValue(null) });
    expectHandoff(await run(nul.tool), 'persistence_failure');
    expect(nul.update).toHaveBeenCalledTimes(1);
    const rejected = setup({ update: jest.fn().mockRejectedValue(new Error('write failed')) });
    expectHandoff(await run(rejected.tool), 'persistence_failure');
    expect(rejected.update).toHaveBeenCalledTimes(1);
  });

  // prettier-ignore
  it('every result is frozen, exact-key, and free of secret/monetary detail', async () => {
    const badClock = setup({ now: jest.fn().mockReturnValue(NaN) });
    const outcomes: GetShippingQuoteToolResult[] = [
      await run(setup({ state: freshDraft() }).tool),
      await run(setup().tool),
      await run(setup({ outcome: { kind: 'unavailable', reason: 'x' } }).tool),
      await run(setup({ outcome: { kind: 'handoff', reason: 'no_rates' } }).tool),
      await run(setup({ lookup: { found: false, customer: null } }).tool),
      await run(setup({ state: stateOf({ cart: 'x' }) }).tool),
      await run(setup().tool, 'bad'),
      await run(badClock.tool),
    ];
    for (const result of outcomes) {
      expect(Object.isFrozen(result)).toBe(true);
      const keys = Object.keys(result).sort().join();
      expect(keys === 'ok,status' || keys === 'ok,reason,status').toBe(true);
      const serialized = JSON.stringify(result);
      for (const forbidden of ['cents', 'MXN', 'svc_secret', 'quoteId']) expect(serialized).not.toContain(forbidden);
    }
  });
});

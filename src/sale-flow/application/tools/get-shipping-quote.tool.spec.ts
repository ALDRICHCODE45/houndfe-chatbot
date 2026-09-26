/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// prettier-ignore
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(() => Promise.reject(new Error('axios blocked in tests'))), post: jest.fn(() => Promise.reject(new Error('axios blocked in tests'))) } }));

import type { ConversationState } from '../../../conversation/domain/conversation-store';
import type { MeasuredDemoShippingConfig } from '../../../shipping/application/measured-demo-shipping-config';
import type { ShippingQuoteDraft } from '../../../shipping/application/shipping-quote-draft';
// prettier-ignore
import { buildShippingQuoteDraftRecord, SHIPPING_QUOTE_DRAFT_KEY as KEY } from '../../../shipping/application/shipping-quote-draft-record';
// prettier-ignore
import { buildShippingQuoteDraftContext, SHIPPING_QUOTE_DRAFT_CONTEXT_KEY as CONTEXT_KEY } from '../../../shipping/application/shipping-quote-draft-context';
// prettier-ignore
import { SHIPPING_APPROVAL_KEY as APPROVAL_KEY } from '../../../human-handoff/application/shipping-approval-persistence';
// prettier-ignore
import { makeGetShippingQuoteTool, type GetShippingQuoteToolDeps, type GetShippingQuoteToolResult } from './get-shipping-quote.tool';

/** SQ-5B2B2 core: server-owned inputs, finite non-price results, exact ordering, strict schema. Mocks only; axios blocked. */
const SENDER = '525551234567',
  ISO = '2026-06-23T12:00:00.000Z',
  MS = Date.parse(ISO);
const P = '11111111-1111-1111-1111-111111111111';
const CID = '22222222-2222-2222-2222-222222222222';
const AID = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const M = { weightGrams: 500, lengthCm: 10, widthCm: 20, heightCm: 30 };
// prettier-ignore
const ORIGIN = { postalCode: '06000', state: 'CDMX', municipality: 'Cuauhtémoc', neighborhood: 'Centro' };
// prettier-ignore
const CONFIG: MeasuredDemoShippingConfig = { profile: { version: 1, items: [{ productId: P, variantId: null, quantity: 1, measurement: M }], parcel: M }, origin: ORIGIN };
// prettier-ignore
const LINE = { productId: P, variantId: null, quantity: 1, unitPriceCents: 1500 };
// prettier-ignore
const QDEST = { zipCode: '06700', state: 'CDMX', municipality: 'Cuauhtémoc', neighborhood: 'Roma' };
// prettier-ignore
const DEST = { id: AID, label: null, street: 'Calle Falsa 123', exteriorNumber: '1', interiorNumber: null, zipCode: '06700', neighborhood: 'Roma', municipality: 'Cuauhtémoc', state: 'CDMX', visualReferences: 'portón azul', carrierPhone: '5512340000' };
// prettier-ignore
const LOOKUP = { found: true, customer: { customerId: CID, firstName: 'Ana', lastName: null, phoneCountryCode: '52', phone: '5551234567', preferredPaymentMethod: null, address: DEST } };
// prettier-ignore
const DRAFT: ShippingQuoteDraft = { quoteId: 'q1', selectedRate: { rateId: 'r1', carrierName: 'Carrier', serviceName: 'Service', priceCents: 12900, currency: 'MXN', estimatedDeliveryDays: 2, validUntil: null }, providerExpiresAt: null, bestRateCents: 12900, totalCreditCents: 12000, appliedCreditCents: 12000, unusedCreditCents: 0, qualifyingUnitCount: 1, customerPaysCents: 900 };
// prettier-ignore
const stateOf = (data: Record<string, unknown>): ConversationState => ({ senderId: SENDER, lastMessageAt: ISO, data });
// prettier-ignore
const cartState = (): ConversationState => stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' } });
// prettier-ignore
const legacyDraft = (): ConversationState => stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' }, [KEY]: buildShippingQuoteDraftRecord(DRAFT, MS)! });
const draftParts = () => {
  const record = buildShippingQuoteDraftRecord(DRAFT, MS)!;
  const context = buildShippingQuoteDraftContext(
    {
      customerId: CID,
      shippingAddressId: AID,
      destination: QDEST,
      cart: [{ ...LINE }],
    },
    record.createdAt,
  )!;
  return { record, context };
};
// The stored context is only reusable while the live cart, customer, address,
// and destination still match. `pinnedData` keeps the pinned draft/context and
// varies the live `data.cart` the reuse drift check rereads.
const pinnedData = (cart: unknown): ConversationState => {
  const { record, context } = draftParts();
  return stateOf({ cart, [KEY]: record, [CONTEXT_KEY]: context });
};
const freshDraft = (): ConversationState =>
  pinnedData({ items: [{ ...LINE }], idempotencyKey: '' });
// prettier-ignore
const MARKER = { requestId: 'abcdef012345', draftCreatedAt: ISO, decision: 'SHIPPING_APPROVED', decidedAt: ISO };
// prettier-ignore
const PENDING = { requestId: 'abcdef012345', ref: 'HF-abcdef012345', createdAt: ISO, customerNotifiedAt: ISO };
// prettier-ignore
const approvedDraft = (): ConversationState => { const { record, context } = draftParts(); return stateOf({ [KEY]: record, [CONTEXT_KEY]: context, [APPROVAL_KEY]: MARKER }); };
// prettier-ignore
const pendingDraft = (): ConversationState => { const { record, context } = draftParts(); return stateOf({ [KEY]: record, [CONTEXT_KEY]: context, pendingHumanRequest: PENDING }); };
// prettier-ignore
const mismatchedDraft = (): ConversationState => { const { record, context } = draftParts(); return stateOf({ [KEY]: record, [CONTEXT_KEY]: { ...context, draftCreatedAt: '2026-06-23T11:00:00.000Z' } }); };
// prettier-ignore
const orphanContext = (): ConversationState => { const { context } = draftParts(); return stateOf({ [CONTEXT_KEY]: context }); };
// prettier-ignore
const malformedContext = (): ConversationState => { const { record } = draftParts(); return stateOf({ [KEY]: record, [CONTEXT_KEY]: { schemaVersion: 1, draftCreatedAt: record.createdAt } }); };
// prettier-ignore
const withAddress = (address: unknown): unknown => ({ ...LOOKUP, customer: { ...LOOKUP.customer, address } });

// prettier-ignore
function setup(over: { state?: unknown; lookup?: unknown; outcome?: unknown; update?: jest.Mock; now?: jest.Mock; approval?: jest.Mock | null; approvalThrows?: boolean } = {}) {
  const get = jest.fn().mockResolvedValue(over.state === undefined ? cartState() : over.state);
  const update = over.update ?? jest.fn().mockResolvedValue(cartState());
  const getCustomerByPhone = jest.fn().mockResolvedValue(over.lookup ?? LOOKUP);
  const quote = jest.fn().mockResolvedValue(over.outcome ?? { kind: 'draft', draft: DRAFT });
  const now = over.now ?? jest.fn().mockReturnValue(MS);
  const requestShippingApproval = over.approval === null ? undefined : over.approval ?? jest.fn().mockResolvedValue({ ok: true });
  const deps = { chatbotApi: { getCustomerByPhone }, store: { get, update }, shippingQuoteOrchestrator: { quote }, measuredDemoConfig: CONFIG, now, requestShippingApproval } as unknown as GetShippingQuoteToolDeps;
  if (over.approvalThrows === true) Object.defineProperty(deps, 'requestShippingApproval', { get() { throw new Error('hostile deps'); } });
  return { tool: makeGetShippingQuoteTool(deps), get, update, getCustomerByPhone, quote, now, requestShippingApproval };
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
    const context = patch.data[CONTEXT_KEY] as Record<string, unknown>;
    expect(context.customerId).toBe(CID);
    expect(context.shippingAddressId).toBe(AID);
    expect(context.destination).toEqual(QDEST);
    expect(context.cart).toEqual([{ ...LINE }]);
  });

  // prettier-ignore
  it('legacy fresh draft without context falls through to a new quote', async () => {
    const m = setup({ state: legacyDraft() });
    expect(await run(m.tool)).toEqual({ ok: true, status: 'quoted' });
    expect(m.getCustomerByPhone).toHaveBeenCalledTimes(1);
    expect(m.quote).toHaveBeenCalledTimes(1);
    expect(m.update).toHaveBeenCalledTimes(1);
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
  it('reuses a fresh draft after one backend reread and no quote/update', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: freshDraft(), approval });
    expect(await run(m.tool)).toEqual({ ok: true, status: 'reused' });
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(m.getCustomerByPhone).toHaveBeenCalledTimes(1);
    expect(m.getCustomerByPhone).toHaveBeenCalledWith('52', '5551234567');
    expect(approval).toHaveBeenCalledTimes(1);
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('an unsupported sender can no longer reuse a fresh draft', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: freshDraft(), approval });
    expectUnavailable(await run(m.tool, 'x'), 'unsupported_sender');
    expect(m.get).toHaveBeenCalledWith('x');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, unknown, string]>([
    ['quantity drift', { items: [{ ...LINE, quantity: 2 }], idempotencyKey: '' }, 'cart_mismatch'],
    ['product drift', { items: [{ ...LINE, productId: OTHER }], idempotencyKey: '' }, 'cart_mismatch'],
    ['empty current cart', { items: [], idempotencyKey: '' }, 'cart_mismatch'],
    ['malformed current cart', 'x', 'cart_mismatch'],
    ['unit price drift', { items: [{ ...LINE, unitPriceCents: 1600 }], idempotencyKey: '' }, 'context_mismatch'],
  ])('reuse cart drift (%s) fails closed', async (_l, cart, reason) => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: pinnedData(cart), approval });
    expectUnavailable(await run(m.tool), reason);
    expect(approval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, unknown, string]>([
    ['customer id drift', { ...LOOKUP, customer: { ...LOOKUP.customer, customerId: OTHER } }, 'context_mismatch'],
    ['address id drift', withAddress({ ...DEST, id: OTHER }), 'context_mismatch'],
    ['destination zip drift', withAddress({ ...DEST, zipCode: '99999' }), 'context_mismatch'],
    ['destination locality drift', withAddress({ ...DEST, neighborhood: 'Juárez' }), 'context_mismatch'],
  ])('reuse identity/destination drift (%s) fails closed', async (_l, lookup, reason) => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: freshDraft(), lookup, approval });
    expectUnavailable(await run(m.tool), reason);
    expect(m.getCustomerByPhone).toHaveBeenCalledTimes(1);
    expect(approval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('reuse fails closed when the backend reread rejects or is hostile', async () => {
    const rejected = setup({ state: freshDraft() });
    rejected.getCustomerByPhone.mockRejectedValue(new Error('backend'));
    expectHandoff(await run(rejected.tool), 'customer_lookup_failure');
    expect(rejected.requestShippingApproval).not.toHaveBeenCalled();
    expect(rejected.quote).not.toHaveBeenCalled();
    expect(rejected.update).not.toHaveBeenCalled();
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); } });
    const m = setup({ state: freshDraft(), lookup: hostile });
    expectHandoff(await run(m.tool), 'customer_lookup_failure');
    expect(m.requestShippingApproval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('reuse fails closed when the current stored address is invalid', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: freshDraft(), lookup: withAddress({ ...DEST, zipCode: null }), approval });
    expectUnavailable(await run(m.tool), 'address_unavailable');
    expect(approval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a hostile current cart getter fails closed on reuse', async () => {
    const { record, context } = draftParts();
    const data: Record<string, unknown> = { [KEY]: record, [CONTEXT_KEY]: context };
    Object.defineProperty(data, 'cart', { get() { throw new Error('cart'); }, enumerable: true, configurable: true });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: stateOf(data), approval });
    expectUnavailable(await run(m.tool), 'cart_mismatch');
    expect(approval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('reuse fails closed when the current destination cannot be re-pinned', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: freshDraft(), lookup: withAddress({ ...DEST, zipCode: 'ABCDE' }), approval });
    expectUnavailable(await run(m.tool), 'context_mismatch');
    expect(approval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('reuse reads the original state.data exactly once before the drift verdict', async () => {
    const inner = freshDraft();
    let dataReads = 0;
    const proxied = new Proxy(inner, {
      get(target, key, receiver) {
        if (key === 'data') dataReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: proxied, approval });
    expect(await run(m.tool)).toEqual({ ok: true, status: 'reused' });
    expect(dataReads).toBe(1);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a stateful top-level state proxy cannot smuggle a marker into a new-quote overwrite', async () => {
    const clean: Record<string, unknown> = { cart: { items: [{ ...LINE }], idempotencyKey: '' } };
    const poisoned: Record<string, unknown> = { ...clean, [APPROVAL_KEY]: MARKER };
    let dataReads = 0;
    const state = new Proxy({ senderId: SENDER, lastMessageAt: ISO, data: clean }, {
      get(target, key, receiver) {
        if (key === 'data') { dataReads += 1; return dataReads === 1 ? clean : poisoned; }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state, approval });
    const result = await run(m.tool);
    expect(result).toEqual({ ok: true, status: 'quoted' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(dataReads).toBe(1);
    expect(m.update).toHaveBeenCalledTimes(1);
    const patch = (m.update.mock.calls[0] as [string, { data: Record<string, unknown> }])[1];
    expect(patch.data[APPROVAL_KEY]).toBeUndefined();
    expect(patch.data.pendingHumanRequest).toBeUndefined();
    expect(patch.data[KEY]).toBeDefined();
    expect(patch.data[CONTEXT_KEY]).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('cents');
    for (const secret of ['Calle Falsa', 'Ana', 'portón', '5512340000']) expect(JSON.stringify(patch.data)).not.toContain(secret);
  });

  // prettier-ignore
  it('a null conversation still re-quotes from an empty cart with no backend', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: null, approval });
    expectUnavailable(await run(m.tool), 'cart_mismatch');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a preexisting shipping approval blocks a new quote before every seam', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: approvedDraft(), approval });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('any pending human handoff blocks a new quote before every seam', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: pendingDraft(), approval });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, ConversationState]>([
    ['mismatched context pin', mismatchedDraft()],
    ['orphan context', orphanContext()],
    ['malformed context', malformedContext()],
  ])('a %s fails closed before every seam', async (_label, state) => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state, approval });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('hostile state.data fails closed before every seam', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const hostile = { senderId: SENDER, lastMessageAt: ISO, get data(): never { throw new Error('x'); } };
    const m = setup({ state: hostile, approval });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a descriptor/get divergence on state.data fails closed', async () => {
    const clean = cartState();
    const divergent = new Proxy(clean, {
      get(target, key, receiver) {
        if (key === 'data') return { ...target.data, [APPROVAL_KEY]: MARKER };
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const m = setup({ state: divergent });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('an explicitly cleared approval/pending marker still allows reuse', async () => {
    const { record, context } = draftParts();
    const state = stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' }, [KEY]: record, [CONTEXT_KEY]: context, [APPROVAL_KEY]: null, pendingHumanRequest: null });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state, approval });
    expect(await run(m.tool)).toEqual({ ok: true, status: 'reused' });
    expect(approval).toHaveBeenCalledTimes(1);
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a legacy draft without context is blocked when an approval marker survives', async () => {
    const { record } = draftParts();
    const state = stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' }, [KEY]: record, [APPROVAL_KEY]: MARKER });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state, approval });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(approval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, Record<string, unknown>]>([
    ['malformed pending marker', { cart: { items: [{ ...LINE }], idempotencyKey: '' }, pendingHumanRequest: { foo: 1 } }],
    ['malformed approval marker', { cart: { items: [{ ...LINE }], idempotencyKey: '' }, [APPROVAL_KEY]: { foo: 1 } }],
  ])('any non-null %s fails closed regardless of its shape', async (_label, data) => {
    const m = setup({ state: stateOf(data) });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('an expired pinned context fails closed instead of claiming a re-quote', async () => {
    const record = buildShippingQuoteDraftRecord(DRAFT, MS - 40 * 60 * 1000)!;
    const context = buildShippingQuoteDraftContext({ customerId: CID, shippingAddressId: AID, destination: QDEST, cart: [{ ...LINE }] }, record.createdAt)!;
    const state = stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' }, [KEY]: record, [CONTEXT_KEY]: context });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state, approval });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a stateful draft proxy cannot serve a fresh record after the checked read', async () => {
    const expired = buildShippingQuoteDraftRecord(DRAFT, MS - 40 * 60 * 1000)!;
    const freshRecord = buildShippingQuoteDraftRecord(DRAFT, MS)!;
    const context = buildShippingQuoteDraftContext({ customerId: CID, shippingAddressId: AID, destination: QDEST, cart: [{ ...LINE }] }, expired.createdAt)!;
    let draftReads = 0;
    const bag = { [KEY]: expired, [CONTEXT_KEY]: context };
    const stateful = new Proxy(bag, {
      get(target, key, receiver) {
        if (key === KEY) {
          draftReads += 1;
          return draftReads === 1 ? target[KEY] : freshRecord;
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: stateOf(stateful), approval });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(draftReads).toBe(1);
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
  ])('a present %s context with a fresh draft fails closed', async (_label, contextValue) => {
    const { record } = draftParts();
    const state = stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' }, [KEY]: record, [CONTEXT_KEY]: contextValue });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state, approval });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a malformed non-null draft with absent context fails closed', async () => {
    const state = stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' }, [KEY]: { quoteId: 'q1' } });
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state, approval });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(approval).not.toHaveBeenCalled();
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('an expired legacy draft with absent context fails closed', async () => {
    const record = buildShippingQuoteDraftRecord(DRAFT, MS - 40 * 60 * 1000)!;
    const state = stateOf({ cart: { items: [{ ...LINE }], idempotencyKey: '' }, [KEY]: record });
    const m = setup({ state });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(m.getCustomerByPhone).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('a non-plain conversation state fails closed before every seam', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: 'not-a-state', approval });
    expectHandoff(await run(m.tool), 'state_failure');
    expect(approval).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
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
    ['missing customer id', { ...LOOKUP, customer: { ...LOOKUP.customer, customerId: 'nope' } }],
    ['missing address id', withAddress({ ...DEST, id: null })],
    ['invalid address id', withAddress({ ...DEST, id: 'x' })],
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
  it('requests approval once after reusing a fresh draft', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ state: freshDraft(), approval });
    expect(await run(m.tool)).toEqual({ ok: true, status: 'reused' });
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledWith(SENDER);
    expect(m.getCustomerByPhone).toHaveBeenCalledTimes(1);
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('requests approval once after persisting a new draft', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    const m = setup({ approval });
    expect(await run(m.tool)).toEqual({ ok: true, status: 'quoted' });
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledWith(SENDER);
  });

  // prettier-ignore
  it('fails closed when approval is absent on the reuse path', async () => {
    const m = setup({ state: freshDraft(), approval: null });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(m.getCustomerByPhone).toHaveBeenCalledTimes(1);
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('fails closed when approval is absent on the persist path', async () => {
    const m = setup({ approval: null });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(m.update).toHaveBeenCalledTimes(1);
  });

  // prettier-ignore
  it.each<[string, unknown]>([
    ['declined', { ok: false, reason: 'pending_handoff' }],
    ['malformed', { reason: 'unavailable' }],
    ['non-object', 'ok'],
  ])('approval %s on the reuse path is a price-free handoff', async (_l, approvalResult) => {
    const approval = jest.fn().mockResolvedValue(approvalResult);
    const m = setup({ state: freshDraft(), approval });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(approval).toHaveBeenCalledTimes(1);
    expect(m.update).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it('approval failure on the persist path is a price-free handoff', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: false, reason: 'handoff_failed' });
    const m = setup({ approval });
    expectHandoff(await run(m.tool), 'approval_unavailable');
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledTimes(1);
  });

  // prettier-ignore
  it('approval rejection and hostile result are redacted handoffs', async () => {
    const rejected = setup({
      state: freshDraft(),
      approval: jest.fn().mockRejectedValue(new Error('svc_secret')),
    });
    const rejectedResult = await run(rejected.tool);
    expect(JSON.stringify(rejectedResult)).not.toContain('svc_secret');
    expectHandoff(rejectedResult, 'approval_unavailable');
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); } });
    const m = setup({ state: freshDraft(), approval: jest.fn().mockResolvedValue(hostile) });
    expectHandoff(await run(m.tool), 'approval_unavailable');
  });

  // prettier-ignore
  it('does not request approval when an earlier gate fails', async () => {
    const approval = jest.fn().mockResolvedValue({ ok: true });
    await run(setup({ now: jest.fn().mockReturnValue(NaN), approval }).tool);
    await run(setup({ outcome: { kind: 'handoff', reason: 'no_rates' }, approval }).tool);
    await run(setup({ update: jest.fn().mockResolvedValue(null), approval }).tool);
    expect(approval).not.toHaveBeenCalled();
  });

  // prettier-ignore
  it.each<[string, unknown]>([
    ['contradictory reason', { ok: true, reason: 'verification_failed' }],
    ['leaked digest', { ok: true, digest: { customerPaysCents: 900 } }],
    ['extra key', { ok: true, extra: 1 }],
    ['non-enumerable digest', (() => { const r = { ok: true }; Object.defineProperty(r, 'digest', { value: { customerPaysCents: 900 }, enumerable: false }); return r; })()],
    ['symbol metadata', { ok: true, [Symbol('digest')]: { customerPaysCents: 900 } }],
    ['accessor ok', (() => { const r = {}; Object.defineProperty(r, 'ok', { get: () => true, enumerable: true, configurable: true }); return r; })()],
  ])('approval ok with %s is rejected as a price-free handoff', async (_l, approvalResult) => {
    const approval = jest.fn().mockResolvedValue(approvalResult);
    const m = setup({ state: freshDraft(), approval });
    const result = await run(m.tool);
    expectHandoff(result, 'approval_unavailable');
    expect(approval).toHaveBeenCalledTimes(1);
    expect(m.update).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result);
    for (const leaked of ['digest', '900', 'verification_failed']) expect(serialized).not.toContain(leaked);
  });

  // prettier-ignore
  it('fails closed when the approval dependency getter throws', async () => {
    const m = setup({ approvalThrows: true });
    const result = await run(m.tool);
    expectHandoff(result, 'approval_unavailable');
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('hostile deps');
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
      await run(setup({ state: freshDraft(), approval: null }).tool),
      await run(setup({ approval: null }).tool),
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

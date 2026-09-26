/**
 * SQ-5B2B2 price-stripped shipping-quote tool core.
 *
 * Server-owned AI-SDK tool: the model supplies NO phone, address, product,
 * measurement, parcel, price, rate, or sender field. Sender identity arrives
 * only through `options.context.senderId`; every logistics input is resolved
 * inside `execute` from conversation state, the stored customer address, and
 * the private measured-demo configuration.
 *
 * The model-visible result is a finite, frozen, non-price union. No cents,
 * money, credit, rate, carrier, service, quote/provider id, expiry,
 * address/locality, phone, product id, measurement, parcel, raw provider
 * response, secret, or error message can reach the model. This module is an
 * isolated core: it performs no registration and no real I/O.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../../conversation/domain/conversation-store';
import type { MeasuredDemoShippingConfig } from '../../../shipping/application/measured-demo-shipping-config';
// prettier-ignore
import { matchMeasuredDemoParcelProfile, type MeasuredDemoPreparedInput } from '../../../shipping/application/measured-demo-parcel-profile';
// prettier-ignore
import { SHIPPING_APPROVAL_KEY } from '../../../human-handoff/application/shipping-approval-persistence';
// prettier-ignore
import { buildShippingQuoteDraftContext, compareShippingQuoteDraftContext, normalizeShippingQuoteDraftContext, SHIPPING_QUOTE_DRAFT_CONTEXT_KEY, type ShippingQuoteDraftContext } from '../../../shipping/application/shipping-quote-draft-context';
// prettier-ignore
import { normalizeShippingQuoteDraftRecord, SHIPPING_QUOTE_DRAFT_KEY } from '../../../shipping/application/shipping-quote-draft-record';
// prettier-ignore
import { persistShippingQuoteDraftWithContext, readShippingQuoteDraft } from '../../../shipping/application/shipping-quote-draft-persistence';
import type { ShippingApprovalRequestResult } from '../../../shipping/application/shipping-approval-request';
import type { ShippingQuoteOrchestrator } from '../../../shipping/application/shipping-quote-orchestrator';
import { isShippingQuoteAddress } from '../../../shipping/domain/shipping-quote.request';
import { readCart } from '../../domain/cart-state';
import { parseMexicanWhatsAppPhone } from '../../domain/mexican-whatsapp-phone';

// prettier-ignore
export type GetShippingQuoteUnavailableReason = 'invalid_clock' | 'unsupported_sender' | 'cart_mismatch' | 'address_unavailable' | 'context_mismatch' | 'quote_unavailable';
// prettier-ignore
export type GetShippingQuoteHandoffReason = 'state_failure' | 'customer_lookup_failure' | 'quote_review_required' | 'persistence_failure' | 'approval_unavailable';
// prettier-ignore
export type GetShippingQuoteToolResult = { readonly ok: true; readonly status: 'reused' | 'quoted' } | { readonly ok: false; readonly status: 'unavailable'; readonly reason: GetShippingQuoteUnavailableReason } | { readonly ok: false; readonly status: 'handoff_required'; readonly reason: GetShippingQuoteHandoffReason };
export interface GetShippingQuoteToolDeps {
  chatbotApi: Pick<ChatbotApiClient, 'getCustomerByPhone'>;
  store: Pick<ConversationStore, 'get' | 'update'>;
  shippingQuoteOrchestrator: Pick<ShippingQuoteOrchestrator, 'quote'>;
  measuredDemoConfig: MeasuredDemoShippingConfig;
  now?: () => number;
  /** Optional narrow seam over the SQ-5C3b approval lifecycle; C3c2 wires the
   *  real wrapper. Absent, failing, or hostile results fail closed and never
   *  let a price-free status reach the model without approval. */
  requestShippingApproval?: (
    senderId: string,
  ) => Promise<ShippingApprovalRequestResult>;
}
// prettier-ignore
const REUSED: GetShippingQuoteToolResult = Object.freeze({ ok: true, status: 'reused' });
// prettier-ignore
const QUOTED: GetShippingQuoteToolResult = Object.freeze({ ok: true, status: 'quoted' });
// prettier-ignore
const unavailable = (reason: GetShippingQuoteUnavailableReason): GetShippingQuoteToolResult => Object.freeze({ ok: false, status: 'unavailable', reason });
// prettier-ignore
const handoff = (reason: GetShippingQuoteHandoffReason): GetShippingQuoteToolResult => Object.freeze({ ok: false, status: 'handoff_required', reason });
// prettier-ignore
function isPlainRecord(value: unknown): value is Record<string, unknown> { try { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const proto: unknown = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; } catch { return false; } }
// prettier-ignore
function readClock(now: () => number): number | null { try { const value: unknown = now(); return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime()) ? value : null; } catch { return null; } }
// prettier-ignore
interface ShippingDestination { readonly zipCode: string; readonly state: string; readonly municipality: string; readonly neighborhood: string; }
// prettier-ignore
type DestinationRead = { readonly kind: 'ok'; readonly customerId: string; readonly shippingAddressId: string; readonly destination: ShippingDestination } | { readonly kind: 'invalid' } | { readonly kind: 'hostile' };
// prettier-ignore
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i;
// prettier-ignore
const canonicalUuid = (value: unknown): string | null => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

/**
 * Reads only the four safe destination fields plus the canonical customer and
 * address UUIDs from the stored customer address. Street, names, phone,
 * references, carrier phone, and every other address field are never copied or
 * passed on; a missing/invalid UUID is `invalid` (finite address_unavailable)
 * and a hostile/throwing response is classified separately so the caller can
 * hand off instead of inventing data.
 */
// prettier-ignore
function readDestination(lookup: unknown): DestinationRead { if (!isPlainRecord(lookup)) return { kind: 'hostile' }; try { if (lookup.found !== true) return { kind: 'invalid' }; const customer: unknown = lookup.customer; if (!isPlainRecord(customer)) return { kind: 'invalid' }; const address: unknown = customer.address; if (!isPlainRecord(address)) return { kind: 'invalid' }; const customerId = canonicalUuid(customer.customerId); const shippingAddressId = canonicalUuid(address.id); if (customerId === null || shippingAddressId === null) return { kind: 'invalid' }; const zipCode: unknown = address.zipCode, state: unknown = address.state, municipality: unknown = address.municipality, neighborhood: unknown = address.neighborhood; if (typeof zipCode !== 'string' || typeof state !== 'string' || typeof municipality !== 'string' || typeof neighborhood !== 'string') return { kind: 'invalid' }; const candidate = Object.freeze({ countryCode: 'MX', postalCode: zipCode, state, municipality, neighborhood }); if (!isShippingQuoteAddress(candidate)) return { kind: 'invalid' }; return { kind: 'ok', customerId, shippingAddressId, destination: Object.freeze({ zipCode, state, municipality, neighborhood }) }; } catch { return { kind: 'hostile' }; } }

/**
 * Maps the server-resolved measured items to the exact quote-context cart
 * lines the persistence and drift-comparison boundaries expect: the observed
 * `measurement` and every other prepared field are stripped, never leaked into
 * the stored snapshot. Shared by the reuse drift check and a new quote write.
 */
function quoteContextFields(
  destinationRead: Extract<DestinationRead, { kind: 'ok' }>,
  prepared: MeasuredDemoPreparedInput,
) {
  const cart = prepared.items.map((item) =>
    Object.freeze({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    }),
  );
  return Object.freeze({
    customerId: destinationRead.customerId,
    shippingAddressId: destinationRead.shippingAddressId,
    destination: destinationRead.destination,
    cart: Object.freeze(cart),
  });
}

/**
 * Accepts only an exact approval success: a plain object whose sole own key is
 * the data property `ok` set to `true`. Non-enumerable keys, symbol keys, and
 * accessor `ok` properties are rejected so hidden metadata can never
 * masquerade as approval. Hostile proxy traps that throw fail closed.
 */
function isExactApprovalOk(value: unknown): boolean {
  try {
    if (!isPlainRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== 'ok') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'ok');
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return false;
    }
    return descriptor.value === true;
  } catch {
    return false;
  }
}

/**
 * Guards the optional approval lifecycle seam. Returns `true` only when the
 * seam resolves an exact plain one-key `{ ok: true }` data property; an absent
 * seam, a throwing dependency getter, a rejected invocation, or any extra,
 * contradictory, hidden, or hostile field all return `false` so the caller
 * hands off with a price-free status. A `reused`/`quoted` result therefore
 * means the approval REQUEST was created, never that a human approved it.
 */
async function requestApproval(
  deps: GetShippingQuoteToolDeps,
  senderId: string,
): Promise<boolean> {
  try {
    const request = deps.requestShippingApproval;
    if (request === undefined) return false;
    const result: unknown = await request(senderId);
    return isExactApprovalOk(result);
  } catch {
    return false;
  }
}

/** Own-key read that never executes an accessor: `absent` for a missing key,
 *  `unsafe` for an own getter/setter, a throwing descriptor, or a
 *  descriptor/`get` divergence (a hostile Proxy), and `value` for a consistent
 *  own data property. Reading through the descriptor is what keeps a stateful
 *  or throwing `state.data` from flipping the guard's verdict. */
type OwnRead =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unsafe' };
const ABSENT_READ: OwnRead = Object.freeze({ kind: 'absent' });
const UNSAFE_READ: OwnRead = Object.freeze({ kind: 'unsafe' });

function readOwnRecord(target: Record<string, unknown>, key: string): OwnRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) return ABSENT_READ;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return UNSAFE_READ;
    }
    if (!Object.is(descriptor.value, target[key])) return UNSAFE_READ;
    return { kind: 'value', value: descriptor.value };
  } catch {
    return UNSAFE_READ;
  }
}

/** Markers treat a missing key and an explicit JSON `null`/`undefined` as
 *  absent. Draft/context presence instead uses `kind`, so a present `null` key
 *  is never mistaken for a clean legacy record. */
function isAbsentRead(read: OwnRead): boolean {
  return (
    read.kind === 'absent' ||
    (read.kind === 'value' && (read.value === null || read.value === undefined))
  );
}

type QuoteDraftGuard =
  | {
      readonly kind: 'reuse';
      readonly context: ShippingQuoteDraftContext;
      readonly data: ConversationStateData;
      readonly lastMessageAt: string;
    }
  | {
      readonly kind: 'quote';
      readonly data: ConversationStateData | null;
      readonly lastMessageAt: string;
    }
  | {
      readonly kind: 'handoff';
      readonly reason: 'state_failure' | 'approval_unavailable';
    };

const STATE_FAILURE_GUARD: QuoteDraftGuard = Object.freeze({
  kind: 'handoff',
  reason: 'state_failure',
});
const APPROVAL_GUARD: QuoteDraftGuard = Object.freeze({
  kind: 'handoff',
  reason: 'approval_unavailable',
});

const PENDING_HUMAN_REQUEST_KEY = 'pendingHumanRequest';

/**
 * SQ-5E2a1 fail-closed classification before any new quote or overwrite.
 *
 * `readShippingQuoteDraftContext(...) === null` conflates a truly absent
 * quote, a fresh legacy draft, a malformed/mismatched/orphan context, an
 * expired draft, and hostile state. Falling straight into
 * `persistShippingQuoteDraftWithContext` could then overwrite a draft that an
 * unchanged approval/pending marker still pins.
 *
 * Only a truly absent quote (no draft key and no context key) or a fresh,
 * well-formed draft with an ABSENT context key and no approval/pending marker
 * may re-quote. A present context key must normalize and pin the exact present
 * draft to reuse it; an expired or malformed draft, a mismatched, orphan,
 * null, or otherwise unverifiable context, and a hostile state all fail
 * closed. A preexisting `shippingApproval` or any `pendingHumanRequest` fails
 * closed as `approval_unavailable`; everything else unverifiable fails closed
 * as `state_failure`.
 *
 * `state.data` and every marker key are read exactly once through own data
 * descriptors, so an accessor or a descriptor/`get` divergence is rejected
 * instead of being re-read. A `quote` verdict carries that single validated
 * `data` snapshot (or `null` when the conversation itself is null) plus the
 * one-read `lastMessageAt`, so the caller never rereads the original
 * `state.data`: a stateful top-level proxy cannot serve a clean marker-free bag
 * to this guard and an approval/pending-bearing bag to the later cart read or
 * persistence write. Pure: no clock, I/O, provider, or mutation.
 */
function classifyQuoteDraftGuard(
  state: unknown,
  nowMs: number,
): QuoteDraftGuard {
  if (state === null) return { kind: 'quote', data: null, lastMessageAt: '' };
  if (!isPlainRecord(state)) return STATE_FAILURE_GUARD;
  const stateData = readOwnRecord(state, 'data');
  if (stateData.kind !== 'value' || !isPlainRecord(stateData.value)) {
    return STATE_FAILURE_GUARD;
  }
  const data = stateData.value as ConversationStateData;
  const lastMessageAtRead = readOwnRecord(state, 'lastMessageAt');
  const lastMessageAt =
    lastMessageAtRead.kind === 'value' &&
    typeof lastMessageAtRead.value === 'string'
      ? lastMessageAtRead.value
      : '';
  const pending = readOwnRecord(data, PENDING_HUMAN_REQUEST_KEY);
  const approval = readOwnRecord(data, SHIPPING_APPROVAL_KEY);
  if (pending.kind === 'unsafe' || approval.kind === 'unsafe') {
    return STATE_FAILURE_GUARD;
  }
  if (!isAbsentRead(pending) || !isAbsentRead(approval)) return APPROVAL_GUARD;
  const context = readOwnRecord(data, SHIPPING_QUOTE_DRAFT_CONTEXT_KEY);
  const draft = readOwnRecord(data, SHIPPING_QUOTE_DRAFT_KEY);
  if (context.kind === 'unsafe' || draft.kind === 'unsafe') {
    return STATE_FAILURE_GUARD;
  }
  // No draft key: re-quote only when no context key is present either.
  if (draft.kind === 'absent') {
    return context.kind === 'absent'
      ? { kind: 'quote', data, lastMessageAt }
      : STATE_FAILURE_GUARD;
  }
  // A present draft key must be a well-formed record; a malformed non-null
  // draft is never treated as a clean legacy draft.
  const record = normalizeShippingQuoteDraftRecord(draft.value);
  if (record === null) return STATE_FAILURE_GUARD;
  // Freshness is decided from the already-normalized, descriptor-checked
  // `record`, never a second read of the original `data` bag: a stateful Proxy
  // could otherwise serve an expired draft to the checked read and a fresh one
  // here, turning a fail-closed expiry into a false reuse. The draft reader
  // ignores `lastMessageAt`; the plain snapshot holds only the validated record.
  const snapshot: ConversationState = {
    senderId: '',
    lastMessageAt: '',
    data: { [SHIPPING_QUOTE_DRAFT_KEY]: record },
  };
  const fresh = readShippingQuoteDraft(snapshot, nowMs) !== null;
  // An absent context key permits only a fresh legacy draft to re-quote.
  if (context.kind === 'absent') {
    return fresh ? { kind: 'quote', data, lastMessageAt } : STATE_FAILURE_GUARD;
  }
  // A present context key (even `null`/`undefined`) must normalize and pin the
  // exact present draft; anything unverifiable is not a reuse.
  const normalized = normalizeShippingQuoteDraftContext(context.value);
  if (normalized === null || normalized.draftCreatedAt !== record.createdAt) {
    return STATE_FAILURE_GUARD;
  }
  // The pin matches; only a fresh draft may be reused, an expired one fails.
  // The validated `data` bag travels with the reuse verdict so the drift
  // reread reuses this snapshot instead of touching `state.data` again.
  return fresh
    ? { kind: 'reuse', context: normalized, data, lastMessageAt }
    : STATE_FAILURE_GUARD;
}

export function makeGetShippingQuoteTool(deps: GetShippingQuoteToolDeps) {
  const now = deps.now ?? Date.now;
  return tool({
    description:
      'Cotiza el envío de forma interna (sin exponer precios al cliente). Resuelve carrito y dirección guardados en el servidor; devuelve un estado finito de reuso, cotización o derivación. Un estado de reuso o cotización significa que la solicitud de aprobación se registró correctamente, no que un humano ya la aprobó. No acepta ni muestra teléfono, dirección, producto, medidas, precio, tarifa o transportista.',
    inputSchema: z.object({}).strict(),
    contextSchema: z.object({ senderId: z.string().min(1) }),
    // prettier-ignore
    execute: async (_input, options) => {
      const nowMs = readClock(now);
      if (nowMs === null) return unavailable('invalid_clock');
      const senderId = options.context.senderId;
      let state: ConversationState | null;
      try { state = await deps.store.get(senderId); } catch { return handoff('state_failure'); }
      const guard = classifyQuoteDraftGuard(state, nowMs);
      if (guard.kind === 'handoff') return handoff(guard.reason);
      // One plain snapshot built from the guard's single validated `state.data`
      // read feeds both the cart reread and the new-quote write. The original
      // `state.data` is never read again, so a stateful top-level proxy cannot
      // serve a clean marker-free bag to the guard and an approval/pending bag
      // to the later read/persist. A null conversation stays null so the
      // null-state new-quote behavior is preserved.
      const snapshot: ConversationState | null = guard.data === null ? null : { senderId, lastMessageAt: guard.lastMessageAt, data: guard.data };
      const phone = parseMexicanWhatsAppPhone(senderId);
      if (phone === null) return unavailable('unsupported_sender');
      let prepared: MeasuredDemoPreparedInput | null;
      try { prepared = matchMeasuredDemoParcelProfile(deps.measuredDemoConfig.profile, readCart(snapshot).items); } catch { prepared = null; }
      if (prepared === null) return unavailable('cart_mismatch');
      let lookup: unknown;
      try { lookup = await deps.chatbotApi.getCustomerByPhone(phone.phoneCountryCode, phone.phone); } catch { return handoff('customer_lookup_failure'); }
      const destinationRead = readDestination(lookup);
      if (destinationRead.kind === 'hostile') return handoff('customer_lookup_failure');
      if (destinationRead.kind === 'invalid') return unavailable('address_unavailable');
      const contextFields = quoteContextFields(destinationRead, prepared);
      // Reuse only when the live cart, customer, address, and destination still
      // match the stored context pinned to the exact draft createdAt; any drift
      // fails closed without a re-quote, write, or approval request.
      if (guard.kind === 'reuse') {
        const current = buildShippingQuoteDraftContext(contextFields, guard.context.draftCreatedAt);
        if (current === null || !compareShippingQuoteDraftContext(current, guard.context)) return unavailable('context_mismatch');
        return (await requestApproval(deps, senderId)) ? REUSED : handoff('approval_unavailable');
      }
      let outcome: unknown;
      try { outcome = await deps.shippingQuoteOrchestrator.quote({ requestInput: Object.freeze({ origin: Object.freeze({ ...deps.measuredDemoConfig.origin }), destination: destinationRead.destination, items: prepared.items, parcels: prepared.parcels }) }); } catch { return handoff('quote_review_required'); }
      if (!isPlainRecord(outcome)) return handoff('quote_review_required');
      let kind: unknown;
      try { kind = outcome.kind; } catch { return handoff('quote_review_required'); }
      if (kind === 'unavailable') return unavailable('quote_unavailable');
      if (kind !== 'draft') return handoff('quote_review_required');
      let stored: unknown;
      // SAFETY: the persistence boundary only uses `get`/`update`; the injected narrow store satisfies the full ConversationStore at runtime.
      try { stored = await persistShippingQuoteDraftWithContext(deps.store as ConversationStore, senderId, snapshot, outcome.draft, contextFields, nowMs); } catch { return handoff('persistence_failure'); }
      return stored === null ? handoff('persistence_failure') : (await requestApproval(deps, senderId)) ? QUOTED : handoff('approval_unavailable');
    },
  });
}

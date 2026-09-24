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
  ConversationStore,
} from '../../../conversation/domain/conversation-store';
import type { MeasuredDemoShippingConfig } from '../../../shipping/application/measured-demo-shipping-config';
// prettier-ignore
import { matchMeasuredDemoParcelProfile, type MeasuredDemoPreparedInput } from '../../../shipping/application/measured-demo-parcel-profile';
// prettier-ignore
import { persistShippingQuoteDraftWithContext, readShippingQuoteDraftContext } from '../../../shipping/application/shipping-quote-draft-persistence';
import type { ShippingApprovalRequestResult } from '../../../shipping/application/shipping-approval-request';
import type { ShippingQuoteOrchestrator } from '../../../shipping/application/shipping-quote-orchestrator';
import { isShippingQuoteAddress } from '../../../shipping/domain/shipping-quote.request';
import { readCart } from '../../domain/cart-state';
import { parseMexicanWhatsAppPhone } from '../../domain/mexican-whatsapp-phone';

// prettier-ignore
export type GetShippingQuoteUnavailableReason = 'invalid_clock' | 'unsupported_sender' | 'cart_mismatch' | 'address_unavailable' | 'quote_unavailable';
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
      if (readShippingQuoteDraftContext(state, nowMs) !== null) return (await requestApproval(deps, senderId)) ? REUSED : handoff('approval_unavailable');
      const phone = parseMexicanWhatsAppPhone(senderId);
      if (phone === null) return unavailable('unsupported_sender');
      let prepared: MeasuredDemoPreparedInput | null;
      try { prepared = matchMeasuredDemoParcelProfile(deps.measuredDemoConfig.profile, readCart(state).items); } catch { prepared = null; }
      if (prepared === null) return unavailable('cart_mismatch');
      let lookup: unknown;
      try { lookup = await deps.chatbotApi.getCustomerByPhone(phone.phoneCountryCode, phone.phone); } catch { return handoff('customer_lookup_failure'); }
      const destinationRead = readDestination(lookup);
      if (destinationRead.kind === 'hostile') return handoff('customer_lookup_failure');
      if (destinationRead.kind === 'invalid') return unavailable('address_unavailable');
      let outcome: unknown;
      try { outcome = await deps.shippingQuoteOrchestrator.quote({ requestInput: Object.freeze({ origin: Object.freeze({ ...deps.measuredDemoConfig.origin }), destination: destinationRead.destination, items: prepared.items, parcels: prepared.parcels }) }); } catch { return handoff('quote_review_required'); }
      if (!isPlainRecord(outcome)) return handoff('quote_review_required');
      let kind: unknown;
      try { kind = outcome.kind; } catch { return handoff('quote_review_required'); }
      if (kind === 'unavailable') return unavailable('quote_unavailable');
      if (kind !== 'draft') return handoff('quote_review_required');
      let stored: unknown;
      const quoteContext = Object.freeze({ customerId: destinationRead.customerId, shippingAddressId: destinationRead.shippingAddressId, destination: destinationRead.destination, cart: Object.freeze(prepared.items.map((item) => Object.freeze({ productId: item.productId, variantId: item.variantId, quantity: item.quantity, unitPriceCents: item.unitPriceCents }))) });
      // SAFETY: the persistence boundary only uses `get`/`update`; the injected narrow store satisfies the full ConversationStore at runtime.
      try { stored = await persistShippingQuoteDraftWithContext(deps.store as ConversationStore, senderId, state, outcome.draft, quoteContext, nowMs); } catch { return handoff('persistence_failure'); }
      return stored === null ? handoff('persistence_failure') : (await requestApproval(deps, senderId)) ? QUOTED : handoff('approval_unavailable');
    },
  });
}

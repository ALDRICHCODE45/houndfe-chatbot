/**
 * SQ-3C4 Skydropx shipping-quote provider adapter. Composes the committed C3
 * request mapper, the committed quotation client (create + bounded poll), and
 * the committed C2 quotation mapper behind the provider-neutral
 * `ShippingQuoteProviderPort`. Stateless and never-throwing: every client
 * outcome is inspected once at the runtime boundary, rejections become
 * `upstream_unavailable`, hostile/malformed structures become
 * `malformed_response`, and only finite normalized envelopes reach callers.
 */
import {
  normalizeShippingQuoteProviderResult,
  type ShippingQuoteProviderPort,
  type ShippingQuoteProviderResult,
} from '../domain/shipping-quote.port';
import type { ShippingQuoteRequest } from '../domain/shipping-quote.request';
import type { SkydropxQuotationClient } from './skydropx-quotation.client';
import { mapSkydropxQuotation } from './skydropx-quotation.mapper';
import { mapSkydropxQuotationRequest } from './skydropx-request.mapper';

/** Narrow structural view of the committed quotation client. */
export type SkydropxQuotationClientDeps = Pick<
  SkydropxQuotationClient,
  'create' | 'poll'
>;

const QUOTATION_ID = /^[A-Za-z0-9_-]+$/;
const isPathSafeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  QUOTATION_ID.test(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

/** One raw snapshot value; never a parsed domain type. */
type FieldValue = string | number | boolean | object | null | undefined;

/** Read one field exactly once; a throwing getter or proxy fails closed. */
const read = (value: Record<string, unknown>, key: string): FieldValue => {
  try {
    return value[key] as FieldValue;
  } catch {
    return undefined;
  }
};

type Attempt =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };
/** Assimilate a client call, mapping any rejection or synchronous throw. */
const attempt = async (run: () => unknown): Promise<Attempt> => {
  try {
    return { ok: true, value: await run() };
  } catch {
    return { ok: false };
  }
};

const envelope = (error: unknown): ShippingQuoteProviderResult =>
  normalizeShippingQuoteProviderResult({ kind: 'error', error });
const upstream = (): ShippingQuoteProviderResult =>
  envelope({ kind: 'upstream_unavailable', httpStatus: null });
const malformed = (): ShippingQuoteProviderResult =>
  envelope({ kind: 'malformed_response' });
const invalid = (): ShippingQuoteProviderResult =>
  envelope({ kind: 'invalid_request', field: 'unknown' });

export class SkydropxShippingQuoteProvider implements ShippingQuoteProviderPort {
  constructor(private readonly client: SkydropxQuotationClientDeps) {}

  async quote(
    request: ShippingQuoteRequest,
  ): Promise<ShippingQuoteProviderResult> {
    const payload = mapSkydropxQuotationRequest(request);
    if (payload === null) return invalid();

    const created = await attempt(() => this.client.create(payload));
    if (!created.ok) return upstream();
    const createRaw = created.value;
    if (!isPlainRecord(createRaw)) return malformed();
    const createKind = read(createRaw, 'kind');
    if (createKind === 'error') return envelope(read(createRaw, 'error'));
    const id = read(createRaw, 'quotationId');
    if (createKind !== 'created' || !isPathSafeId(id)) return malformed();

    const polled = await attempt(() => this.client.poll(id));
    if (!polled.ok) return upstream();
    const pollRaw = polled.value;
    if (!isPlainRecord(pollRaw)) return malformed();
    const pollKind = read(pollRaw, 'kind');
    if (pollKind === 'error') return envelope(read(pollRaw, 'error'));
    if (pollKind !== 'completed') return malformed();
    if (read(pollRaw, 'quotationId') !== id) return malformed();
    return normalizeShippingQuoteProviderResult(
      mapSkydropxQuotation(id, read(pollRaw, 'providerRates')),
    );
  }
}

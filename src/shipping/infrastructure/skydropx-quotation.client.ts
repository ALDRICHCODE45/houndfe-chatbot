/** SQ-3B1 Skydropx V1 quotation-creation core: injectable HTTP seam, structural getToken dependency, JSON bearer POST, strict 201 parsing, finite status/abort mapping, no retries, and a fail-closed secret-safe result. One-time 401 recovery (SQ-3B2) and polling (SQ-3B3) live elsewhere. */
import type { ShippingQuoteError } from '../domain/shipping-quote.error';
import { normalizeShippingQuoteError } from '../domain/shipping-quote.error';
import {
  defaultSkydropxHttp,
  type SkydropxHttp,
  type SkydropxHttpResponse,
  type SkydropxTokenClient,
} from './skydropx-token.client';
export interface SkydropxQuotationAddress {
  readonly country_code: string;
  readonly postal_code: string;
  readonly area_level1: string;
  readonly area_level2: string;
  readonly area_level3: string;
}
export interface SkydropxQuotationParcel {
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly weight: number;
}
export interface SkydropxQuotationPayload {
  readonly quotation: {
    readonly address_from: SkydropxQuotationAddress;
    readonly address_to: SkydropxQuotationAddress;
    readonly parcels: readonly SkydropxQuotationParcel[];
  };
}
export type SkydropxQuotationResult =
  | { readonly kind: 'created'; readonly quotationId: string }
  | { readonly kind: 'error'; readonly error: ShippingQuoteError };
/** Minimal structural view of the token client; it is never constructed here. */
export type SkydropxQuotationTokenSource = Pick<
  SkydropxTokenClient,
  'getToken' | 'invalidate'
>;
export interface SkydropxQuotationClientConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}
const MAX_QUOTATION_ID_LENGTH = 128;
const MAX_TOKEN_LENGTH = 4096;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const isBearerToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_TOKEN_LENGTH &&
  BEARER_TOKEN.test(value);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ERR_CANCELED', 'ETIMEDOUT']);
type TokenOutcome =
  | { readonly kind: 'token'; readonly accessToken: string }
  | { readonly kind: 'error'; readonly result: SkydropxQuotationResult };
type PostOutcome =
  | { readonly kind: 'done'; readonly result: SkydropxQuotationResult }
  | { readonly kind: 'unauthorized' };
const done = (result: SkydropxQuotationResult): PostOutcome => ({
  kind: 'done',
  result,
});
type WireValue = string | number | boolean | object | null | undefined;
const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const er = (error: ShippingQuoteError): SkydropxQuotationResult => ({
  kind: 'error',
  error,
});
const malformed = (): SkydropxQuotationResult =>
  er({ kind: 'malformed_response' });
const field = (value: unknown, key: string): WireValue => {
  try {
    return (value as Record<string, WireValue> | null | undefined)?.[key];
  } catch {
    return undefined;
  }
};
const readStatus = (response: unknown): number | null => {
  const status = field(response, 'status');
  if (typeof status !== 'number' || !Number.isSafeInteger(status)) return null;
  return status >= 100 && status <= 599 ? status : null;
};
const readRetryAfter = (response: unknown): number | null => {
  const headers = field(response, 'headers');
  if (typeof headers !== 'object' || headers === null) return null;
  const raw = field(headers, 'retry-after') ?? field(headers, 'Retry-After');
  const seconds =
    typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(seconds) ? seconds : null;
};
const isTimeout = (thrown: unknown): boolean => {
  try {
    const probe = thrown as { code?: unknown; name?: unknown } | null;
    if (probe === null || typeof probe !== 'object') return false;
    return (
      probe.name === 'AbortError' || TIMEOUT_CODES.has(probe.code as string)
    );
  } catch {
    return false;
  }
};
const parseCreated = (data: unknown): SkydropxQuotationResult => {
  try {
    if (!isObject(data)) return malformed();
    const id: unknown = data.id;
    const done: unknown = data.is_completed;
    if (typeof id !== 'string' || id.length === 0 || id !== id.trim())
      return malformed();
    if (id.length > MAX_QUOTATION_ID_LENGTH || typeof done !== 'boolean')
      return malformed();
    return { kind: 'created', quotationId: id };
  } catch {
    return malformed();
  }
};
export class SkydropxQuotationClient {
  private readonly http: SkydropxHttp;
  constructor(
    private readonly config: SkydropxQuotationClientConfig,
    private readonly tokens: SkydropxQuotationTokenSource,
    http?: SkydropxHttp,
  ) {
    this.http = http ?? defaultSkydropxHttp;
  }
  create = async (
    payload: SkydropxQuotationPayload,
  ): Promise<SkydropxQuotationResult> => {
    try {
      const initial = await this.token();
      if (initial.kind === 'error') return initial.result;
      const first = await this.post(payload, initial.accessToken);
      if (first.kind === 'done') return first.result;
      return await this.recover(payload, initial.accessToken);
    } catch {
      return er({ kind: 'upstream_unavailable', httpStatus: null });
    }
  };
  /**
   * One-time recovery after a definite 401; never replays with a stale token.
   * The invalidation result is assimilated before refreshing so an async or
   * deferred callback cannot let refresh/replay precede invalidation, and a
   * rejected thenable fails closed instead of escaping as an unhandled
   * rejection.
   */
  private async recover(
    payload: SkydropxQuotationPayload,
    staleAccessToken: string,
  ): Promise<SkydropxQuotationResult> {
    try {
      await Promise.resolve(this.tokens.invalidate(staleAccessToken));
    } catch {
      return malformed();
    }
    const refreshed = await this.token();
    if (refreshed.kind === 'error') return refreshed.result;
    const replay = await this.post(payload, refreshed.accessToken);
    return replay.kind === 'done' ? replay.result : er({ kind: 'auth_failed' });
  }
  private async token(): Promise<TokenOutcome> {
    try {
      const raw: unknown = await this.tokens.getToken();
      if (!isObject(raw)) return { kind: 'error', result: malformed() };
      const kind: unknown = raw.kind;
      if (kind === 'token') {
        const accessToken: unknown = raw.accessToken;
        if (!isBearerToken(accessToken))
          return { kind: 'error', result: malformed() };
        return { kind: 'token', accessToken };
      }
      if (kind === 'error')
        return {
          kind: 'error',
          result: er(normalizeShippingQuoteError(raw.error)),
        };
      return { kind: 'error', result: malformed() };
    } catch {
      return { kind: 'error', result: malformed() };
    }
  }
  private async post(
    payload: SkydropxQuotationPayload,
    accessToken: string,
  ): Promise<PostOutcome> {
    let response: SkydropxHttpResponse;
    try {
      response = await this.http({
        method: 'POST',
        url: `${this.config.baseUrl.replace(/\/+$/, '')}/api/v1/quotations`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        timeout: this.config.timeoutMs,
        data: payload,
      });
    } catch (thrown) {
      if (isTimeout(thrown)) return done(er({ kind: 'timeout' }));
      return done(er({ kind: 'upstream_unavailable', httpStatus: null }));
    }
    const status = readStatus(response);
    if (status === null) return done(malformed());
    if (status === 201) return done(parseCreated(field(response, 'data')));
    if (status === 401) return { kind: 'unauthorized' };
    if (status === 403) return done(er({ kind: 'auth_failed' }));
    if (status === 400 || status === 422)
      return done(er({ kind: 'invalid_request', field: 'unknown' }));
    if (status === 429)
      return done(
        er({
          kind: 'rate_limited',
          retryAfterSeconds: readRetryAfter(response),
        }),
      );
    if (status >= 500)
      return done(er({ kind: 'upstream_unavailable', httpStatus: status }));
    return done(malformed());
  }
}

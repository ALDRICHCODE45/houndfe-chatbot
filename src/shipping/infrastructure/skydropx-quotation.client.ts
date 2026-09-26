/** SQ-3B1/SQ-3B2/SQ-3B3a/SQ-3B3b Skydropx V1 quotation lifecycle: injectable HTTP seam, structural getToken dependency, JSON bearer POST with one-time 401 recovery, plus bounded GET polling with a fixed cadence, path-safe ids, finite status/abort mapping, a bounded shallow provider-rate snapshot, and one-time GET 401 token recovery. */
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
/** SQ-3B3a internal/provider-facing completed poll: only the id plus a shallow rate snapshot. SQ-3C normalizes the raw elements. */
export type SkydropxQuotationPollResult =
  | {
      readonly kind: 'completed';
      readonly quotationId: string;
      readonly providerRates: readonly unknown[];
    }
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
export const SKYDROPX_QUOTATION_POLL_MAX_ATTEMPTS = 5;
export const SKYDROPX_QUOTATION_POLL_INTERVAL_MS = 1_000;
export const SKYDROPX_QUOTATION_MAX_RATES = 100;
const MAX_QUOTATION_ID_LENGTH = 128;
const QUOTATION_ID = /^[A-Za-z0-9_-]+$/;
const isPathSafeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_QUOTATION_ID_LENGTH &&
  QUOTATION_ID.test(value);
const MAX_TOKEN_LENGTH = 4096;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const isBearerToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_TOKEN_LENGTH &&
  BEARER_TOKEN.test(value);
const isRateCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const MAX_POLL_TIMEOUT_MS = 60_000;
// prettier-ignore
const readPollTimeout = (config: SkydropxQuotationClientConfig): number | null => { try { const v: unknown = config.timeoutMs; return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_POLL_TIMEOUT_MS ? v : null; } catch { return null; } };
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ERR_CANCELED', 'ETIMEDOUT']);
type TokenOutcome =
  | { readonly kind: 'token'; readonly accessToken: string }
  | { readonly kind: 'error'; readonly result: SkydropxQuotationResult };
type PostOutcome =
  | { readonly kind: 'done'; readonly result: SkydropxQuotationResult }
  | { readonly kind: 'unauthorized' };
type PollGet =
  | { readonly kind: 'complete'; readonly providerRates: readonly unknown[] }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'terminal'; readonly result: SkydropxQuotationPollResult };
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
    if (!isPathSafeId(id) || typeof done !== 'boolean') return malformed();
    return { kind: 'created', quotationId: id };
  } catch {
    return malformed();
  }
};
const pollEr = (error: ShippingQuoteError): SkydropxQuotationPollResult => ({
  kind: 'error',
  error,
});
const malformedPoll = (): SkydropxQuotationPollResult =>
  pollEr({ kind: 'malformed_response' });
const asError = (result: SkydropxQuotationResult): ShippingQuoteError =>
  result.kind === 'error' ? result.error : { kind: 'malformed_response' };
const terminal = (result: SkydropxQuotationPollResult): PollGet => ({
  kind: 'terminal',
  result,
});
/** Shallow-snapshot a dense provider rates array, reading each element once; sparse, proxied, or oversized arrays are rejected. */
const snapshotRates = (value: unknown): readonly unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const source = value as readonly unknown[];
    const rawLength: unknown = source.length;
    if (!isRateCount(rawLength) || rawLength > SKYDROPX_QUOTATION_MAX_RATES)
      return null;
    const out: unknown[] = [];
    for (let i = 0; i < rawLength; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(source, i)) return null;
      out.push(source[i]);
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
};
export class SkydropxQuotationClient {
  private readonly http: SkydropxHttp;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  constructor(
    private readonly config: SkydropxQuotationClientConfig,
    private readonly tokens: SkydropxQuotationTokenSource,
    http?: SkydropxHttp,
    sleep?: (milliseconds: number) => Promise<void>,
  ) {
    this.http = http ?? defaultSkydropxHttp;
    this.sleep =
      sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
   * SQ-3B3a/SQ-3B3b bounded GET polling with one-time 401 recovery. Always
   * performs at least one GET: the caller cannot skip polling from a
   * create-time completion flag. A definite GET 401 triggers a single
   * invalidate/refresh/replay; the replay reuses the exact path and validated
   * timeout, is outside the attempt budget, and never adds sleep, so the total
   * GET bound across one poll call is at most the attempt cap plus one.
   */
  poll = async (quotationId: string): Promise<SkydropxQuotationPollResult> => {
    try {
      if (!isPathSafeId(quotationId))
        return pollEr({ kind: 'invalid_request', field: 'unknown' });
      const timeoutMs = readPollTimeout(this.config);
      if (timeoutMs === null) return pollEr({ kind: 'provider_disabled' });
      const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
      const token = await this.token();
      if (token.kind === 'error') return pollEr(asError(token.result));
      let accessToken = token.accessToken;
      let recovered = false;
      let attempt = 0;
      while (attempt < SKYDROPX_QUOTATION_POLL_MAX_ATTEMPTS) {
        attempt += 1;
        // prettier-ignore
        let outcome = await this.getQuotation(baseUrl, quotationId, accessToken, timeoutMs);
        if (outcome.kind === 'unauthorized' && !recovered) {
          recovered = true;
          const refreshed = await this.refresh(accessToken);
          if (refreshed.kind === 'error')
            return pollEr(asError(refreshed.result));
          accessToken = refreshed.accessToken;
          // prettier-ignore
          outcome = await this.getQuotation(baseUrl, quotationId, accessToken, timeoutMs);
        }
        if (outcome.kind === 'terminal') return outcome.result;
        if (outcome.kind === 'complete')
          return {
            kind: 'completed',
            quotationId,
            providerRates: outcome.providerRates,
          };
        if (outcome.kind === 'unauthorized')
          return pollEr({ kind: 'auth_failed' });
        if (attempt >= SKYDROPX_QUOTATION_POLL_MAX_ATTEMPTS) break;
        try {
          await this.sleep(SKYDROPX_QUOTATION_POLL_INTERVAL_MS);
        } catch (thrown) {
          return pollEr(
            isTimeout(thrown)
              ? { kind: 'timeout' }
              : { kind: 'upstream_unavailable', httpStatus: null },
          );
        }
      }
      return pollEr({ kind: 'timeout' });
    } catch {
      return pollEr({ kind: 'upstream_unavailable', httpStatus: null });
    }
  };
  /**
   * One-time POST recovery after a definite 401; never replays with a stale
   * token and returns auth_failed if the replay is unauthorized again.
   */
  private async recover(
    payload: SkydropxQuotationPayload,
    staleAccessToken: string,
  ): Promise<SkydropxQuotationResult> {
    const refreshed = await this.refresh(staleAccessToken);
    if (refreshed.kind === 'error') return refreshed.result;
    const replay = await this.post(payload, refreshed.accessToken);
    return replay.kind === 'done' ? replay.result : er({ kind: 'auth_failed' });
  }
  /**
   * Assimilate the invalidation of exactly one stale token before acquiring a
   * replacement, so a synchronous throw, hostile getter, rejected thenable, or
   * deferred callback cannot let refresh/replay precede invalidation. Any
   * invalidation failure yields a finite malformed error for the caller.
   */
  private async refresh(staleAccessToken: string): Promise<TokenOutcome> {
    try {
      await Promise.resolve(this.tokens.invalidate(staleAccessToken));
    } catch {
      return { kind: 'error', result: malformed() };
    }
    return this.token();
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
  private async getQuotation(
    baseUrl: string,
    quotationId: string,
    accessToken: string,
    timeoutMs: number,
  ): Promise<PollGet> {
    let response: SkydropxHttpResponse;
    try {
      response = await this.http({
        method: 'GET',
        url: `${baseUrl}/api/v1/quotations/${quotationId}`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        timeout: timeoutMs,
      });
    } catch (thrown) {
      if (isTimeout(thrown)) return terminal(pollEr({ kind: 'timeout' }));
      return terminal(
        pollEr({ kind: 'upstream_unavailable', httpStatus: null }),
      );
    }
    const status = readStatus(response);
    if (status === null) return terminal(malformedPoll());
    if (status === 200) return this.readPolled(response, quotationId);
    if (status === 401) return { kind: 'unauthorized' };
    if (status === 403) return terminal(pollEr({ kind: 'auth_failed' }));
    if (status === 400 || status === 404 || status === 422)
      return terminal(pollEr({ kind: 'invalid_request', field: 'unknown' }));
    if (status === 429)
      return terminal(
        pollEr({
          kind: 'rate_limited',
          retryAfterSeconds: readRetryAfter(response),
        }),
      );
    if (status >= 500)
      return terminal(
        pollEr({ kind: 'upstream_unavailable', httpStatus: status }),
      );
    return terminal(malformedPoll());
  }
  private readPolled(response: unknown, quotationId: string): PollGet {
    try {
      const data = field(response, 'data');
      if (!isObject(data)) return terminal(malformedPoll());
      if (field(data, 'id') !== quotationId) return terminal(malformedPoll());
      const complete: unknown = field(data, 'is_completed');
      if (typeof complete !== 'boolean') return terminal(malformedPoll());
      if (!complete) return { kind: 'incomplete' };
      const providerRates = snapshotRates(field(data, 'rates'));
      if (providerRates === null) return terminal(malformedPoll());
      return { kind: 'complete', providerRates };
    } catch {
      return terminal(malformedPoll());
    }
  }
}

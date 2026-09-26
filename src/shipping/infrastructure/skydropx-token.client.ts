/** SQ-3A1/SQ-3A2 Skydropx OAuth token transport: injectable transport, fail-closed parsing, strict runtime status/clock validation, bounded retry, secret-safe finite union, plus an in-memory token cache with expiry skew, single-flight refresh, and token-aware invalidation. */
import axios, { type AxiosRequestConfig } from 'axios';
import type { ShippingQuoteError } from '../domain/shipping-quote.error';
export type SkydropxHttpResponse = {
  readonly status: number;
  readonly data: unknown;
  readonly headers?: unknown;
};
export type SkydropxHttp = (
  config: AxiosRequestConfig,
) => Promise<SkydropxHttpResponse>;
export const defaultSkydropxHttp: SkydropxHttp = (config) =>
  axios.request({ ...config, validateStatus: () => true });
export interface SkydropxTokenClientConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs: number;
}
export interface SkydropxTokenClientDeps {
  readonly http?: SkydropxHttp;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}
export type SkydropxTokenResult =
  | { readonly kind: 'token'; readonly accessToken: string }
  | { readonly kind: 'error'; readonly error: ShippingQuoteError };
type CachedToken = {
  readonly accessToken: string;
  readonly expiresAt: number;
};
type Attempt = {
  readonly result: SkydropxTokenResult;
  readonly retry: boolean;
  readonly cached: CachedToken | null;
};
const RETRY_BACKOFF_MS = 250;
const MAX_TOKEN_LENGTH = 4_096;
export const TOKEN_EXPIRY_SKEW_MS = 30_000;
const isObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const isMillis = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const er = (error: ShippingQuoteError): SkydropxTokenResult => ({
  kind: 'error',
  error,
});
const malformed = (): SkydropxTokenResult => er({ kind: 'malformed_response' });
const out = (result: SkydropxTokenResult, retry: boolean): Attempt => ({
  result,
  retry,
  cached: null,
});
function parseToken(data: unknown, now: number): CachedToken | null {
  try {
    if (!isObject(data)) return null;
    const at: unknown = data.access_token;
    const type: unknown = data.token_type;
    const expires: unknown = data.expires_in;
    if (typeof at !== 'string') return null;
    if (at.length === 0 || at.length > MAX_TOKEN_LENGTH) return null;
    if (at.trim() !== at) return null;
    if (type !== 'Bearer') return null;
    if (typeof expires !== 'number' || !Number.isSafeInteger(expires))
      return null;
    if (expires <= 0) return null;
    const lifetimeMs = expires * 1000;
    if (!Number.isSafeInteger(lifetimeMs)) return null;
    if (!Number.isSafeInteger(now + lifetimeMs)) return null;
    return { accessToken: at, expiresAt: now + lifetimeMs };
  } catch {
    return null;
  }
}
function readStatus(response: unknown): number | null {
  try {
    const status = (response as { status?: unknown } | null | undefined)
      ?.status;
    if (typeof status !== 'number' || !Number.isSafeInteger(status))
      return null;
    return status >= 100 && status <= 599 ? status : null;
  } catch {
    return null;
  }
}
function readMillis(now: () => number): number | null {
  try {
    const value = now();
    return isMillis(value) ? value : null;
  } catch {
    return null;
  }
}
function readRetryAfter(headers: unknown): number | null {
  if (!isObject(headers)) return null;
  const raw: unknown = headers['retry-after'] ?? headers['Retry-After'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds : null;
}
function isTimeout(thrown: unknown): boolean {
  try {
    if (typeof thrown !== 'object' || thrown === null) return false;
    const { code, name } = thrown as { code?: unknown; name?: unknown };
    return (
      code === 'ECONNABORTED' ||
      code === 'ERR_CANCELED' ||
      code === 'ETIMEDOUT' ||
      name === 'AbortError'
    );
  } catch {
    return false;
  }
}
export class SkydropxTokenClient {
  private readonly http: SkydropxHttp;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private cache: CachedToken | null = null;
  private inflight: Promise<SkydropxTokenResult> | null = null;
  private epoch = 0;
  constructor(
    private readonly config: SkydropxTokenClientConfig,
    deps: SkydropxTokenClientDeps = {},
  ) {
    this.http = deps.http ?? defaultSkydropxHttp;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  getToken = (): Promise<SkydropxTokenResult> => this.obtain();
  invalidate = (accessToken: string): void => {
    const cached = this.cache;
    if (cached === null || cached.accessToken !== accessToken) return;
    this.cache = null;
    this.epoch += 1;
  };
  private configValid(): boolean {
    const { baseUrl, clientId, clientSecret, timeoutMs } = this.config;
    const blank = (v: unknown): boolean =>
      typeof v !== 'string' || v.trim().length === 0;
    if (blank(baseUrl) || blank(clientId) || blank(clientSecret)) return false;
    return Number.isSafeInteger(timeoutMs) && timeoutMs > 0;
  }
  private async attempt(url: string): Promise<Attempt> {
    let response: SkydropxHttpResponse;
    try {
      response = await this.http({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeout: this.config.timeoutMs,
        data: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'client_credentials',
        }),
      });
    } catch (thrown) {
      if (isTimeout(thrown)) return out(er({ kind: 'timeout' }), false);
      return out(er({ kind: 'upstream_unavailable', httpStatus: null }), true);
    }
    const status = readStatus(response);
    if (status === null) return out(malformed(), false);
    if (status >= 200 && status < 300) {
      const now = readMillis(this.now);
      const token = now === null ? null : parseToken(response.data, now);
      if (token === null) return out(malformed(), false);
      return {
        result: { kind: 'token', accessToken: token.accessToken },
        retry: false,
        cached: token,
      };
    }
    if (status === 400 || status === 401 || status === 403)
      return out(er({ kind: 'auth_failed' }), false);
    if (status === 429) {
      const after = readRetryAfter(response.headers);
      return out(er({ kind: 'rate_limited', retryAfterSeconds: after }), true);
    }
    if (status >= 500)
      return out(
        er({ kind: 'upstream_unavailable', httpStatus: status }),
        true,
      );
    return out(malformed(), false);
  }
  private singleFlight(): Promise<SkydropxTokenResult> {
    const existing = this.inflight;
    if (existing !== null) return existing;
    let resolve!: (value: SkydropxTokenResult) => void;
    let reject!: (reason?: unknown) => void;
    const run = new Promise<SkydropxTokenResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.inflight = run;
    const clear = (): void => {
      if (this.inflight === run) this.inflight = null;
    };
    void run.then(clear, clear);
    void this.acquire().then(resolve, reject);
    return run;
  }
  private async obtain(): Promise<SkydropxTokenResult> {
    try {
      if (!this.configValid()) return er({ kind: 'provider_disabled' });
      const nowMs = readMillis(this.now);
      if (nowMs === null) return malformed();
      const cached = this.cache;
      if (cached !== null && nowMs < cached.expiresAt - TOKEN_EXPIRY_SKEW_MS)
        return { kind: 'token', accessToken: cached.accessToken };
      return await this.singleFlight();
    } catch {
      return er({ kind: 'upstream_unavailable', httpStatus: null });
    }
  }
  private async acquire(): Promise<SkydropxTokenResult> {
    const generation = this.epoch;
    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/api/v1/oauth/token`;
      const first = await this.attempt(url);
      if (!first.retry) return this.settle(first, generation);
      try {
        await this.sleep(RETRY_BACKOFF_MS);
      } catch {
        // A broken sleep seam must not surface; the retry proceeds.
      }
      return this.settle(await this.attempt(url), generation);
    } catch {
      return er({ kind: 'upstream_unavailable', httpStatus: null });
    }
  }
  private settle(attempt: Attempt, generation: number): SkydropxTokenResult {
    if (attempt.cached !== null && generation === this.epoch)
      this.cache = attempt.cached;
    return attempt.result;
  }
}

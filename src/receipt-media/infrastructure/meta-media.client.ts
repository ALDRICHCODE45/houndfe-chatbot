/** WU4B1B: Meta metadata hop composition over the WU4B1A origin/pinning policy.
 *  Provider-id-only: the Graph metadata URL is derived internally from the
 *  configured origin and the encoded id, every failure maps to a fixed safe
 *  MetaMediaError, and the returned download URL is never followed here.
 *  WU4B2 added manual redirect download transport; WU4B3B1a adds the
 *  infrastructure-local metadata projection consumed by the later B3B1b
 *  stream pipeline on this same client surface. */
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import axios, { type AxiosRequestConfig } from 'axios';
import {
  MetaMediaError,
  type MetaMediaRequest,
  type ReceiptMimeType,
} from '../domain/meta-media.port';
import {
  defaultResolver,
  pinnedLookup,
  validateMetaMediaOrigin,
  type MetaDnsResolver,
  type MetaMediaOriginPolicyConfig,
} from './meta-media-origin.policy';

export interface MetaMediaClientConfig extends MetaMediaOriginPolicyConfig {
  /** Configured Graph origin including the API version, e.g. https://graph.facebook.com/v23.0. */
  graphApiBaseUrl: string;
  /** Bounded metadata timeout in milliseconds. */
  metadataTimeoutMs: number;
  /** Bounded download timeout in milliseconds, applied to every download hop. */
  downloadTimeoutMs: number;
}

export type MetaHttpResponse = {
  status: number;
  data: unknown;
  headers?: unknown;
};

export type MetaHttp = (
  config: AxiosRequestConfig,
) => Promise<MetaHttpResponse>;

export type MetaAgentFactory = (lookup: LookupFunction) => https.Agent;

/** Narrow WU4B3 handoff: the final successful streaming response plus an
 *  idempotent release that destroys the final hop's pinned agent exactly once,
 *  only after the consumer no longer needs the stream. */
export interface MetaDownloadHandle {
  response: MetaHttpResponse;
  release: () => void;
}

export interface MetaMediaClientDeps {
  http?: MetaHttp;
  resolve?: MetaDnsResolver;
  createAgent?: MetaAgentFactory;
}

/** WU4B3B1a infrastructure-local metadata projection: only the returned
 *  download URL, the canonical declared MIME, and the provider-declared byte
 *  size — everything the B3B1b stream pipeline may rely on, and nothing more. */
export interface MetaMediaMetadata {
  downloadUrl: string;
  mimeType: ReceiptMimeType;
  providerDeclaredBytes: number;
}

const transportFailure = (): MetaMediaError =>
  new MetaMediaError('META_TRANSPORT', 'NETWORK_FAILURE');

/** The only canonical media types the whole pipeline accepts. */
const CANONICAL_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
]);

/** Design byte bound: provider-declared size must be 1..10_485_760. */
const MAX_PROVIDER_BYTES = 10_485_760;

/** Only the pinned lookup is customized; TLS naming and ordinary hostname
 *  verification are never overridden. */
export const defaultAgentFactory: MetaAgentFactory = (lookup) =>
  new https.Agent({ lookup });

/** One configured origin plus one encoded provider id: the id can never alter
 *  the origin, the path shape, or introduce a query or fragment. */
function composeMetadataUrl(
  graphApiBaseUrl: string,
  providerMediaId: string,
): string {
  if (providerMediaId.trim() === '') throw transportFailure();
  return `${graphApiBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(providerMediaId)}`;
}

/** Axios maps its own bounded timeout to ECONNABORTED and a caller-signal
 *  abort to ERR_CANCELED; everything else is a plain network failure.
 *  Classification duck-types only the transport code — plain code strings
 *  and synthetic Error-like rejections never need an Axios brand check. */
function mapTransportError(error: unknown): MetaMediaError {
  if (error instanceof MetaMediaError) return error;
  const code: unknown =
    typeof error === 'string'
      ? error
      : (error as { code?: unknown } | null)?.code;
  if (code === 'ERR_CANCELED')
    return new MetaMediaError('META_TRANSPORT', 'ABORTED');
  if (code === 'ECONNABORTED')
    return new MetaMediaError('META_TRANSPORT', 'TIMEOUT');
  return transportFailure();
}

/** Fixed safe HTTP disposition (design: 408/429/5xx retryable, every other
 *  non-2xx permanent; no status, URL, or response body detail attached). */
function httpStatusError(status: number): MetaMediaError {
  const retryable = status === 408 || status === 429 || status >= 500;
  return new MetaMediaError(
    'META_TRANSPORT',
    retryable ? 'HTTP_RETRYABLE' : 'HTTP_PERMANENT',
  );
}

function metadataString(data: unknown, field: string): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function metadataNumber(data: unknown, field: string): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : undefined;
}

/** Only a non-empty returned download URL is projected; it is never followed
 *  or validated for transport here (that is the next hop's own policy). */
function extractDownloadUrl(data: unknown): string {
  const url = metadataString(data, 'url');
  if (url !== undefined && url !== '') return url;
  // 200 without a usable download URL: permanent, never network-retryable.
  throw new MetaMediaError('META_TRANSPORT', 'HTTP_PERMANENT');
}

/** The metadata mime_type must already be a canonical media type; anything
 *  missing, non-string, or unsupported fails closed. */
function extractMetadataMime(data: unknown): ReceiptMimeType {
  const mime = metadataString(data, 'mime_type');
  if (mime !== undefined && CANONICAL_MIME_TYPES.has(mime))
    return mime as ReceiptMimeType;
  throw new MetaMediaError('MEDIA_VALIDATION', 'UNSUPPORTED_MIME');
}

/** The provider-declared size must be a safe integer within the design
 *  bounds; missing, mistyped, fractional, non-safe, zero, negative, and
 *  over-limit values all fail closed. */
function extractProviderBytes(data: unknown): number {
  const size = metadataNumber(data, 'file_size');
  if (
    size === undefined ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_PROVIDER_BYTES
  )
    throw new MetaMediaError('MEDIA_VALIDATION', 'INVALID_MEDIA_SIZE');
  return size;
}

/** WU4B3B1a: validates the metadata body against the declared MIME and
 *  projects the B3B1b contract; declared/provider disagreement and any
 *  invalid size are rejected before any download request can exist. */
function projectMetadata(
  data: unknown,
  declaredMimeType: ReceiptMimeType,
): MetaMediaMetadata {
  const downloadUrl = extractDownloadUrl(data);
  const mimeType = extractMetadataMime(data);
  if (mimeType !== declaredMimeType)
    throw new MetaMediaError('MEDIA_VALIDATION', 'MIME_MISMATCH');
  return {
    downloadUrl,
    mimeType,
    providerDeclaredBytes: extractProviderBytes(data),
  };
}

/** Exactly the statuses this client follows manually; Axios auto redirects
 *  are never enabled, so every follow is a fresh revalidated hop. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** Initial request plus at most three follow requests, per design. */
const MAX_REDIRECTS = 3;

/** Safely resolves a Location value (absolute or relative) against the current
 *  hop URL; missing, malformed, or non-string locations fail closed through
 *  the fixed safe HTTP disposition and are never embedded in any error. */
function resolveRedirectTarget(
  current: string,
  response: MetaHttpResponse,
): string {
  const headers = response.headers;
  const location =
    typeof headers === 'object' && headers !== null
      ? (headers as { location?: unknown }).location
      : undefined;
  if (typeof location !== 'string' || location === '')
    throw httpStatusError(response.status);
  try {
    return new URL(location, current).toString();
  } catch {
    throw httpStatusError(response.status);
  }
}

export class MetaMediaClient {
  private readonly http: MetaHttp;
  private readonly resolve: MetaDnsResolver;
  private readonly createAgent: MetaAgentFactory;

  constructor(
    private readonly config: MetaMediaClientConfig,
    private readonly bearerToken: () => string,
    deps: MetaMediaClientDeps = {},
  ) {
    this.http = deps.http ?? ((request) => axios.request(request));
    this.resolve = deps.resolve ?? defaultResolver();
    this.createAgent = deps.createAgent ?? defaultAgentFactory;
  }

  /** One composed, policy-validated, bearer-after-pinning metadata hop
   *  returning the raw 2xx body; shared by the WU4B1B URL resolution and
   *  the WU4B3B1a projection. */
  private async fetchMetadata(request: MetaMediaRequest): Promise<unknown> {
    try {
      const url = composeMetadataUrl(
        this.config.graphApiBaseUrl,
        request.providerMediaId,
      );
      // Validates the full hop URL (HTTPS, no userinfo/query/fragment, port,
      // allowlist) and requires public A/AAAA records; failures fail closed.
      const addresses = await validateMetaMediaOrigin(
        url,
        this.config,
        this.resolve,
      );
      const parsed = new URL(url);
      // Policy passed and addresses pinned: only now may the Authorization
      // header be created — a rejected target receives no bearer value.
      const agent = this.createAgent(pinnedLookup(parsed.hostname, addresses));
      try {
        const response = await this.http({
          method: 'GET',
          url: parsed.toString(),
          signal: request.signal,
          timeout: this.config.metadataTimeoutMs,
          proxy: false,
          maxRedirects: 0,
          httpsAgent: agent,
          headers: { Authorization: `Bearer ${this.bearerToken()}` },
          validateStatus: () => true,
        });
        if (response.status < 200 || response.status > 299)
          throw httpStatusError(response.status);
        return response.data;
      } finally {
        agent.destroy(); // every path: success, status, body, abort, timeout
      }
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  /** Resolves the provider media id to its returned download URL; the
   *  authenticated download hop is WU4B2's and is never issued here. */
  async resolveDownloadUrl(request: MetaMediaRequest): Promise<string> {
    return extractDownloadUrl(await this.fetchMetadata(request));
  }

  /** WU4B3B1a: one metadata hop whose body is validated into the projection
   *  before returning; no download request is ever issued here. A runtime-
   *  invalid declared MIME is rejected before any bearer or request. */
  async resolveMetadata(request: MetaMediaRequest): Promise<MetaMediaMetadata> {
    if (!CANONICAL_MIME_TYPES.has(request.declaredMimeType))
      throw new MetaMediaError('MEDIA_VALIDATION', 'UNSUPPORTED_MIME');
    try {
      return projectMetadata(
        await this.fetchMetadata(request),
        request.declaredMimeType,
      );
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  /** WU4B2: authenticated manual-redirect download transport over a returned
   *  download URL. Every hop is revalidated and repinned before any request,
   *  receives the bearer only after its own policy passes, and follows at most
   *  three 301/302/303/307/308 redirects manually; every other disposition is
   *  a fixed safe error. The final streaming response keeps its pinned agent
   *  until the consumer calls release, so WU4B3 can read and bound the stream
   *  before handing the agent back. No stream is read, inspected, or bounded
   *  here. */
  async downloadStream(
    request: MetaMediaRequest,
    downloadUrl: string,
  ): Promise<MetaDownloadHandle> {
    try {
      let target = downloadUrl;
      for (let followed = 0; ; followed += 1) {
        // Per-hop policy before any request construction or bearer on this hop;
        // a rejected target receives no bearer value and no network call.
        const addresses = await validateMetaMediaOrigin(
          target,
          this.config,
          this.resolve,
        );
        const parsed = new URL(target);
        // A fresh pinned agent per hop: completed redirect and error hops are
        // destroyed immediately; the final hop's agent outlives this method.
        const agent = this.createAgent(
          pinnedLookup(parsed.hostname, addresses),
        );
        let response: MetaHttpResponse;
        try {
          response = await this.http({
            method: 'GET',
            url: parsed.toString(),
            responseType: 'stream',
            signal: request.signal,
            timeout: this.config.downloadTimeoutMs,
            proxy: false,
            maxRedirects: 0,
            httpsAgent: agent,
            headers: { Authorization: `Bearer ${this.bearerToken()}` },
            validateStatus: () => true,
          });
        } catch (error) {
          agent.destroy(); // failed hop: teardown is immediate, never deferred
          throw error;
        }
        if (response.status >= 200 && response.status <= 299) {
          // Success: hand the agent's lifetime over idempotently — the stream
          // stays consumable until the consumer releases it.
          let released = false;
          return {
            response,
            release: () => {
              if (released) return;
              released = true;
              agent.destroy();
            },
          };
        }
        // Every non-2xx disposition tears this hop's agent down immediately.
        agent.destroy();
        if (
          REDIRECT_STATUSES.has(response.status) &&
          followed < MAX_REDIRECTS
        ) {
          target = resolveRedirectTarget(target, response);
          continue;
        }
        // Fourth redirect, unfollowable redirect, or non-redirect non-2xx:
        // one fixed safe HTTP disposition, never any Location or URL detail.
        throw httpStatusError(response.status);
      }
    } catch (error) {
      throw mapTransportError(error);
    }
  }
}

/** WU4B1B: Meta metadata hop composition over the WU4B1A origin/pinning policy.
 *  Provider-id-only: the Graph metadata URL is derived internally from the
 *  configured origin and the encoded id, every failure maps to a fixed safe
 *  MetaMediaError, and the returned download URL is never followed here.
 *  Manual redirect transport (WU4B2) and the stream/temp pipeline (WU4B3) are
 *  later slices on this same client surface. */
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import axios, { type AxiosRequestConfig } from 'axios';
import {
  MetaMediaError,
  type MetaMediaRequest,
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
}

export type MetaHttpResponse = { status: number; data: unknown };

export type MetaHttp = (
  config: AxiosRequestConfig,
) => Promise<MetaHttpResponse>;

export type MetaAgentFactory = (lookup: LookupFunction) => https.Agent;

export interface MetaMediaClientDeps {
  http?: MetaHttp;
  resolve?: MetaDnsResolver;
  createAgent?: MetaAgentFactory;
}

const transportFailure = (): MetaMediaError =>
  new MetaMediaError('META_TRANSPORT', 'NETWORK_FAILURE');

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

/** Only a non-empty returned download URL is projected; it is never followed
 *  or validated for transport here (that is the next hop's own policy). */
function extractDownloadUrl(data: unknown): string {
  const url =
    typeof data === 'object' && data !== null
      ? (data as { url?: unknown }).url
      : undefined;
  if (typeof url === 'string' && url !== '') return url;
  // 200 without a usable download URL: permanent, never network-retryable.
  throw new MetaMediaError('META_TRANSPORT', 'HTTP_PERMANENT');
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

  /** Resolves the provider media id to its returned download URL; the
   *  authenticated download hop is WU4B2's and is never issued here. */
  async resolveDownloadUrl(request: MetaMediaRequest): Promise<string> {
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
        return extractDownloadUrl(response.data);
      } finally {
        agent.destroy(); // every path: success, status, body, abort, timeout
      }
    } catch (error) {
      throw mapTransportError(error);
    }
  }
}

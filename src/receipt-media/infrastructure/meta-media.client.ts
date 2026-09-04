/** WU4B1B: Meta metadata hop composition over the WU4B1A origin/pinning policy.
 *  Provider-id-only: the Graph metadata URL is derived internally from the
 *  configured origin and the encoded id, every failure maps to a fixed safe
 *  MetaMediaError, and the returned download URL is never followed here.
 *  WU4B2 added manual redirect download transport; WU4B3B1a added the
 *  infrastructure-local metadata projection; WU4B3B1b adds the successful
 *  bounded stream/temp-file pipeline and WU4B3B2R1B the safe cleanup
 *  projection on this same client surface. */
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import axios, { type AxiosRequestConfig } from 'axios';
import {
  MetaMediaError,
  type MetaMediaRequest,
  type ReceiptMimeType,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import { validateMediaStructure } from './media-structure.validator';
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
  /** Narrow WU4B3 seam: injectable only so a later slice can drive
   *  deterministic I/O failures; success paths always use the real default. */
  createTempFile?: MetaTempFileFactory;
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

/** Stream/temp pipeline bound (design: 10 MiB, enforced while streaming). */
const MAX_MEDIA_BYTES = 10_485_760;

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

const invalidSize = (): MetaMediaError =>
  new MetaMediaError('MEDIA_VALIDATION', 'INVALID_MEDIA_SIZE');

/** Fixed safe cancellation marker: maps a caller abort to the fixed safe ABORTED. */
const canceled = (): Error =>
  Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });

/** Narrow WU4B3 seam: one open exclusive temp file handle. write resolves to
 *  the bytesWritten count actually persisted for the given chunk; a void
 *  result reports no progress and fails closed. */
export interface MetaTempFile {
  filePath: string;
  write: (chunk: Buffer) => Promise<number | void>;
  close: () => Promise<void>;
}

export type MetaTempFileFactory = (dir: string) => Promise<MetaTempFile>;

/** Real random exclusive ('wx') file under dir, created with mode 0600. */
export const defaultTempFileFactory: MetaTempFileFactory = async (dir) => {
  const filePath = path.join(
    dir,
    `receipt-media-${randomBytes(12).toString('hex')}`,
  );
  const handle = await fs.promises.open(filePath, 'wx', 0o600);
  return {
    filePath,
    write: async (chunk) => (await handle.write(chunk)).bytesWritten,
    close: () => handle.close(),
  };
};

/** Magic-byte sniffing over the bounded read-back; anything else is unknown. */
function detectMagic(bytes: Buffer): ReceiptMimeType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return 'image/png';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return 'image/jpeg';
  return undefined;
}

/** Persists every chunk byte through the seam before returning: honest partial
 *  progress is retried on the unwritten remainder, while void, zero, negative,
 *  non-safe-integer, or over-length progress fails closed immediately so no
 *  write loop can ever hang. */
async function writeAll(temp: MetaTempFile, chunk: Buffer): Promise<void> {
  let written = 0;
  while (written < chunk.length) {
    const progress = await ioStep(() => temp.write(chunk.subarray(written)));
    if (
      typeof progress !== 'number' ||
      !Number.isSafeInteger(progress) ||
      progress < 1 ||
      progress > chunk.length - written
    )
      throw new MetaMediaError('META_TRANSPORT', 'FILE_IO_FAILURE');
    written += progress;
  }
}

/** WU4B3B2: temp-pipeline I/O failures (open/write/close/read-back) map to
 *  the fixed safe FILE_IO_FAILURE; projected rejections pass through and no
 *  I/O detail (path, fd, errno, cause) reaches any caller-visible error. */
async function ioStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof MetaMediaError) throw error;
    throw new MetaMediaError('META_TRANSPORT', 'FILE_IO_FAILURE');
  }
}

/** One failure-path cleanup step: resolves false when the real close/unlink
 *  step succeeds and true when it fails, so the caller can attempt every step
 *  even after one fails, surface exactly one fixed safe FILE_IO_FAILURE, and
 *  never recurse into further cleanup. */
function failedStep(step: () => Promise<unknown>): Promise<boolean> {
  return step().then(
    () => false,
    () => true,
  );
}

/** WU4B3B2 response-header guards: the only allowed Content-Type
 *  normalization is parameter stripping and the value must equal the agreed
 *  canonical MIME; an absent Content-Length is accepted, a present one must
 *  be a valid safe non-negative decimal within the design bound and is later
 *  required to equal the final counted byte total exactly. */
function responseMimeOf(headers: unknown): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const raw = (headers as Record<string, unknown>)['content-type'];
  return typeof raw === 'string' ? raw.split(';')[0].trim() : undefined;
}

function responseLengthOf(headers: unknown): number | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const raw = (headers as Record<string, unknown>)['content-length'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw invalidSize();
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > MAX_MEDIA_BYTES)
    throw invalidSize();
  return length;
}

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
  private readonly createTempFile: MetaTempFileFactory;

  constructor(
    private readonly config: MetaMediaClientConfig,
    private readonly bearerToken: () => string,
    deps: MetaMediaClientDeps = {},
  ) {
    this.http = deps.http ?? ((request) => axios.request(request));
    this.resolve = deps.resolve ?? defaultResolver();
    this.createAgent = deps.createAgent ?? defaultAgentFactory;
    this.createTempFile = deps.createTempFile ?? defaultTempFileFactory;
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

  /** WU4B3B1b: one logical Meta attempt — exactly one metadata resolution
   *  (B3B1a projection) then the verified B2 download chain — returning the
   *  WU4B3A validated-file contract. The stream is consumed with backpressure,
   *  bounded at 10 MiB before any overflowing byte is written, hashed
   *  incrementally, and stored in a real random exclusive mode-0600 temp file
   *  under the OS temp directory. The final agent is released exactly once
   *  after settlement; every failure path unlinks any partial temp file and
   *  releases the agent, and a real failure-path close/unlink failure is
   *  surfaced as the fixed safe FILE_IO_FAILURE instead of being swallowed. */
  async resolveAndDownload(
    request: MetaMediaRequest,
  ): Promise<ValidatedMediaFile> {
    let handle: MetaDownloadHandle | undefined;
    let source: Readable | undefined;
    let temp: MetaTempFile | undefined;
    try {
      const metadata = await this.resolveMetadata(request);
      handle = await this.downloadStream(request, metadata.downloadUrl);
      source = handle.response.data as Readable;
      // WU4B3B2 header agreement guards, before any byte is consumed: the
      // response Content-Type must strip to exactly the agreed metadata MIME.
      if (responseMimeOf(handle.response.headers) !== metadata.mimeType)
        throw new MetaMediaError('MEDIA_VALIDATION', 'MIME_MISMATCH');
      const contentLength = responseLengthOf(handle.response.headers);
      // WU4B3B2R2 source-error-lifecycle: the observation is registered BEFORE
      // the first awaited window after the active body and replays an
      // already-fired abort right after registration. An abort destroys the
      // source exactly once WITHOUT an error (a pre-iterator destroy needs no
      // late consumer); signal-state checks at each later window keep ABORTED.
      const onAbort = (): void => {
        if (source !== undefined && !source.destroyed) source.destroy();
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (request.signal.aborted) throw canceled(); // replay a fired abort
        const tempFile = await ioStep(() => this.createTempFile(os.tmpdir()));
        temp = tempFile;
        // Post-create re-check: an abort in the awaited creation window must stop.
        if (request.signal.aborted) throw canceled();
        const tempPath = tempFile.filePath;
        const hash = createHash('sha256');
        let byteCount = 0;
        // Async iteration keeps the source paused between awaited writes,
        // so the provider stream is consumed with backpressure.
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as string);
          byteCount += buffer.length;
          // The bound is enforced before any overflowing byte is written.
          if (byteCount > MAX_MEDIA_BYTES) throw invalidSize();
          hash.update(buffer);
          // Every byte must be on disk before the next chunk is read.
          await writeAll(temp, buffer);
        }
        // Loop-completion boundary: even a clean iterator end must stay ABORTED.
        if (request.signal.aborted) throw canceled();
        await ioStep(() => tempFile.close());
        // A present Content-Length must equal the final counted bytes.
        if (contentLength !== undefined && contentLength !== byteCount)
          throw invalidSize();
        // Bounded read-back: the enforced cap guarantees at most 10 MiB here.
        const bytes = await ioStep(() => fs.promises.readFile(tempPath));
        // A live abort in the close/read-back windows must still settle ABORTED.
        if (request.signal.aborted) throw canceled();
        if (detectMagic(bytes) !== metadata.mimeType)
          throw new MetaMediaError('MEDIA_VALIDATION', 'MIME_MISMATCH');
        validateMediaStructure(bytes, metadata.mimeType);
        handle.release(); // settlement complete: final agent released exactly once
        return {
          filePath: tempPath,
          mimeType: metadata.mimeType,
          byteCount,
          providerDeclaredBytes: metadata.providerDeclaredBytes,
          sha256: hash.digest(),
          // Caller-owned idempotent technical cleanup of the validated file:
          // a real unlink failure is projected to the fixed safe
          // FILE_IO_FAILURE, never any raw path, errno, or system detail.
          cleanup: () =>
            ioStep(() => fs.promises.rm(tempPath, { force: true })),
        };
      } finally {
        request.signal.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      // Exactly-once source teardown: once the for-await loop has consumed
      // the source, Node's async-iterator completion (abrupt failure, mid-
      // stream error, or normal end) has already destroyed it, and a second
      // explicit destroy would invoke the stream's destroy again. Only a
      // failure before the loop consumed a byte leaves the source
      // undestroyed, and that teardown stays explicitly ours here.
      if (source !== undefined && !source.destroyed) source.destroy();
      handle?.release(); // exactly once: settlement never reaches here
      let cleanupFailed = false;
      if (temp !== undefined) {
        const pending = temp;
        // Close then unlink even after one step fails; each real failure is
        // captured, never recursively cleaned, and surfaced once below.
        if (await failedStep(() => pending.close())) cleanupFailed = true;
        if (
          await failedStep(() =>
            fs.promises.rm(pending.filePath, { force: true }),
          )
        )
          cleanupFailed = true;
      }
      // A real cleanup failure replaces the primary error so a caller can
      // never believe a temp file was removed when it was not; otherwise
      // the original safe domain error is preserved unchanged.
      if (cleanupFailed)
        throw new MetaMediaError('META_TRANSPORT', 'FILE_IO_FAILURE');
      // Catch boundary: a live caller abort after any registered window must
      // surface the fixed safe ABORTED, never a raw premature-close reason.
      if (request.signal.aborted)
        throw new MetaMediaError('META_TRANSPORT', 'ABORTED');
      throw mapTransportError(error);
    }
  }
}

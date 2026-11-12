import * as os from 'node:os';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { MEDIA_MAX_BYTES } from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import {
  defaultResolver,
  isPublicAddress,
  pinnedLookup,
  type MetaDnsResolver,
} from '../../receipt-media/infrastructure/meta-media-origin.policy';
import {
  defaultAgentFactory,
  defaultTempFileFactory,
  writeAll,
  type MetaAgentFactory,
  type MetaHttp,
  type MetaHttpResponse,
  type MetaTempFile,
  type MetaTempFileFactory,
} from '../../receipt-media/infrastructure/meta-media.client';
import type {
  DownloadedMirrorFile,
  MirrorLinkFetcher,
  MirrorSourceFailure,
  MirrorSourceResult,
  OpenedMirrorLink,
} from '../domain/mirror-media';
import { sniffMirrorMedia } from './mirror-media-profile';
import axios from 'axios';

export interface LinkMirrorFetcherConfig {
  /** Optional host allowlist (exact or label-boundary suffix); when empty or
   *  absent any PUBLIC host is allowed (the URL comes from our own catalog). */
  allowedHosts?: string[];
  timeoutMs: number;
  /** Non-production seam: the single allowed port instead of 443. */
  testPort?: number;
}

export interface LinkMirrorFetcherDeps {
  http?: MetaHttp;
  resolve?: MetaDnsResolver;
  createAgent?: MetaAgentFactory;
  createTempFile?: MetaTempFileFactory;
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
const HEAD_BYTES = 64;

/** A refused target: never fetched, mirrored as an unavailable media. */
const REFUSED: MirrorSourceFailure = {
  kind: 'unsupported',
  reason: 'media_unavailable',
};
const TRANSIENT: MirrorSourceFailure = {
  kind: 'retry',
  cause: 'source_transient',
};
const ABORTED: MirrorSourceFailure = { kind: 'retry', cause: 'aborted' };

class Refusal extends Error {}

function hostIsAllowed(hostname: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\./, '');
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>))
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  return undefined;
}

/**
 * OUT product photos: fetch a public HTTPS link with the same safety the
 * Meta media client applies to outbound hops (https only, no userinfo, fixed
 * port, public A/AAAA records pinned for the connection, manual redirects of
 * at most three hops each revalidated), minus the bearer: no credential ever
 * leaves with this request. The body is streamed to a mode-0600 temp file
 * under a 10 MiB cap, sniffed and hashed; an unread body can be discarded
 * (cache hit) so only the headers were transferred.
 */
export class LinkMirrorFetcher implements MirrorLinkFetcher {
  private readonly http: MetaHttp;
  private readonly resolve: MetaDnsResolver;
  private readonly createAgent: MetaAgentFactory;
  private readonly createTempFile: MetaTempFileFactory;

  constructor(
    private readonly config: LinkMirrorFetcherConfig,
    deps: LinkMirrorFetcherDeps = {},
  ) {
    this.http = deps.http ?? ((request) => axios.request(request));
    this.resolve = deps.resolve ?? defaultResolver();
    this.createAgent = deps.createAgent ?? defaultAgentFactory;
    this.createTempFile = deps.createTempFile ?? defaultTempFileFactory;
  }

  async open(input: {
    url: string;
    signal: AbortSignal;
  }): Promise<MirrorSourceResult<OpenedMirrorLink>> {
    try {
      let target = input.url;
      for (let followed = 0; ; followed += 1) {
        const addresses = await this.validate(target);
        const parsed = new URL(target);
        const agent = this.createAgent(
          pinnedLookup(parsed.hostname, addresses),
        );
        let response: MetaHttpResponse;
        try {
          response = await this.http({
            method: 'GET',
            url: parsed.toString(),
            responseType: 'stream',
            signal: input.signal,
            timeout: this.config.timeoutMs,
            proxy: false,
            maxRedirects: 0,
            httpsAgent: agent,
            validateStatus: () => true,
          });
        } catch (error) {
          agent.destroy();
          throw error;
        }
        if (response.status >= 200 && response.status <= 299)
          return {
            kind: 'ok',
            value: this.opened(response, agent, input.signal),
          };
        agent.destroy();
        (response.data as Readable | undefined)?.destroy?.();
        if (
          REDIRECT_STATUSES.has(response.status) &&
          followed < MAX_REDIRECTS
        ) {
          target = this.redirectTarget(target, response);
          continue;
        }
        return statusFailure(response.status);
      }
    } catch (error) {
      return mapOpenError(error);
    }
  }

  /** Policy before any request: https, no userinfo/fragment, fixed port,
   *  optional allowlist, and every resolved address public. */
  private async validate(url: string) {
    if (url.includes('#')) throw new Refusal();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Refusal();
    }
    const port = this.config.testPort ?? 443;
    const portOk =
      parsed.port === '' ? port === 443 : Number(parsed.port) === port;
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !portOk ||
      !hostIsAllowed(parsed.hostname, this.config.allowedHosts ?? [])
    )
      throw new Refusal();
    let addresses;
    try {
      addresses = await this.resolve(parsed.hostname);
    } catch {
      throw new Refusal();
    }
    if (
      addresses.length === 0 ||
      !addresses.every((entry) => isPublicAddress(entry.address, entry.family))
    )
      throw new Refusal();
    return addresses;
  }

  private redirectTarget(current: string, response: MetaHttpResponse): string {
    const location = headerOf(response.headers, 'location');
    if (location === undefined || location === '') throw new Refusal();
    try {
      return new URL(location, current).toString();
    } catch {
      throw new Refusal();
    }
  }

  private opened(
    response: MetaHttpResponse,
    agent: { destroy(): void },
    signal: AbortSignal,
  ): OpenedMirrorLink {
    const body = response.data as Readable;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      agent.destroy();
    };
    const etag = headerOf(response.headers, 'etag')?.trim();
    const modified = headerOf(response.headers, 'last-modified')?.trim();
    const version =
      etag !== undefined && etag !== ''
        ? etag
        : modified !== undefined && modified !== ''
          ? modified
          : null;
    return {
      version,
      discard: () => {
        if (!body.destroyed) body.destroy();
        release();
      },
      download: async () => {
        try {
          return await this.readBody(response, body, signal);
        } finally {
          if (!body.destroyed) body.destroy();
          release();
        }
      },
    };
  }

  private async readBody(
    response: MetaHttpResponse,
    body: Readable,
    signal: AbortSignal,
  ): Promise<MirrorSourceResult<DownloadedMirrorFile>> {
    const declared = headerOf(response.headers, 'content-length');
    const declaredLength =
      declared !== undefined && /^\d+$/.test(declared)
        ? Number(declared)
        : undefined;
    if (declaredLength !== undefined && declaredLength > MEDIA_MAX_BYTES)
      return { kind: 'unsupported', reason: 'too_large' };
    let temp: MetaTempFile | undefined;
    const onAbort = (): void => {
      if (!body.destroyed) body.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) return ABORTED;
      try {
        temp = await this.createTempFile(os.tmpdir());
      } catch {
        return { kind: 'retry', cause: 'local_io' };
      }
      const hash = createHash('sha256');
      const head: Buffer[] = [];
      let headLength = 0;
      let count = 0;
      for await (const chunk of body) {
        if (signal.aborted) return await this.discardTemp(temp, ABORTED);
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as string);
        count += buffer.length;
        if (count > MEDIA_MAX_BYTES)
          return await this.discardTemp(temp, {
            kind: 'unsupported',
            reason: 'too_large',
          });
        if (headLength < HEAD_BYTES) {
          head.push(buffer.subarray(0, HEAD_BYTES - headLength));
          headLength += Math.min(buffer.length, HEAD_BYTES - headLength);
        }
        hash.update(buffer);
        await writeAll(temp, buffer);
      }
      if (signal.aborted) return await this.discardTemp(temp, ABORTED);
      await temp.close();
      if (declaredLength !== undefined && declaredLength !== count)
        return await this.discardTemp(temp, TRANSIENT);
      const mimeType = sniffMirrorMedia(Buffer.concat(head));
      if (mimeType === undefined)
        return await this.discardTemp(temp, {
          kind: 'unsupported',
          reason: 'type_not_allowed',
        });
      const filePath = temp.filePath;
      return {
        kind: 'ok',
        value: {
          filePath,
          mimeType,
          byteCount: count,
          sha256Hex: hash.digest('hex'),
          cleanup: () => fs.promises.rm(filePath, { force: true }),
        },
      };
    } catch (error) {
      const failure: MirrorSourceFailure = signal.aborted
        ? ABORTED
        : isFileIo(error)
          ? { kind: 'retry', cause: 'local_io' }
          : TRANSIENT;
      return temp === undefined
        ? failure
        : await this.discardTemp(temp, failure);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Closes and unlinks a partial file (best effort), then yields `result`. */
  private async discardTemp(
    temp: MetaTempFile,
    result: MirrorSourceFailure,
  ): Promise<MirrorSourceFailure> {
    await temp.close().catch(() => undefined);
    await fs.promises.rm(temp.filePath, { force: true }).catch(() => undefined);
    return result;
  }
}

function isFileIo(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'FILE_IO_FAILURE'
  );
}

function statusFailure(status: number): MirrorSourceFailure {
  return status === 408 || status === 429 || status >= 500
    ? TRANSIENT
    : REFUSED;
}

function mapOpenError(error: unknown): MirrorSourceFailure {
  if (error instanceof Refusal) return REFUSED;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ERR_CANCELED') return ABORTED;
  return TRANSIENT;
}

import { Logger } from '@nestjs/common';
import type { ConversationMirrorClient } from '../../chatbot-api/domain/conversation-mirror.port';
import type { UploadMediaResult } from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import { mediaIdempotencyKey } from '../../chatbot-api/domain/uuid-v5';
import type {
  DownloadedMirrorFile,
  MirrorLinkFetcher,
  MirrorMediaContractType,
  MirrorMetaDownloader,
  MirrorSourceFailure,
  MirrorSourceResult,
  ResolveMediaOptions,
  ResolveMediaOutcome,
} from '../domain/mirror-media';
import type {
  MirrorMediaCacheEntry,
  MirrorMediaCacheStore,
} from '../domain/mirror-media-cache.store';
import {
  canonicalMirrorMime,
  mirrorMimeFitsType,
} from '../infrastructure/mirror-media-profile';
import { AsyncSemaphore } from './async-semaphore';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTRACT_TYPES: readonly string[] = [
  'IMAGE',
  'STICKER',
  'DOCUMENT',
  'AUDIO',
];

export interface MirrorMediaServiceDeps {
  client: Pick<ConversationMirrorClient, 'uploadMedia'>;
  meta: MirrorMetaDownloader;
  links: MirrorLinkFetcher;
  cache: MirrorMediaCacheStore;
  clock?: () => Date;
  /** Transfers (download + upload) in flight at once. Default 2 (S1). */
  maxConcurrency?: number;
  /** A cached id older than this is re-uploaded under a fresh key (the
   *  backend keeps media ~12 months). Default 180 days. */
  cacheMaxAgeMs?: number;
  /** A hit refreshes `last_used_at` only when older than this. Default 1 day. */
  touchAfterMs?: number;
  /** How long a link's version (ETag / Last-Modified) is trusted without
   *  asking the host again. Default 10 minutes. */
  linkVersionTtlMs?: number;
  /** Lazy prune cadence. Default 1 hour. */
  pruneEveryMs?: number;
  /** Entries unused for this long are pruned. Default 30 days. */
  pruneAfterMs?: number;
}

type CacheLookup =
  | { state: 'hit'; entry: MirrorMediaCacheEntry }
  | { state: 'expired' }
  | { state: 'miss' };

/** What one transfer needs; `obtain` re-opens the source for the single
 *  re-download. */
interface Transfer {
  /** Cache key (and first upload key). */
  baseKey: string;
  uploadKey: string;
  filename: string | undefined;
  contractType: MirrorMediaContractType;
  signal: AbortSignal;
  obtain: (
    attempt: number,
  ) => Promise<MirrorSourceResult<DownloadedMirrorFile>>;
}

const retry = (
  cause: Extract<ResolveMediaOutcome, { kind: 'retry' }>['cause'],
  retryAfterSeconds: number | null = null,
): ResolveMediaOutcome => ({ kind: 'retry', cause, retryAfterSeconds });

const fromSourceFailure = (
  failure: MirrorSourceFailure,
): ResolveMediaOutcome =>
  failure.kind === 'retry' ? retry(failure.cause) : failure;

/**
 * Turns the `media` of a MESSAGE_MIRROR payload into a backend `mediaId`
 * (spec S1/S3/S4/S5), or into a decision the delivery adapter maps. Never
 * throws; never carries a phone or a conversation ref.
 *
 * Performance (S1): a persistent `idempotencyKey → mediaId` cache is consulted
 * before any download (a product photo sent to many customers is uploaded
 * once); concurrent resolves of one media share a transfer; at most
 * `maxConcurrency` transfers run at once; files stream through a 0600 temp
 * file that is always removed.
 */
export class MirrorMediaService {
  private readonly logger = new Logger(MirrorMediaService.name);
  private readonly semaphore: AsyncSemaphore;
  private readonly clock: () => Date;
  private readonly cacheMaxAgeMs: number;
  private readonly touchAfterMs: number;
  private readonly linkVersionTtlMs: number;
  private readonly pruneEveryMs: number;
  private readonly pruneAfterMs: number;
  private readonly inflight = new Map<string, Promise<ResolveMediaOutcome>>();
  private readonly linkVersions = new Map<
    string,
    { version: string | null; expiresAt: number }
  >();
  private lastPruneAt = 0;
  private static readonly MAX_LINK_VERSIONS = 500;

  constructor(private readonly deps: MirrorMediaServiceDeps) {
    this.semaphore = new AsyncSemaphore(deps.maxConcurrency ?? 2);
    this.clock = deps.clock ?? (() => new Date());
    this.cacheMaxAgeMs = deps.cacheMaxAgeMs ?? 180 * DAY_MS;
    this.touchAfterMs = deps.touchAfterMs ?? DAY_MS;
    this.linkVersionTtlMs = deps.linkVersionTtlMs ?? 10 * 60 * 1000;
    this.pruneEveryMs = deps.pruneEveryMs ?? 60 * 60 * 1000;
    this.pruneAfterMs = deps.pruneAfterMs ?? 30 * DAY_MS;
  }

  /**
   * `media` is the payload's `media` object (IN: `providerMediaId` [+
   * `mimeType`, `filename`]; OUT: `link`). `force` re-downloads and re-uploads
   * under a fresh key (a cached id the backend reported `MEDIA_NOT_FOUND`).
   */
  async resolveMedia(
    media: unknown,
    contractType: MirrorMediaContractType,
    options: ResolveMediaOptions = {},
  ): Promise<ResolveMediaOutcome> {
    const source = parseMedia(media);
    if (source === null || !CONTRACT_TYPES.includes(contractType))
      return { kind: 'park', reason: 'invalid_payload' };
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) return retry('aborted');
    const force = options.force === true;
    const flightKey = `${force ? 'force' : 'plain'}:${contractType}:${
      source.kind === 'meta'
        ? `meta:${source.providerMediaId}`
        : `link:${source.link}`
    }`;
    const existing = this.inflight.get(flightKey);
    if (existing !== undefined) return existing;
    const run = (
      source.kind === 'meta'
        ? this.resolveMeta(source, contractType, force, signal)
        : this.resolveLink(source.link, contractType, force, signal)
    )
      .catch((): ResolveMediaOutcome => {
        // Never a raw error (it could name a media id or a path).
        this.logger.warn('mirror media resolution failed unexpectedly');
        return { kind: 'park', reason: 'unexpected_response' };
      })
      .finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, run);
    return run;
  }

  /** Drops a cached id by its lookup key (and the link versions pointing to
   *  it); `true` when an entry existed. */
  async forget(idempotencyKey: string): Promise<boolean> {
    for (const [url, known] of this.linkVersions)
      if (keyFor(url, known.version) === idempotencyKey)
        this.linkVersions.delete(url);
    try {
      return await this.deps.cache.forget(idempotencyKey);
    } catch {
      this.logger.warn('mirror media cache forget failed');
      return false;
    }
  }

  /** Removes entries unused for `pruneAfterMs`; 0 when the store fails. */
  async pruneStale(): Promise<number> {
    try {
      return await this.deps.cache.pruneUnusedBefore(
        new Date(this.clock().getTime() - this.pruneAfterMs),
      );
    } catch {
      this.logger.warn('mirror media cache prune failed');
      return 0;
    }
  }

  // --------------------------------------------------------------- sources

  private async resolveMeta(
    source: { providerMediaId: string; mimeType?: string; filename?: string },
    contractType: MirrorMediaContractType,
    force: boolean,
    signal: AbortSignal,
  ): Promise<ResolveMediaOutcome> {
    // A declared type the backend never stores (a video) costs no request.
    if (
      source.mimeType !== undefined &&
      source.mimeType.trim() !== '' &&
      canonicalMirrorMime(source.mimeType) === undefined
    )
      return { kind: 'unsupported', reason: 'type_not_allowed' };
    const baseKey = mediaIdempotencyKey(source.providerMediaId);
    let rotate = force;
    if (!force) {
      const cached = await this.lookup(baseKey);
      if (cached.state === 'hit')
        return this.fromCache(cached.entry, contractType);
      rotate = cached.state === 'expired';
    }
    return this.withPermit(signal, () =>
      this.transfer({
        baseKey,
        uploadKey: rotate
          ? this.rotatedKey(source.providerMediaId, undefined)
          : baseKey,
        filename: source.filename,
        contractType,
        signal,
        obtain: () =>
          this.deps.meta.download({
            providerMediaId: source.providerMediaId,
            signal,
          }),
      }),
    );
  }

  private async resolveLink(
    url: string,
    contractType: MirrorMediaContractType,
    force: boolean,
    signal: AbortSignal,
  ): Promise<ResolveMediaOutcome> {
    if (!force) {
      // Within the memo window the host is not asked again: a photo sent to
      // many customers costs one fetch and one upload.
      const known = this.linkVersions.get(url);
      if (known !== undefined && known.expiresAt > this.clock().getTime()) {
        const cached = await this.lookup(keyFor(url, known.version));
        if (cached.state === 'hit')
          return this.fromCache(cached.entry, contractType);
      }
    }
    return this.withPermit(signal, async () => {
      const opened = await this.deps.links.open({ url, signal });
      if (opened.kind !== 'ok') return fromSourceFailure(opened);
      let link = opened.value;
      const version = link.version;
      this.rememberVersion(url, version);
      const baseKey = keyFor(url, version);
      let rotate = force;
      if (!force) {
        const cached = await this.lookup(baseKey);
        if (cached.state === 'hit') {
          link.discard();
          return this.fromCache(cached.entry, contractType);
        }
        rotate = cached.state === 'expired';
      }
      return this.transfer({
        baseKey,
        uploadKey: rotate ? this.rotatedKey(url, version) : baseKey,
        filename: undefined,
        contractType,
        signal,
        obtain: async (attempt) => {
          if (attempt > 0) {
            const reopened = await this.deps.links.open({ url, signal });
            if (reopened.kind !== 'ok') return reopened;
            link = reopened.value;
          }
          return link.download();
        },
      });
    });
  }

  // -------------------------------------------------------------- transfer

  /** One permit covers download + upload (the bound is on transfers). */
  private async withPermit(
    signal: AbortSignal,
    task: () => Promise<ResolveMediaOutcome>,
  ): Promise<ResolveMediaOutcome> {
    return this.semaphore.run(async () => {
      if (signal.aborted) return retry('aborted');
      try {
        return await task();
      } finally {
        this.pruneLazily();
      }
    });
  }

  /** Downloads and uploads one file; a sha256 mismatch or a local source error
   *  re-downloads once (the bytes may have changed), then parks. */
  private async transfer(transfer: Transfer): Promise<ResolveMediaOutcome> {
    let lastReason: 'sha_mismatch' | 'local_source_error' = 'sha_mismatch';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const source = await transfer.obtain(attempt);
      if (source.kind !== 'ok') return fromSourceFailure(source);
      const file = source.value;
      try {
        if (!mirrorMimeFitsType(file.mimeType, transfer.contractType))
          return { kind: 'unsupported', reason: 'type_mismatch' };
        const result = await this.deps.client.uploadMedia({
          filePath: file.filePath,
          sha256: file.sha256Hex,
          filename: transfer.filename,
          idempotencyKey: transfer.uploadKey,
          signal: transfer.signal,
        });
        const decision = mapUpload(result);
        if (decision.kind === 'redownload') {
          lastReason = decision.reason;
          continue;
        }
        if (decision.kind === 'outcome') return decision.outcome;
        await this.remember(transfer.baseKey, decision.uploaded);
        return {
          kind: 'ok',
          mediaId: decision.uploaded.mediaId,
          mimeType: decision.uploaded.mimeType,
          sizeBytes: decision.uploaded.sizeBytes,
          from: 'upload',
        };
      } finally {
        // Always: success, every failure, and an unexpected throw.
        await file.cleanup().catch(() => undefined);
      }
    }
    return { kind: 'park', reason: lastReason };
  }

  // ----------------------------------------------------------------- cache

  private async lookup(key: string): Promise<CacheLookup> {
    try {
      const entry = await this.deps.cache.get(key);
      if (entry === null) return { state: 'miss' };
      const now = this.clock().getTime();
      if (now - entry.createdAt.getTime() > this.cacheMaxAgeMs)
        return { state: 'expired' };
      if (now - entry.lastUsedAt.getTime() > this.touchAfterMs)
        void this.deps.cache.touch(key).catch(() => undefined);
      return { state: 'hit', entry };
    } catch {
      this.logger.warn('mirror media cache read failed');
      return { state: 'miss' };
    }
  }

  private fromCache(
    entry: MirrorMediaCacheEntry,
    contractType: MirrorMediaContractType,
  ): ResolveMediaOutcome {
    if (!mirrorMimeFitsType(entry.mimeType, contractType))
      return { kind: 'unsupported', reason: 'type_mismatch' };
    return {
      kind: 'ok',
      mediaId: entry.mediaId,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      from: 'cache',
    };
  }

  private async remember(
    key: string,
    uploaded: { mediaId: string; mimeType: string; sizeBytes: number },
  ): Promise<void> {
    try {
      await this.deps.cache.put({
        idempotencyKey: key,
        mediaId: uploaded.mediaId,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
      });
    } catch {
      this.logger.warn('mirror media cache write failed');
    }
  }

  private rememberVersion(url: string, version: string | null): void {
    this.linkVersions.delete(url);
    this.linkVersions.set(url, {
      version,
      expiresAt: this.clock().getTime() + this.linkVersionTtlMs,
    });
    if (this.linkVersions.size > MirrorMediaService.MAX_LINK_VERSIONS) {
      const oldest = this.linkVersions.keys().next();
      if (oldest.done !== true) this.linkVersions.delete(oldest.value);
    }
  }

  /** A fresh key for a forced/expired refresh: the backend may answer a replay
   *  of the old key with the media it already purged. */
  private rotatedKey(
    source: string,
    version: string | undefined | null,
  ): string {
    return mediaIdempotencyKey(
      source,
      `${version ?? ''}\u0001refresh:${this.clock().getTime()}`,
    );
  }

  private pruneLazily(): void {
    const now = this.clock().getTime();
    if (now - this.lastPruneAt < this.pruneEveryMs) return;
    this.lastPruneAt = now;
    void this.pruneStale();
  }
}

// --------------------------------------------------------------- helpers

type ParsedMedia =
  | {
      kind: 'meta';
      providerMediaId: string;
      mimeType?: string;
      filename?: string;
    }
  | { kind: 'link'; link: string };

function parseMedia(media: unknown): ParsedMedia | null {
  if (typeof media !== 'object' || media === null) return null;
  const { providerMediaId, link, mimeType, filename } = media as Record<
    string,
    unknown
  >;
  if (typeof providerMediaId === 'string' && providerMediaId.trim() !== '')
    return {
      kind: 'meta',
      providerMediaId,
      mimeType: typeof mimeType === 'string' ? mimeType : undefined,
      filename: typeof filename === 'string' ? filename : undefined,
    };
  if (typeof link === 'string' && link.trim() !== '')
    return { kind: 'link', link };
  return null;
}

function keyFor(url: string, version: string | null): string {
  return version === null
    ? mediaIdempotencyKey(url)
    : mediaIdempotencyKey(url, version);
}

type UploadDecision =
  | {
      kind: 'success';
      uploaded: { mediaId: string; mimeType: string; sizeBytes: number };
    }
  | { kind: 'outcome'; outcome: ResolveMediaOutcome }
  | { kind: 'redownload'; reason: 'sha_mismatch' | 'local_source_error' };

/** The S4 media reactions. */
function mapUpload(result: UploadMediaResult): UploadDecision {
  const outcome = (value: ResolveMediaOutcome): UploadDecision => ({
    kind: 'outcome',
    outcome: value,
  });
  switch (result.kind) {
    case 'ok':
      return { kind: 'success', uploaded: result };
    case 'MEDIA_TOO_LARGE':
      return outcome({ kind: 'unsupported', reason: 'too_large' });
    case 'MEDIA_TYPE_NOT_ALLOWED':
      return outcome({ kind: 'unsupported', reason: 'type_not_allowed' });
    case 'MEDIA_STORAGE_FAILED':
      return outcome(retry('storage_failed', result.retryAfterSeconds));
    case 'RATE_LIMITED':
      return outcome(retry('rate_limited', result.retryAfterSeconds));
    case 'RETRYABLE':
      return outcome(retry('backend_unavailable', result.retryAfterSeconds));
    case 'ABORTED':
      return outcome(retry('aborted'));
    case 'UNAUTHORIZED':
      return outcome({ kind: 'stop', reason: 'backend_unauthorized' });
    case 'FORBIDDEN':
      return outcome({ kind: 'stop', reason: 'backend_forbidden' });
    case 'IDEMPOTENCY_CONFLICT':
      return outcome({ kind: 'park', reason: 'idempotency_conflict' });
    case 'VALIDATION_ERROR':
      // A sha256 we sent that the backend rejects means the bytes changed.
      return result.shaSent && !result.local
        ? { kind: 'redownload', reason: 'sha_mismatch' }
        : outcome({ kind: 'park', reason: 'validation' });
    case 'LOCAL_SOURCE_ERROR':
      return { kind: 'redownload', reason: 'local_source_error' };
    case 'BODY_TOO_LARGE':
    case 'UNEXPECTED':
      return outcome({ kind: 'park', reason: 'unexpected_response' });
  }
}

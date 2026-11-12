/**
 * Media for the conversation mirror (backend unit 9, spec S1/S3/S4/S5): turns
 * the `media` of a MESSAGE_MIRROR payload into a backend `mediaId`, or into a
 * decision the delivery adapter maps (mirror UNSUPPORTED, retry, park, stop).
 *
 * Nothing here carries a phone or a `conversationRef` (S6): outcomes hold
 * fixed reasons, ids and counters only.
 */

/** The contract `type` of the message the media belongs to. */
export type MirrorMediaContractType =
  | 'IMAGE'
  | 'STICKER'
  | 'DOCUMENT'
  | 'AUDIO';

/** `MESSAGE_MIRROR` payload `media`: IN carries `providerMediaId` (+ mime and
 *  optional filename), OUT product photos carry a public HTTPS `link`. */
export interface MirrorPayloadMedia {
  providerMediaId?: string;
  mimeType?: string;
  filename?: string;
  link?: string;
}

/** Why the media is mirrored as an UNSUPPORTED message (no retry). */
export type MirrorUnsupportedReason =
  /** Over 10 MiB (local cap or backend 413). For audio the customer is also
   *  asked to write (S7, the adapter decides). */
  | 'too_large'
  /** Not a type the backend stores (video, gif, …) or a bad declared size. */
  | 'type_not_allowed'
  /** The bytes do not fit the message type (e.g. a PDF sent as IMAGE). */
  | 'type_mismatch'
  /** Expired or deleted at the source (Meta 404/410, a dead link). */
  | 'media_unavailable';

/** A transient problem: leave the row queued and try again later. */
export type MirrorMediaRetryCause =
  | 'source_transient'
  | 'storage_failed'
  | 'rate_limited'
  | 'backend_unavailable'
  | 'local_io'
  | 'aborted';

/** A problem that retrying will not fix: park the row and alert. */
export type MirrorMediaParkReason =
  | 'invalid_payload'
  | 'idempotency_conflict'
  | 'sha_mismatch'
  | 'local_source_error'
  | 'validation'
  | 'unexpected_response';

/** Credential / token problems: stop and alert, do not kill rows. */
export type MirrorMediaStopReason =
  | 'backend_unauthorized'
  | 'backend_forbidden'
  | 'source_unauthorized';

export type ResolveMediaOutcome =
  | {
      kind: 'ok';
      mediaId: string;
      mimeType: string;
      sizeBytes: number;
      /** `cache`: no download, no upload happened. */
      from: 'cache' | 'upload';
    }
  | { kind: 'unsupported'; reason: MirrorUnsupportedReason }
  | {
      kind: 'retry';
      cause: MirrorMediaRetryCause;
      /** Seconds the backend asked to wait (429 / 503), else null. */
      retryAfterSeconds: number | null;
    }
  | { kind: 'park'; reason: MirrorMediaParkReason }
  | { kind: 'stop'; reason: MirrorMediaStopReason };

export interface ResolveMediaOptions {
  /** Skip the cache, re-download and re-upload under a fresh idempotency key
   *  (a cached id the backend reported `MEDIA_NOT_FOUND`). */
  force?: boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- sources

/** A downloaded, sniffed temp file (mode 0600, ≤ 10 MiB). The owner must call
 *  `cleanup` on every path. */
export interface DownloadedMirrorFile {
  filePath: string;
  /** Canonical mime decided by the bytes. */
  mimeType: string;
  byteCount: number;
  sha256Hex: string;
  cleanup(): Promise<void>;
}

/** A source failure already mapped to what the service reacts to. */
export type MirrorSourceFailure =
  | { kind: 'unsupported'; reason: MirrorUnsupportedReason }
  | { kind: 'retry'; cause: MirrorMediaRetryCause }
  | { kind: 'stop'; reason: MirrorMediaStopReason }
  | { kind: 'park'; reason: MirrorMediaParkReason };

export type MirrorSourceResult<T> =
  | { kind: 'ok'; value: T }
  | MirrorSourceFailure;

export const MIRROR_META_DOWNLOADER = Symbol('MIRROR_META_DOWNLOADER');
export const MIRROR_LINK_FETCHER = Symbol('MIRROR_LINK_FETCHER');

/** IN: download a Meta media id (wider contract type set). */
export interface MirrorMetaDownloader {
  download(input: {
    providerMediaId: string;
    signal: AbortSignal;
  }): Promise<MirrorSourceResult<DownloadedMirrorFile>>;
}

/** An opened (headers received, body unread) public link. */
export interface OpenedMirrorLink {
  /** ETag, else Last-Modified, else null: the version of the bytes (S5 #1). */
  version: string | null;
  /** Reads the body into a validated temp file (bounded, sniffed, hashed). */
  download(): Promise<MirrorSourceResult<DownloadedMirrorFile>>;
  /** Drops the unread body (cache hit): idempotent. */
  discard(): void;
}

/** OUT: open a public HTTPS link with the outbound-fetch safety applied. */
export interface MirrorLinkFetcher {
  open(input: {
    url: string;
    signal: AbortSignal;
  }): Promise<MirrorSourceResult<OpenedMirrorLink>>;
}

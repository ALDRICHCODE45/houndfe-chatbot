/** WU8A ingestion processor — A1 RESERVED pass + A2a DOWNLOADED reconstruction
 * and storage pass: fenced pre-call CAS gates every external call (null blocks). */
import { createReadStream } from 'node:fs';
import {
  MetaMediaError,
  type MetaMediaPort,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import {
  ObjectStorageError,
  type ObjectStoragePort,
} from '../domain/object-storage.port';
import {
  STORAGE_EXHAUSTED_CODE,
  type MetaTerminalFailureStage,
  type ReceiptMediaStorePort,
} from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { CapabilityService } from './capability.service';

export type ReceiptIngestionOutcome =
  | { kind: 'downloaded' }
  | { kind: 'uploaded'; version: string }
  | { kind: 'stored' }
  | { kind: 'cleanup-failed' }
  | { kind: 'aborted'; stage: 'meta' | 'storage' }
  | { kind: 'blocked'; stage: 'meta' | 'storage' }
  | { kind: 'fence-lost'; stage: 'download' | 'tx2' }
  | { kind: 'meta-retry-scheduled'; attempt: number; code: string }
  | {
      kind: 'meta-terminal';
      failureStage: MetaTerminalFailureStage;
      code: string;
    }
  | { kind: 'meta-fenced'; code: string }
  | { kind: 'storage-retry-scheduled'; attempt: number; code: string }
  | {
      kind: 'storage-terminal';
      failureStage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE';
      code: string;
    }
  | { kind: 'storage-fenced'; code: string }
  | { kind: 'unsupported-claimed-status'; status: string };

const PROCESSABLE: ReadonlySet<string> = new Set(['RESERVED', 'DOWNLOADED']);

type StoredPassOutcome =
  | Exclude<ReceiptIngestionOutcome, { kind: 'uploaded' }>
  | {
      kind: 'uploaded';
      version: string;
      objectEtag: string;
      objectVersionId: string | null;
    };

export class ReceiptIngestionProcessor {
  constructor(
    private readonly meta: MetaMediaPort,
    private readonly storage: Pick<ObjectStoragePort, 'put'>,
    private readonly store: Pick<
      ReceiptMediaStorePort,
      | 'startMetaAttempt'
      | 'startStorageAttempt'
      | 'commitDownload'
      | 'bootstrapAmount'
      | 'commitMetaFailureDisposition'
      | 'commitStorageFailureDisposition'
    >,
    private readonly capability: Pick<CapabilityService, 'issue'>,
  ) {}

  async process(
    receipt: ReceiptMediaRow,
    owner: string,
    signal?: AbortSignal,
  ): Promise<ReceiptIngestionOutcome> {
    const abort = signal ?? new AbortController().signal;
    if (!PROCESSABLE.has(receipt.status) || receipt.declaredMimeType === null)
      return { kind: 'unsupported-claimed-status', status: receipt.status };
    if (abort.aborted) return { kind: 'aborted', stage: 'meta' };
    const fence = { id: receipt.id, owner, expectedVersion: receipt.version };
    if (receipt.status === 'DOWNLOADED' && receipt.storageAttempts >= 3) {
      const disposition = await this.store.commitStorageFailureDisposition({
        ...fence,
        category: 'OBJECT_STORAGE',
        code: STORAGE_EXHAUSTED_CODE,
      });
      return disposition.kind === 'terminal' || disposition.kind === 'replayed'
        ? {
            kind: 'storage-terminal',
            failureStage: disposition.failureStage,
            code: STORAGE_EXHAUSTED_CODE,
          }
        : { kind: 'storage-fenced', code: STORAGE_EXHAUSTED_CODE };
    }
    if (receipt.metaAttempts >= 3) {
      const disposition = await this.store.commitMetaFailureDisposition({
        ...fence,
        category: 'META_TRANSPORT',
        code: 'META_EXHAUSTED',
      });
      return disposition.kind === 'terminal' || disposition.kind === 'replayed'
        ? {
            kind: 'meta-terminal',
            failureStage: disposition.failureStage,
            code: 'META_EXHAUSTED',
          }
        : { kind: 'meta-fenced', code: 'META_EXHAUSTED' };
    }
    const start = await this.store.startMetaAttempt(fence);
    if (start === null) return { kind: 'blocked', stage: 'meta' };
    fence.expectedVersion = start.version;
    let file: ValidatedMediaFile;
    try {
      file = await this.meta.resolveAndDownload({
        providerMediaId: receipt.providerMediaId,
        declaredMimeType: receipt.declaredMimeType,
        signal: abort,
      });
    } catch (err) {
      if (!(err instanceof MetaMediaError)) throw err;
      const disposition = await this.store.commitMetaFailureDisposition({
        ...fence,
        category: err.category,
        code: err.code,
      });
      if (err.code === 'ABORTED') return { kind: 'aborted', stage: 'meta' };
      if (disposition.kind === 'terminal' || disposition.kind === 'replayed')
        return {
          kind: 'meta-terminal',
          failureStage: disposition.failureStage,
          code: err.code,
        };
      if (disposition.kind === 'retry-scheduled')
        return {
          kind: 'meta-retry-scheduled',
          attempt: disposition.attempt,
          code: err.code,
        };
      return { kind: 'meta-fenced', code: err.code };
    }
    if (receipt.status !== 'RESERVED') {
      const stored = await this.storedPass(
        fence,
        file,
        receipt.objectKey,
        abort,
      );
      if (stored.kind !== 'uploaded') return stored;
      const { tokenHash, keyVersion } = this.capability.issue(receipt.id);
      const bootstrapped = await this.store.bootstrapAmount({
        id: fence.id,
        owner: fence.owner,
        expectedVersion: stored.version,
        objectEtag: stored.objectEtag,
        objectVersionId: stored.objectVersionId,
        capabilityTokenHash: tokenHash,
        capabilityKeyVersion: keyVersion,
      });
      return bootstrapped.kind === 'fenced'
        ? { kind: 'fence-lost', stage: 'tx2' }
        : { kind: 'stored' };
    }
    try {
      await file.cleanup();
    } catch {
      return { kind: 'cleanup-failed' };
    }
    const moved = await this.store.commitDownload({
      ...fence,
      expectedVersion: start.version,
      responseMimeType: file.mimeType,
      detectedMimeType: file.mimeType,
      byteCount: file.byteCount,
      contentSha256: file.sha256,
    });
    return moved.kind === 'committed' || moved.kind === 'replayed'
      ? { kind: 'downloaded' }
      : { kind: 'fence-lost', stage: 'download' };
  }

  private async storedPass(
    fence: { id: string; owner: string; expectedVersion: string },
    file: ValidatedMediaFile,
    objectKey: string,
    signal: AbortSignal,
  ): Promise<StoredPassOutcome> {
    let done: StoredPassOutcome = { kind: 'blocked', stage: 'storage' };
    let thrown: Error | null = null;
    try {
      if (signal.aborted) {
        done = { kind: 'aborted', stage: 'storage' };
      } else {
        const start = await this.store.startStorageAttempt({
          id: fence.id,
          owner: fence.owner,
          expectedVersion: fence.expectedVersion,
        });
        if (start !== null) {
          fence.expectedVersion = start.version;
          const stream = createReadStream(file.filePath);
          const cleanupSignal = new AbortController().signal;
          try {
            const object = await this.storage.put({
              key: objectKey,
              content: stream,
              byteCount: file.byteCount,
              mimeType: file.mimeType,
              sha256: file.sha256,
              abortSignal: signal,
              cleanupSignal,
            });
            done = {
              kind: 'uploaded',
              version: start.version,
              objectEtag: object.etag,
              objectVersionId: object.versionId,
            };
          } catch (err) {
            stream.destroy();
            if (!(err instanceof ObjectStorageError)) throw err;
            const disposition =
              await this.store.commitStorageFailureDisposition({
                id: fence.id,
                owner: fence.owner,
                expectedVersion: fence.expectedVersion,
                category: err.category,
                code: err.code,
              });
            if (err.code === 'ABORTED' && signal.aborted) {
              done = { kind: 'aborted', stage: 'storage' };
            } else if (
              disposition.kind === 'terminal' ||
              disposition.kind === 'replayed'
            ) {
              done = {
                kind: 'storage-terminal',
                failureStage: disposition.failureStage,
                code: err.code,
              };
            } else if (disposition.kind === 'retry-scheduled') {
              done = {
                kind: 'storage-retry-scheduled',
                attempt: disposition.attempt,
                code: err.code,
              };
            } else {
              done = { kind: 'storage-fenced', code: err.code };
            }
          }
        }
      }
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }
    try {
      await file.cleanup();
    } catch {
      return { kind: 'cleanup-failed' };
    }
    if (thrown !== null) throw thrown;
    return done;
  }
}

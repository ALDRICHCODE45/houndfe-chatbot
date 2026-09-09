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
import type { ReceiptMediaStorePort } from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import {
  ReceiptOutboxService,
  type ReceiptTx2CommitPort,
} from './receipt-outbox.service';

export type ReceiptIngestionOutcome =
  | { kind: 'downloaded' }
  | { kind: 'uploaded'; version: string }
  | { kind: 'stored' }
  | { kind: 'cleanup-failed' }
  | { kind: 'aborted'; stage: 'meta' | 'storage' }
  | { kind: 'blocked'; stage: 'meta' | 'storage' }
  | { kind: 'fence-lost'; stage: 'download' | 'tx2' }
  | { kind: 'meta-failed'; code: string }
  | { kind: 'storage-failed'; code: string }
  | { kind: 'unsupported-claimed-status'; status: string };

const PROCESSABLE: ReadonlySet<string> = new Set(['RESERVED', 'DOWNLOADED']);

export class ReceiptIngestionProcessor {
  private readonly outbox: ReceiptOutboxService;

  constructor(
    private readonly meta: MetaMediaPort,
    private readonly storage: Pick<ObjectStoragePort, 'put'>,
    private readonly store: Pick<
      ReceiptMediaStorePort,
      'startMetaAttempt' | 'startStorageAttempt' | 'transitionStatus'
    >,
    private readonly tx2: ReceiptTx2CommitPort,
  ) {
    this.outbox = new ReceiptOutboxService(tx2);
  }

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
      if (err.code === 'ABORTED') return { kind: 'aborted', stage: 'meta' };
      return { kind: 'meta-failed', code: err.code };
    }
    if (receipt.status !== 'RESERVED') {
      const stored = await this.storedPass(
        fence,
        file,
        receipt.objectKey,
        abort,
      );
      if (stored.kind !== 'uploaded') return stored;
      const tx2 = await this.outbox.commit({
        transition: {
          id: fence.id,
          owner: fence.owner,
          expectedStatus: 'DOWNLOADED',
          expectedVersion: stored.version,
          nextStatus: 'STORED',
        },
        sourceWebhookMessageId: receipt.webhookMessageId,
        recipientId: receipt.senderId,
        templateKey: 'RECEIPT_AMOUNT_PROMPT',
      });
      return tx2.kind === 'committed'
        ? { kind: 'stored' }
        : { kind: 'fence-lost', stage: 'tx2' };
    }
    try {
      await file.cleanup();
    } catch {
      return { kind: 'cleanup-failed' };
    }
    const moved = await this.store.transitionStatus({
      ...fence,
      expectedVersion: start.version,
      expectedStatus: 'RESERVED',
      nextStatus: 'DOWNLOADED',
    });
    return moved
      ? { kind: 'downloaded' }
      : { kind: 'fence-lost', stage: 'download' };
  }

  private async storedPass(
    fence: { id: string; owner: string; expectedVersion: string },
    file: ValidatedMediaFile,
    objectKey: string,
    signal: AbortSignal,
  ): Promise<ReceiptIngestionOutcome> {
    let done: ReceiptIngestionOutcome = { kind: 'blocked', stage: 'storage' };
    let thrown: Error | null = null;
    try {
      for (;;) {
        if (signal.aborted) {
          done = { kind: 'aborted', stage: 'storage' };
          break;
        }
        const start = await this.store.startStorageAttempt({
          id: fence.id,
          owner: fence.owner,
          expectedVersion: fence.expectedVersion,
        });
        if (start === null) break;
        fence.expectedVersion = start.version;
        const stream = createReadStream(file.filePath);
        const cleanupSignal = new AbortController().signal;
        try {
          await this.storage.put({
            key: objectKey,
            content: stream,
            byteCount: file.byteCount,
            mimeType: file.mimeType,
            sha256: file.sha256,
            abortSignal: signal,
            cleanupSignal,
          });
          done = { kind: 'uploaded', version: start.version };
          break;
        } catch (err) {
          stream.destroy();
          if (!(err instanceof ObjectStorageError)) throw err;
          if (err.code === 'ABORTED' && signal.aborted) {
            done = { kind: 'aborted', stage: 'storage' };
            break;
          }
          if (!err.retryable) {
            done = { kind: 'storage-failed', code: err.code };
            break;
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

import { randomUUID } from 'node:crypto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ReceiptMediaStorePort } from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';

const DEFINITE_FAILURE_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);
const TRANSPORT_UNKNOWN = {
  httpStatus: null,
  transportCode: 'TRANSPORT_FAILURE',
} as const;

export type AttachReport =
  | { kind: 'skipped'; reason: 'fenced' | 'crashed-before-post' }
  | { kind: 'attached'; backendReceiptId: string }
  | { kind: 'definite-failure'; httpStatus: number }
  | {
      kind: 'outcome-unknown';
      httpStatus: number | null;
      transportCode: string | null;
    }
  | { kind: 'terminal-fenced' };

export interface ReceiptAttachmentConfig {
  receiptMedia: { publicBaseUrl: string };
}

export interface AttachInvocation {
  receipt: ReceiptMediaRow;
  owner: string;
  signal?: AbortSignal;
}

interface AttachFence {
  id: string;
  owner: string;
  expectedVersion: string;
  attachAttemptId: string;
}

interface UnknownEvidence {
  httpStatus: number | null;
  transportCode: string | null;
}

type StoreKeys =
  | 'startAttachRequest'
  | 'commitAttachSuccess'
  | 'commitAttachDefiniteFailure'
  | 'commitAttachUnknownOutcome';

/**
 * WU11C orchestration over the WU11A fenced store primitives and the WU11B
 * transport: one fresh attempt identity, at most one POST, exactly one
 * persisted terminal result, never an automatic retry or cleanup.
 */
export class ReceiptAttachmentService {
  constructor(
    private readonly store: Pick<ReceiptMediaStorePort, StoreKeys>,
    private readonly client: Pick<ChatbotApiClient, 'attachReceipt'>,
    private readonly config: ReceiptAttachmentConfig,
  ) {}

  async attach({
    receipt,
    owner,
    signal,
  }: AttachInvocation): Promise<AttachReport> {
    const attempt = { id: receipt.id, owner, attachAttemptId: randomUUID() };
    const started = await this.store.startAttachRequest({
      ...attempt,
      expectedVersion: receipt.version,
    });
    if (started.kind !== 'started') {
      return { kind: 'skipped', reason: started.kind };
    }
    // The durable locked successor is the only POST source after start.
    if (started.receipt.declaredAmountCents === null) {
      throw new Error('Receipt has no persisted declared amount');
    }
    const fence: AttachFence = { ...attempt, expectedVersion: started.version };
    let committing = false;
    try {
      const response = await this.client.attachReceipt(
        started.receipt.capturedSaleId,
        {
          mediaUrl: `${this.config.receiptMedia.publicBaseUrl}/${started.receipt.objectKey}`,
          declaredAmountCents: started.receipt.declaredAmountCents,
        },
        { signal },
      );
      if (
        typeof response?.receiptId === 'string' &&
        response.receiptId.length > 0 &&
        response?.status === 'PENDING'
      ) {
        committing = true;
        const outcome = await this.store.commitAttachSuccess({
          ...fence,
          backendReceiptId: response.receiptId,
        });
        return outcome.kind === 'fenced'
          ? { kind: 'terminal-fenced' }
          : { kind: 'attached', backendReceiptId: response.receiptId };
      }
      committing = true;
      return this.commitUnknown(fence, TRANSPORT_UNKNOWN);
    } catch (error) {
      if (committing) {
        throw error;
      }
      const status =
        (error as { statusCode?: number | null } | null)?.statusCode ?? null;
      if (signal?.aborted === true || (error as Error)?.name === 'AbortError') {
        committing = true;
        await this.commitUnknown(fence, TRANSPORT_UNKNOWN);
        throw error;
      }
      if (status !== null && DEFINITE_FAILURE_STATUSES.has(status)) {
        const outcome = await this.store.commitAttachDefiniteFailure({
          ...fence,
          httpStatus: status,
        });
        return outcome.kind === 'fenced'
          ? { kind: 'terminal-fenced' }
          : { kind: 'definite-failure', httpStatus: status };
      }
      committing = true;
      if (
        status !== null &&
        status >= 100 &&
        status <= 599 &&
        (status < 200 || status > 299)
      ) {
        return this.commitUnknown(fence, {
          httpStatus: status,
          transportCode: null,
        });
      }
      return this.commitUnknown(fence, TRANSPORT_UNKNOWN);
    }
  }

  private async commitUnknown(
    fence: AttachFence,
    evidence: UnknownEvidence,
  ): Promise<AttachReport> {
    const outcome = await this.store.commitAttachUnknownOutcome({
      ...fence,
      ...evidence,
    });
    return outcome.kind === 'fenced'
      ? { kind: 'terminal-fenced' }
      : { kind: 'outcome-unknown', ...evidence };
  }
}

import { randomUUID } from 'node:crypto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ReceiptMediaStorePort } from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { CapabilityService } from './capability.service';

const DEFINITE_FAILURE_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);
const TRANSPORT_UNKNOWN = {
  httpStatus: null,
  transportCode: 'TRANSPORT_FAILURE',
} as const;

/** Fixed, secret-free failure for persisted capability evidence that cannot
 *  be reconstructed: it carries no token, hash, version, or object key. */
const CAPABILITY_EVIDENCE_UNAVAILABLE =
  'Receipt capability evidence is unavailable';

export type AttachReport =
  | { kind: 'skipped'; reason: 'fenced' }
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
    private readonly capability: Pick<CapabilityService, 'reconstruct'>,
  ) {}

  async attach({
    receipt,
    owner,
    signal,
  }: AttachInvocation): Promise<AttachReport> {
    // ODD-5A: a FRESH row (no request-start evidence) must prove its immutable
    // persisted capability evidence BEFORE the request-start fence; a null
    // result fails closed before any durable mutation or POST, so no false
    // request-start evidence can appear. An already request-evidenced row is
    // owned by the store's recovery path: the historical capability key may
    // have rotated or the evidence may be malformed, and such a row must still
    // reach `startAttachRequest` so a reclaimed ATTACHING attempt can fix
    // forward. The token is only required to actually POST; the private object
    // key is never exposed.
    const requestEvidenced = receipt.attachRequestStartedAt !== null;
    let capability = requestEvidenced ? null : this.reconstructToken(receipt);
    if (capability === null && !requestEvidenced) {
      throw new Error(CAPABILITY_EVIDENCE_UNAVAILABLE);
    }
    const attempt = { id: receipt.id, owner, attachAttemptId: randomUUID() };
    const started = await this.store.startAttachRequest({
      ...attempt,
      expectedVersion: receipt.version,
    });
    if (started.kind === 'fenced') {
      return { kind: 'skipped', reason: 'fenced' };
    }
    if (started.kind === 'crashed-before-post') {
      // Request-start evidence already exists, so a POST would be a second
      // request. Fix the reclaimed ATTACHING row forward through its single
      // unknown terminal outcome using the durable attempt identity and
      // version, never the fresh caller values.
      const outcome = await this.store.commitAttachUnknownOutcome({
        id: receipt.id,
        owner,
        expectedVersion: started.version,
        attachAttemptId: started.attachAttemptId,
        ...TRANSPORT_UNKNOWN,
      });
      return outcome.kind === 'fenced'
        ? { kind: 'terminal-fenced' }
        : { kind: 'outcome-unknown', ...TRANSPORT_UNKNOWN };
    }
    // A request-evidenced caller should only ever reach recovery through the
    // crashed-before-post branch above; a `started` successor here is an
    // inconsistent durable load (the real store/version contract should
    // prevent it), so never POST without a reconstructed token.
    capability ??= this.reconstructToken(receipt);
    if (capability === null) {
      throw new Error(CAPABILITY_EVIDENCE_UNAVAILABLE);
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
          mediaUrl: `${this.config.receiptMedia.publicBaseUrl}/media/receipts/${capability}`,
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

  /** Rebuilds the public URL token from the loaded durable caller receipt;
   *  null when the persisted evidence cannot be reconstructed. */
  private reconstructToken(receipt: ReceiptMediaRow): string | null {
    return (
      this.capability.reconstruct(
        receipt.id,
        receipt.capabilityKeyVersion ?? '',
        receipt.capabilityTokenHash,
      )?.token ?? null
    );
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

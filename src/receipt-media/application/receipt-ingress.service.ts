/** WU7 receipt ingress admission service (RM1, WA2): TX1 is reservation-only.
 * Deterministic closed decisions (kill-switch disabled, unsupported media, no
 * placed sale) return without touching the store; a supported JPEG/PNG with a
 * captured `placedSaleId` builds an immutable reservation identity, reserves
 * exactly once, and maps the store's resolved outcome exhaustively (the
 * concrete WU2B store resolves only after its own transaction commits; this
 * unit layer makes no database-durability claim). There are
 * no application-level webhook/provider/sender identity pre-checks — the
 * store's transaction and unique-constraint arbitration is authoritative —
 * and reservation failures propagate with no downstream action. No outbox
 * intent exists before storage (WA2); worker wiring and DI tokens are WU14. */
import { randomUUID } from 'node:crypto';
import type { ConversationState } from '../../conversation/domain/conversation-store';
import { readPlacedSaleId } from '../../sale-flow/application/placed-sale-persistence';
import { newObjectKey } from '../domain/object-storage.port';
import type {
  ReservationOutcome,
  ReserveInput,
} from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';

/** Exact canonical receipt MIME values; no non-canonical alias is admitted. */
const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
]);

/** Narrow kill-switch seam over the WU1B `receiptMedia` config subtree. */
export interface ReceiptMediaKillSwitch {
  readonly enabled: boolean;
}

/** Narrow conversation seam: admission needs only the durable state read. */
export interface ReceiptIngressConversations {
  getState(senderId: string): Promise<ConversationState | null>;
}

/** Narrow reservation seam over the WU2B store port: reserve only. */
export interface ReceiptIngressStore {
  reserve(input: ReserveInput): Promise<ReservationOutcome>;
}

/** Normalized media envelope; identity pre-checks are store-owned. */
export interface ReceiptIngressInput {
  senderId: string;
  webhookMessageId: string;
  providerMediaId: string;
  declaredMimeType: string;
}

/** Closed admission result: the three pre-reservation decisions never create
 * a row; every `ReceiptMediaStorePort.reserve()` outcome maps 1:1, carrying
 * the persisted receipt exactly when the store returned one. */
export type ReceiptIngressDecision =
  | { kind: 'disabled' }
  | { kind: 'unsupported-media' }
  | { kind: 'no-placed-sale' }
  | { kind: 'reserved'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-replayed'; receipt: ReceiptMediaRow }
  | { kind: 'provider-media-reused'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-media-conflict' }
  | { kind: 'sender-active' };

export class ReceiptIngressService {
  constructor(
    private readonly killSwitch: ReceiptMediaKillSwitch,
    private readonly conversations: ReceiptIngressConversations,
    private readonly store: ReceiptIngressStore,
  ) {}

  /** TX1 admission: reservation-only. Unsupported media is gated before the
   * state read (media type is intrinsic to the message; sale context is
   * transient); no sale context reserves nothing. */
  async admit(input: ReceiptIngressInput): Promise<ReceiptIngressDecision> {
    if (!this.killSwitch.enabled) return { kind: 'disabled' };
    if (!SUPPORTED_MIME_TYPES.has(input.declaredMimeType))
      return { kind: 'unsupported-media' };
    const placedSaleId = readPlacedSaleId(
      await this.conversations.getState(input.senderId),
    );
    if (placedSaleId === null) return { kind: 'no-placed-sale' };
    const reservation = await this.store.reserve({
      id: randomUUID(),
      webhookMessageId: input.webhookMessageId,
      providerMediaId: input.providerMediaId,
      senderId: input.senderId,
      capturedSaleId: placedSaleId,
      objectKey: newObjectKey(),
      declaredMimeType: input.declaredMimeType,
    });
    switch (reservation.kind) {
      case 'created':
        return { kind: 'reserved', receipt: reservation.receipt };
      case 'webhook-replayed':
      case 'provider-media-reused':
        return { kind: reservation.kind, receipt: reservation.receipt };
      case 'webhook-media-conflict':
      case 'sender-active':
        return { kind: reservation.kind };
    }
  }
}

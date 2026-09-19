/** WU7 receipt ingress admission service (RM1, WA2): TX1 delegates one
 * atomic receipt admission to the durable store. Deterministic closed
 * decisions (kill-switch disabled, unsupported media, no
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
import { parseAmount } from '../domain/amount-parser';
import { newObjectKey } from '../domain/object-storage.port';
import type {
  ActiveReceiptStatus,
  ActiveSenderIdentity,
  ReservationOutcome,
  ReserveInput,
} from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';

/** Exact canonical receipt MIME values; no non-canonical alias is admitted. */
const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
]);

/** Largest declared amount the durable positive-int32 `declared_amount_cents`
 * column can hold (mirrors the store's own evidence bound). */
const MAX_DECLARED_AMOUNT_CENTS = 2_147_483_647;

/** ODD-4A CPU-only caption mapping: the raw caption is consumed here and
 * never leaves this frame. Only the parsed positive integer cent value within
 * the persistable range, or `null`, is produced. */
function declaredAmountCentsOf(caption: string | undefined): number | null {
  if (caption === undefined) return null;
  const parsed = parseAmount(caption);
  return parsed.kind === 'parsed' && parsed.cents <= MAX_DECLARED_AMOUNT_CENTS
    ? parsed.cents
    : null;
}

/** Narrow kill-switch seam over the WU1B `receiptMedia` config subtree. */
export interface ReceiptMediaKillSwitch {
  readonly enabled: boolean;
}

/** Narrow conversation seam: admission needs only the durable state read. */
export interface ReceiptIngressConversations {
  getState(senderId: string): Promise<ConversationState | null>;
}

/** Narrow receipt-admission seam over the store port: one atomic admission
 * plus the ODD-4C identity-aware durable active lookup. */
export interface ReceiptIngressStore {
  admit(input: ReserveInput): Promise<ReservationOutcome>;
  findActiveBySender(
    input: ActiveSenderIdentity,
  ): Promise<ActiveReceiptStatus | null>;
}

/** Normalized media envelope; identity pre-checks are store-owned. The
 * optional caption is transient: it is parsed CPU-only and only its bounded
 * declared amount ever reaches the store port. */
export interface ReceiptIngressInput {
  senderId: string;
  webhookMessageId: string;
  providerMediaId: string;
  declaredMimeType: string;
  caption?: string;
}

/** Closed admission result: the three pre-admission decisions never create
 * a row; every `ReceiptMediaStorePort.admit()` outcome maps 1:1, carrying
 * the persisted receipt exactly when the store returned one. */
export type ReceiptIngressDecision =
  | { kind: 'disabled' }
  | { kind: 'unsupported-media' }
  | { kind: 'no-placed-sale' }
  | { kind: 'reserved'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-replayed'; receipt: ReceiptMediaRow }
  | { kind: 'provider-media-reused'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-media-conflict' }
  | { kind: 'sender-active'; status: ActiveReceiptStatus };

export class ReceiptIngressService {
  constructor(
    private readonly killSwitch: ReceiptMediaKillSwitch,
    private readonly conversations: ReceiptIngressConversations,
    private readonly store: ReceiptIngressStore,
  ) {}

  /** TX1 admission: the store atomically persists the reservation and inbound
   * marker. Unsupported media is gated before the state read (media type is
   * intrinsic to the message; sale context is transient); no sale context
   * reserves nothing. ODD-4C: the active lookup precedes the placed-sale read. */
  async admit(input: ReceiptIngressInput): Promise<ReceiptIngressDecision> {
    if (!this.killSwitch.enabled) return { kind: 'disabled' };
    if (!SUPPORTED_MIME_TYPES.has(input.declaredMimeType))
      return { kind: 'unsupported-media' };
    const activeStatus = await this.store.findActiveBySender({
      senderId: input.senderId,
      webhookMessageId: input.webhookMessageId,
      providerMediaId: input.providerMediaId,
    });
    if (activeStatus !== null)
      return { kind: 'sender-active', status: activeStatus };
    const placedSaleId = readPlacedSaleId(
      await this.conversations.getState(input.senderId),
    );
    if (placedSaleId === null) return { kind: 'no-placed-sale' };
    const reservation = await this.store.admit({
      id: randomUUID(),
      webhookMessageId: input.webhookMessageId,
      providerMediaId: input.providerMediaId,
      senderId: input.senderId,
      capturedSaleId: placedSaleId,
      objectKey: newObjectKey(),
      declaredMimeType: input.declaredMimeType,
      declaredAmountCents: declaredAmountCentsOf(input.caption),
    });
    switch (reservation.kind) {
      case 'created':
        return { kind: 'reserved', receipt: reservation.receipt };
      case 'webhook-replayed':
      case 'provider-media-reused':
        return { kind: reservation.kind, receipt: reservation.receipt };
      case 'webhook-media-conflict':
        return { kind: reservation.kind };
      case 'sender-active':
        return { kind: 'sender-active', status: reservation.status };
    }
  }
}

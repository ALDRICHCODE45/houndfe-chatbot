/** WU10C3B receipt amount router (RM5, CS1, CS2): orchestration over the atomic
 * store contract at HEAD a4137c3. Amount → proposeAmount, affirmative →
 * startAttachment, negative → rejectProposedAmount, explicit cancel → status-free
 * cancelReceipt; the persisted ReceiptAmountPointer is the fence; every fenced
 * outcome is terminal and exact store `replayed` outcomes pass through unchanged;
 * no messaging, LLM, backend, Meta/S3, dispatcher, or module wiring dependency. */
import { isReceiptAmountPointer } from '../../conversation/domain/conversation-store';
import type {
  ConversationState,
  ReceiptAmountPointer,
} from '../../conversation/domain/conversation-store';
import { parseAmount } from '../domain/amount-parser';
import type {
  AmountProposalInput,
  AmountProposalOutcome,
  AmountRejectionInput,
  AmountRejectionOutcome,
  AttachStartInput,
  AttachStartOutcome,
  ReceiptCancellationInput,
  ReceiptCancellationOutcome,
} from '../domain/receipt-media-store.port';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../domain/receipt-media.types';

/** Narrow conversation seam: routing needs only the durable state read. */
export interface ReceiptAmountRouterConversations {
  get(senderId: string): Promise<ConversationState | null>;
}

/** Narrow store seam over the WU10C store port: the four amount operations. */
export interface ReceiptAmountRouterStore {
  proposeAmount(input: AmountProposalInput): Promise<AmountProposalOutcome>;
  rejectProposedAmount(
    input: AmountRejectionInput,
  ): Promise<AmountRejectionOutcome>;
  cancelReceipt(
    input: ReceiptCancellationInput,
  ): Promise<ReceiptCancellationOutcome>;
  startAttachment(input: AttachStartInput): Promise<AttachStartOutcome>;
}

/** One immutable inbound routing command; identity is propagated exactly. */
export interface ReceiptAmountRouteInput {
  senderId: string;
  sourceWebhookMessageId: string;
  text: string;
}

/** Merged outcome: every non-fenced store member carries the exact receipt
 * and intent; `replayed` is the store's own conservative replay for any of
 * the four operations; `fenced` is terminal (router- or store-originated). */
export type ReceiptAmountRouteOutcome =
  | {
      kind: 'proposed' | 'rejected' | 'cancelled' | 'started' | 'replayed';
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

const AFFIRMATIVE = new Set([
  'si',
  'confirmo',
  'confirmar',
  'ok',
  'dale',
  'va',
]);
const NEGATIVE = new Set(['no', 'rechazo', 'rechazar', 'otro', 'cambiar']);
const CANCEL = new Set(['cancel', 'cancela', 'cancelar', 'cancelo']);
const AMOUNT_VOCAB = new Set(['peso', 'pesos', 'con', 'centavo', 'centavos']);
type KeywordRoute = 'confirm' | 'reject' | 'cancel';

/** Pure classification. Precedence: explicit keyword intent outranks the amount
 * text; every letter token must resolve to one keyword class or Spanish amount
 * vocabulary, and any unknown word (even beside an amount) is ambiguous. A clean
 * single amount with no stray words routes the proposal. */
function planRoute(
  text: string,
): { op: 'propose'; cents: number } | { op: KeywordRoute } | null {
  const tokens = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  const routes = tokens.map((token) =>
    AFFIRMATIVE.has(token)
      ? 'confirm'
      : NEGATIVE.has(token)
        ? 'reject'
        : CANCEL.has(token)
          ? 'cancel'
          : AMOUNT_VOCAB.has(token)
            ? 'amount'
            : null,
  );
  if (routes.includes(null)) return null;
  const keyword = routes.find((r) => r !== 'amount');
  if (keyword === undefined || keyword === null) {
    const parsed = parseAmount(text);
    return parsed.kind === 'parsed'
      ? { op: 'propose', cents: parsed.cents }
      : null;
  }
  return routes.every((r) => r === keyword || r === 'amount')
    ? { op: keyword }
    : null;
}

export class ReceiptAmountRouterService {
  constructor(
    private readonly conversations: ReceiptAmountRouterConversations,
    private readonly store: ReceiptAmountRouterStore,
  ) {}

  /** Text first (pure, no I/O), then the pointer fence, then exactly one store
   * operation; sender, webhook id, and pointer triple propagate unchanged. */
  async route(
    input: ReceiptAmountRouteInput,
  ): Promise<ReceiptAmountRouteOutcome> {
    const identityValid =
      typeof input.senderId === 'string' &&
      input.senderId.length > 0 &&
      typeof input.sourceWebhookMessageId === 'string' &&
      input.sourceWebhookMessageId.length > 0;
    const plan = identityValid ? planRoute(input.text) : null;
    if (plan === null) return { kind: 'fenced' };
    const pointer = await this.readPointer(input.senderId);
    if (pointer === null) return { kind: 'fenced' };
    const shared = {
      sourceWebhookMessageId: input.sourceWebhookMessageId,
      senderId: input.senderId,
      receiptMediaId: pointer.receiptMediaId,
      capturedSaleId: pointer.saleId,
      expectedReceiptVersion: pointer.receiptVersion,
      expectedPointer: pointer,
    };
    const outcome = await (plan.op === 'propose'
      ? this.store.proposeAmount({
          ...shared,
          expectedReceiptStatus: 'AWAITING_AMOUNT' as const,
          cents: plan.cents,
        })
      : plan.op === 'confirm'
        ? this.store.startAttachment({
            ...shared,
            expectedReceiptStatus: 'AWAITING_CONFIRMATION' as const,
          })
        : plan.op === 'reject'
          ? this.store.rejectProposedAmount({
              ...shared,
              expectedReceiptStatus: 'AWAITING_CONFIRMATION' as const,
            })
          : this.store.cancelReceipt(shared));
    return outcome.kind === 'fenced' ? { kind: 'fenced' } : outcome;
  }

  private async readPointer(
    senderId: string,
  ): Promise<ReceiptAmountPointer | null> {
    const state: ConversationState | null =
      await this.conversations.get(senderId);
    const pointer = state?.data?.receiptAmountPointer;
    return isReceiptAmountPointer(pointer) ? pointer : null;
  }
}

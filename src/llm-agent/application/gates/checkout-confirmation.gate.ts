import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import type { MinimalCheckoutDraft } from '../../../conversation/domain/minimal-checkout-draft';
import {
  MinimalCheckoutConfirmation,
  type MinimalCheckoutBindingStatus,
  type MinimalCheckoutConsumeInput,
  type MinimalCheckoutConsumeResult,
  type MinimalCheckoutFinalizeInput,
  type MinimalCheckoutFinalizeResult,
  type MinimalCheckoutPrepareInput,
  type MinimalCheckoutPrepareResult,
} from '../../domain/minimal-checkout-confirmation';

/**
 * Lifetime of a durable local delivery confirmation. In memory it used to
 * last until the process stopped; durably it is bounded to WhatsApp's 24-hour
 * customer-service window. It only ever authorizes the exact draft content
 * the customer confirmed (`confirmedDraft` re-checks it on every read).
 */
export const MINIMAL_CHECKOUT_CONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;

const pendingSchema = z.strictObject({
  reference: z.uuid(),
  binding: z.string().min(2),
  revision: z.number().int().nonnegative(),
  receivingPhoneNumberId: z.string().min(1),
  originMessageId: z.string().min(1),
  armed: z.boolean(),
});
const confirmedSchema = z.strictObject({
  reference: z.uuid(),
  binding: z.string().min(2),
  revision: z.number().int().nonnegative(),
});

/**
 * S4 durable `checkout_confirmation` (pending offer, five minutes) and
 * `checkout_confirmed` (local confirmation) gates over the unchanged
 * `MinimalCheckoutConfirmation`. Finalizing spends the durable pending
 * atomically first, so two processes can never both confirm one offer.
 */
export class DurableCheckoutConfirmation {
  private readonly confirmation: MinimalCheckoutConfirmation;
  /** When each restored or new local confirmation stops being durable. */
  private readonly confirmedUntil = new Map<string, number>();

  constructor(private readonly gates: ConversationGates) {
    this.confirmation = new MinimalCheckoutConfirmation({ now: gates.now });
    gates.register({
      kind: 'checkout_confirmation',
      read: (senderId) => {
        const state = this.confirmation.exportPending(senderId);
        if (state === null) return null;
        const { expiresAt, ...payload } = state;
        return { payload, expiresAt };
      },
      write: (senderId, state) => {
        if (state === null)
          return this.confirmation.restorePending(senderId, null);
        const parsed = pendingSchema.safeParse(state.payload);
        if (!parsed.success) {
          this.confirmation.restorePending(senderId, null);
          return false;
        }
        return this.confirmation.restorePending(senderId, {
          ...parsed.data,
          expiresAt: state.expiresAt,
        });
      },
    });
    gates.register({
      kind: 'checkout_confirmed',
      read: (senderId) => {
        const state = this.confirmation.exportConfirmed(senderId);
        const expiresAt = this.confirmedUntil.get(senderId);
        if (state === null || expiresAt === undefined) return null;
        if (gates.now() >= expiresAt) {
          this.forgetConfirmed(senderId);
          return null;
        }
        return { payload: { ...state }, expiresAt };
      },
      write: (senderId, state) => {
        this.forgetConfirmed(senderId);
        if (state === null) return true;
        const parsed = confirmedSchema.safeParse(state.payload);
        if (!parsed.success) return false;
        this.confirmation.restoreConfirmed(senderId, parsed.data);
        this.confirmedUntil.set(senderId, state.expiresAt);
        return true;
      },
    });
  }

  status(senderId: string): MinimalCheckoutBindingStatus | null {
    this.expireConfirmed(senderId);
    return this.confirmation.status(senderId);
  }

  revokeConfirmation(senderId: string): void {
    this.forgetConfirmed(senderId);
    this.gates.touch(senderId);
  }

  confirmedDraft(
    senderId: string,
    rawDraft: unknown,
  ): MinimalCheckoutDraft | null {
    this.expireConfirmed(senderId);
    return this.confirmation.confirmedDraft(senderId, rawDraft);
  }

  prepare(input: MinimalCheckoutPrepareInput): MinimalCheckoutPrepareResult {
    const result = this.confirmation.prepare(input);
    if (typeof input.senderId === 'string') this.gates.touch(input.senderId);
    return result.kind === 'offer'
      ? { ...result, onSent: this.persisting(input.senderId, result.onSent) }
      : result;
  }

  consume(input: MinimalCheckoutConsumeInput): MinimalCheckoutConsumeResult {
    const result = this.confirmation.consume(input);
    if (typeof input.senderId === 'string') this.gates.touch(input.senderId);
    return result?.kind === 'reoffer'
      ? { ...result, onSent: this.persisting(input.senderId, result.onSent) }
      : result;
  }

  /**
   * Same outcome as the domain `finalize`, after atomically spending the
   * durable pending: a pending another process already finalized (or that
   * expired durably) finalizes as not confirmed.
   */
  async finalize(
    input: MinimalCheckoutFinalizeInput,
  ): Promise<MinimalCheckoutFinalizeResult> {
    const { senderId } = input;
    const reference = this.confirmation.status(senderId);
    const won =
      input.committed === true &&
      reference?.stage === 'pending' &&
      (await this.gates.claim(senderId, 'checkout_confirmation', {
        reference: reference.reference,
      }));
    const result = this.confirmation.finalize({ ...input, committed: won });
    if (result.kind === 'confirmed')
      this.confirmedUntil.set(
        senderId,
        this.gates.now() + MINIMAL_CHECKOUT_CONFIRMED_TTL_MS,
      );
    else this.confirmedUntil.delete(senderId);
    this.gates.touch(senderId);
    return result;
  }

  private expireConfirmed(senderId: string): void {
    const expiresAt = this.confirmedUntil.get(senderId);
    if (expiresAt !== undefined && this.gates.now() >= expiresAt)
      this.forgetConfirmed(senderId);
  }

  private forgetConfirmed(senderId: string): void {
    this.confirmation.revokeConfirmation(senderId);
    this.confirmedUntil.delete(senderId);
  }

  /** Arms in memory, then persists the arming. */
  private persisting(senderId: string, onSent: () => void): () => void {
    return () => {
      onSent();
      this.gates.touch(senderId);
    };
  }
}

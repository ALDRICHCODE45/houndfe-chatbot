import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import {
  checkHandoffSendHold,
  type HandoffModeReader,
} from '../../conversation/application/handoff-send-hold';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import type { CustomerInboundObservationStore } from '../domain/customer-inbound-observation-store.port';
import type { ExpirationApplicationLedgerPort } from '../domain/expiration-application-ledger.port';
import type { ExpirationApplicationLedgerRow } from '../domain/expiration-application-ledger-row';
import { classifyExpirationPreSend } from '../domain/expiration-pre-send-policy';
import { prepareExpirationReply } from '../domain/expiration-reply-preparation';
import type { PostgresExpirationApplicationClaimStore } from '../infrastructure/postgres-expiration-application-claim.store';
import type { ExpirationPreparationCandidate } from './expiration-preparation-candidate';

type AcceptedRow = Extract<
  ExpirationApplicationLedgerRow,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' }
>;
type Ports = Pick<CustomerInboundObservationStore, 'readLatest'> &
  Pick<PostgresExpirationApplicationClaimStore, 'claimPending'> &
  Pick<ExpirationApplicationLedgerPort, 'recordAcceptance'> &
  Pick<WhatsappSenderPort, 'sendText'> & {
    /** S1: the stored customer style; null/failure keeps the usted copy. */
    customerStyle?(senderId: string): Promise<CustomerStyle | null>;
  } & Partial<HandoffModeReader>;

export type ExpirationDeliveryResult =
  | Readonly<{ action: 'accepted'; row: AcceptedRow }>
  | Readonly<{ action: 'hold' }>;

const HOLD = Object.freeze({ action: 'hold' as const });

/** Dormant EXPIRATION send boundary: no runtime wiring, HTTP reporting or ACK.
 * `claimPending` revalidates the recorded context and ledger, then commits
 * SEND_STARTED, but is NOT send authority. Copy is prepared from the historical
 * projection BEFORE claiming, so unusable copy consumes no claim. After every
 * await the boundary re-reads the latest authenticated inbound and samples a
 * fresh caller clock for `classifyExpirationPreSend`. Exactly one send is
 * attempted; a throw or ambiguous result holds and is never retried, and a
 * successful send immediately records provider acceptance with the row's exact
 * attempt/token bytes and a fresh observation time. Acceptance is local
 * evidence, not device delivery; E4 owns backend reporting and ACK. */
export class ExpirationDeliveryService {
  constructor(
    private readonly ports: Ports,
    private readonly branchId: string,
    private readonly receivingPhoneNumberId: string,
    private readonly clock: () => Date,
  ) {}

  private async readStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }

  private handoffHold(senderId: string) {
    const { isHumanMode } = this.ports;
    return checkHandoffSendHold(
      isHumanMode === undefined
        ? undefined
        : { isHumanMode: (id) => isHumanMode.call(this.ports, id) },
      senderId,
    );
  }

  async deliverOnce(
    candidate: ExpirationPreparationCandidate,
  ): Promise<ExpirationDeliveryResult> {
    try {
      if (candidate.action !== 'candidate') return HOLD;
      const { reservation, backendDecisionId } = candidate.binding;
      const { decision } = candidate;
      // S1: read before the claim; a missing or failed read sends usted.
      const style = await this.readStyle(reservation.senderId);
      const copy = prepareExpirationReply(decision, style);
      if (copy.action !== 'prepared') return HOLD;
      // S7: no notice while the conversation is HUMAN (or the mode is
      // unreadable). Held BEFORE the claim, so the row stays PENDING and a
      // later sweep retries it; expiry is left to the stale path.
      if ((await this.handoffHold(reservation.senderId)).hold) return HOLD;
      const claimed = await this.ports.claimPending(candidate);
      if (claimed.action !== 'claimed') return HOLD;
      const row = claimed.row;
      if (
        row.senderId !== reservation.senderId ||
        row.sourceRequestId !== reservation.requestKey ||
        row.branchId !== this.branchId ||
        row.decisionId !== decision.id
      )
        return HOLD;
      const latest = await this.ports.readLatest(
        row.senderId,
        this.receivingPhoneNumberId,
      );
      if (latest.kind !== 'found') return HOLD;
      const now = Date.prototype.toISOString.call(this.clock());
      const policy = classifyExpirationPreSend({
        senderId: row.senderId,
        branchId: this.branchId,
        receivingPhoneNumberId: this.receivingPhoneNumberId,
        reservation,
        backendDecisionId,
        decision,
        latestInbound: latest.observation,
        now,
      });
      if (policy.action !== 'within_windows') return HOLD;
      const receipt = await this.ports.sendText({
        to: row.senderId,
        text: copy.text,
      });
      const providerAcceptedObservedAt = Date.prototype.toISOString.call(
        this.clock(),
      );
      const recorded = await this.ports.recordAcceptance({
        row,
        event: {
          kind: 'provider_accepted',
          attemptId: row.attemptId,
          sendToken: row.sendToken,
          providerMessageId: receipt.providerMessageId,
          providerAcceptedObservedAt,
        },
      });
      return recorded.action === 'updated'
        ? Object.freeze({ action: 'accepted' as const, row: recorded.row })
        : HOLD;
    } catch {
      return HOLD;
    }
  }
}

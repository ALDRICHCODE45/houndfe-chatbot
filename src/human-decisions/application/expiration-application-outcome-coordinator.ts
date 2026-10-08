import { isDeepStrictEqual } from 'node:util';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ExpirationApplicationLedgerPort } from '../domain/expiration-application-ledger.port';
import type { PostgresExpirationApplicationContextStore } from '../infrastructure/postgres-expiration-application-context.store';
import type { PostgresExpirationApplicationCompletionStore } from '../infrastructure/postgres-expiration-application-completion.store';
import { prepareExpirationApplicationOutcome } from '../domain/expiration-application-ledger-ack-preparation';
import { bindExpirationApplicationOutcomeAck } from '../domain/expiration-application-ledger-ack-binding';
import { prepareExpirationApplicationCompletion } from '../domain/expiration-application-completion-preparation';
import {
  validateExpirationOutcomeContext,
  type ExpirationOutcomeContext,
} from './expiration-outcome-context';

export type ExpirationApplicationOutcomePorts = Pick<
  PostgresExpirationApplicationContextStore,
  'readRecordedForSender'
> &
  Pick<
    ExpirationApplicationLedgerPort,
    'readOutcomeByDecision' | 'recordOutcomeAck'
  > &
  Pick<ChatbotApiClient, 'recordRestockApplicationOutcome'> &
  Pick<PostgresExpirationApplicationCompletionStore, 'closeAcknowledged'>;
type Result = Readonly<{ action: 'closed' | 'hold' }>;
const HOLD: Result = Object.freeze({ action: 'hold' });

/** Inactive terminal tail, never a sender, scheduler or automatic retry.
 * Requires trusted original candidate/remote provenance and contract-correct
 * ports: ledger observations use committed standalone Pool operations, not an
 * outer transaction client. STALE recovery trusts only controlled application
 * writers: the guarded PENDING-to-STALE store, not arbitrary ledger imports.
 * Snapshot checks are not remote atomicity; concurrent invocations may report
 * the same attempt. Each invocation reports at most once. Existing ACK skips
 * report/write; LATE may be recorded but never closes. A CAS result alone is not
 * COMMIT proof: the completion adapter must recheck durable evidence under its
 * own locks. Failure/uncertainty holds without implying rollback or retry. */
export class ExpirationApplicationOutcomeCoordinator {
  constructor(
    private readonly ports: ExpirationApplicationOutcomePorts,
    private readonly branchId: string,
  ) {}
  async finishOnce(
    candidate: ExpirationOutcomeContext,
    terminal: unknown,
  ): Promise<Result> {
    const ports = this.ports;
    try {
      const original = validateExpirationOutcomeContext(candidate, terminal);
      const outcome = prepareExpirationApplicationOutcome(terminal);
      if (!('binding' in original) || outcome.action !== 'prepared')
        return HOLD;
      const { branchId, ...context } = original.binding;
      const expected = outcome.expected;
      if (
        branchId !== this.branchId ||
        expected.branchId !== branchId ||
        expected.senderId !== context.reservation.senderId ||
        expected.sourceRequestId !== context.reservation.requestKey ||
        expected.decisionId !== original.decision.id ||
        expected.resolvedAt !== original.decision.resolution.resolvedAt ||
        expected.applyBefore !== original.decision.applyBefore
      )
        return HOLD;
      const current = await ports.readRecordedForSender(expected.senderId);
      if (
        current.action !== 'recorded' ||
        !isDeepStrictEqual(current.context, context)
      )
        return HOLD;
      const found = await ports.readOutcomeByDecision(expected.decisionId);
      if (
        found.action !== 'foundOutcome' ||
        !isDeepStrictEqual(found.row, expected)
      )
        return HOLD;
      let bound = bindExpirationApplicationOutcomeAck(expected, found.receipt);
      if (found.receipt === null) {
        const receipt = await ports.recordRestockApplicationOutcome(
          outcome.decisionId,
          outcome.request,
        );
        bound = bindExpirationApplicationOutcomeAck(expected, receipt);
        if (bound.action !== 'bound') return HOLD;
        const written = await ports.recordOutcomeAck(expected, bound.receipt);
        if (
          written.action !== 'updated' ||
          !isDeepStrictEqual(written.row, expected) ||
          !isDeepStrictEqual(written.receipt, bound.receipt)
        )
          return HOLD;
      }
      if (bound.action !== 'bound') return HOLD;
      const completion = prepareExpirationApplicationCompletion(
        expected,
        bound.receipt,
      );
      if (completion.action !== 'prepared') return HOLD;
      const result = await ports.closeAcknowledged(
        original,
        completion.expected,
        completion.receipt,
      );
      return result.action === 'closed'
        ? Object.freeze({ action: 'closed' })
        : HOLD;
    } catch {
      return HOLD;
    }
  }
}

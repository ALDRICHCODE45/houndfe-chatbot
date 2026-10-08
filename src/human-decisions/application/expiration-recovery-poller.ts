import type { PostgresExpirationRecoveryDiscoveryStore } from '../infrastructure/postgres-expiration-recovery-discovery.store';
import type { PostgresExpirationApplicationPreparationStore } from '../infrastructure/postgres-expiration-application-preparation.store';
import type { ExpirationApplicationLedgerPort } from '../domain/expiration-application-ledger.port';
import type { ExpirationExistingDecisionService } from './expiration-existing-decision.service';
import type { ExpirationDeliveryService } from './expiration-delivery.service';
import type { ExpirationApplicationOutcomeCoordinator } from './expiration-application-outcome-coordinator';
import { createExpirationPreparationCandidate } from './expiration-preparation-candidate';
import { classifyExpirationApplication } from '../domain/expiration-application-policy';
import type { PostgresExpirationApplicationStaleStore } from '../infrastructure/postgres-expiration-application-stale.store';

/** One inquiry per five seconds bounds backend GET load. Completed sweeps wrap
 * so pending decisions and new keys behind the cursor are revisited. Restart
 * begins a fresh database sweep, not a replay of a volatile job queue.
 * Preparation must report `prepared` before this loop offers the candidate to
 * the delivery boundary; that boundary still owns claim/send/acceptance, and
 * expired evidence is offered only to the guarded stale store, never to send.
 * A durable terminal read happens BEFORE
 * any prepare/send: an already accepted ledger row is routed to the outcome
 * coordinator for report/ACK/close without resending. STALE uses resolved
 * evidence, never a fabricated in-window candidate or send authority. `deliver` and the recovery pair are optional so a prep-only
 * composition stays compatible. */
export class ExpirationRecoveryPoller {
  private cursor: string | null = null;
  private started = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;

  constructor(
    private readonly discovery: Pick<
      PostgresExpirationRecoveryDiscoveryStore,
      'discoverRecordedHints'
    >,
    private readonly decisions: Pick<
      ExpirationExistingDecisionService,
      'readExistingDecision'
    >,
    private readonly preparation: Pick<
      PostgresExpirationApplicationPreparationStore,
      'preparePending'
    >,
    private readonly clock: () => Date = () => new Date(),
    private readonly delivery?: Pick<ExpirationDeliveryService, 'deliverOnce'>,
    private readonly outcomes?: Pick<
      ExpirationApplicationLedgerPort,
      'readOutcomeByDecision'
    >,
    private readonly coordinator?: Pick<
      ExpirationApplicationOutcomeCoordinator,
      'finishOnce'
    >,
    private readonly stale?: Pick<
      PostgresExpirationApplicationStaleStore,
      'expireResolvedOutcome'
    >,
  ) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return this.inFlight ?? Promise.resolve();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = Promise.resolve()
        .then(() => this.tick())
        .finally(() => {
          this.inFlight = undefined;
          this.schedule();
        });
    }, 5_000);
  }

  private async tick(): Promise<void> {
    try {
      if (this.stopped) return;
      const page = await this.discovery.discoverRecordedHints({
        limit: 1,
        afterRequestKey: this.cursor,
      });
      if (this.stopped || page.action !== 'page') return;
      this.cursor = page.nextCursor;
      for (const hint of page.hints) {
        if (this.stopped) return;
        const outcome = await this.decisions.readExistingDecision(
          hint.senderId,
        );
        if (
          this.stopped ||
          outcome.outcome !== 'resolved' ||
          outcome.binding.reservation.requestKey !== hint.requestKey
        )
          continue;
        if (this.outcomes && this.coordinator) {
          const terminal = await this.outcomes.readOutcomeByDecision(
            outcome.binding.backendDecisionId,
          );
          if (this.stopped) return;
          if (terminal.action === 'foundOutcome') {
            if (terminal.row.state === 'STALE') {
              await this.coordinator.finishOnce(outcome, terminal.row);
              continue;
            }
            const recovery = createExpirationPreparationCandidate(
              hint.senderId,
              outcome,
              terminal.row.attemptedAt,
            );
            if (recovery.action === 'candidate')
              await this.coordinator.finishOnce(recovery, terminal.row);
            continue;
          }
        }
        const checkedAt = this.clock().toISOString();
        if (this.stale) {
          const policy = classifyExpirationApplication({
            senderId: hint.senderId,
            branchId: outcome.binding.branchId,
            reservation: outcome.binding.reservation,
            backendDecisionId: outcome.binding.backendDecisionId,
            decision: outcome.decision,
            now: checkedAt,
          });
          if (policy.classification === 'expired') {
            // Only the store's fresh locked PENDING CAS establishes local
            // no-send evidence. No terminal reporting/closure in this path.
            await this.stale.expireResolvedOutcome(outcome);
            continue;
          }
        }
        const candidate = createExpirationPreparationCandidate(
          hint.senderId,
          outcome,
          checkedAt,
        );
        if (candidate.action === 'candidate') {
          const prepared = await this.preparation.preparePending(candidate);
          if (!this.stopped && prepared.action === 'prepared') {
            const delivered = await this.delivery?.deliverOnce(candidate);
            if (
              !this.stopped &&
              delivered?.action === 'accepted' &&
              this.coordinator
            )
              await this.coordinator.finishOnce(candidate, delivered.row);
          }
        }
      }
    } catch {
      // Retry discovery/GET on a later sweep. Never retry a provider send.
    }
  }
}

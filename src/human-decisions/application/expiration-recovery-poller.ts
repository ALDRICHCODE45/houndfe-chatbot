import type { PostgresExpirationRecoveryDiscoveryStore } from '../infrastructure/postgres-expiration-recovery-discovery.store';
import type { PostgresExpirationApplicationPreparationStore } from '../infrastructure/postgres-expiration-application-preparation.store';
import type { ExpirationExistingDecisionService } from './expiration-existing-decision.service';
import type { ExpirationDeliveryService } from './expiration-delivery.service';
import { createExpirationPreparationCandidate } from './expiration-preparation-candidate';

/** One inquiry per five seconds bounds backend GET load. Completed sweeps wrap
 * so pending decisions and new keys behind the cursor are revisited. Restart
 * begins a fresh database sweep, not a replay of a volatile job queue.
 * Preparation must report `prepared` before this loop offers the candidate to
 * the delivery boundary; that boundary still owns claim/send/acceptance, and
 * the loop never marks stale or ACKs. `deliver` is optional so a prep-only
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
        const candidate = createExpirationPreparationCandidate(
          hint.senderId,
          outcome,
          this.clock().toISOString(),
        );
        if (candidate.action === 'candidate') {
          const prepared = await this.preparation.preparePending(candidate);
          if (!this.stopped && prepared.action === 'prepared')
            await this.delivery?.deliverOnce(candidate);
        }
      }
    } catch {
      // Retry discovery/GET on a later sweep. Never retry a provider send.
    }
  }
}

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/postgres-pool.provider';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import {
  WHATSAPP_SENDER,
  type WhatsappSenderPort,
} from '../whatsapp/domain/whatsapp-sender.port';
import { RestockApplicationCandidateService } from './application/restock-application-candidate.service';
import { RestockApplicationCoordinator } from './application/restock-application-coordinator';
import { RestockApplicationPoller } from './application/restock-application-poller';
import { PostgresRestockApplicationContextStore } from './infrastructure/postgres-restock-application-context.store';
import { PostgresRestockApplicationPreparationStore } from './infrastructure/postgres-restock-application-preparation.store';
import { PostgresRestockApplicationClaimStore } from './infrastructure/postgres-restock-application-claim.store';
import { PostgresRestockApplicationLedgerStore } from './infrastructure/postgres-restock-application-ledger.store';
import { PostgresRestockApplicationCompletionStore } from './infrastructure/postgres-restock-application-completion.store';

/** Private module runtime. No scans/recovery; closes only after local ACK.
 * Configuration is latched at bootstrap; shutdown permanently closes admission.
 * Nest awaits the poller drain before closing the shared database pool. */
@Injectable()
export class RestockApplicationRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private bootstrapped = false;
  private stopped = false;
  private poller?: RestockApplicationPoller;
  private coordinator?: RestockApplicationCoordinator;
  private context?: PostgresRestockApplicationContextStore;
  private recovery?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CHATBOT_API_CLIENT) private readonly client: ChatbotApiClient,
    @Inject(WHATSAPP_SENDER) private readonly sender: WhatsappSenderPort,
  ) {}

  onApplicationBootstrap(): void {
    if (this.bootstrapped || this.stopped) return;
    this.bootstrapped = true;
    if (this.config.get('humanDecisions.restockEnabled') !== true) return;
    const branch = this.config.get<string>('chatbotApi.branchId');
    const phone = this.config.get<string>('meta.phoneNumberId');
    if (
      typeof branch !== 'string' ||
      !branch.trim() ||
      typeof phone !== 'string' ||
      !phone.trim()
    )
      throw new Error(
        'RESTOCK application requires branch and phone identities',
      );
    const clock = () => new Date();
    const context = new PostgresRestockApplicationContextStore(this.pool);
    const candidate = new RestockApplicationCandidateService(
      context,
      this.client,
      branch,
      clock,
    );
    const preparation = new PostgresRestockApplicationPreparationStore(
      this.pool,
      branch,
      clock,
    );
    const claim = new PostgresRestockApplicationClaimStore(
      this.pool,
      branch,
      phone,
      clock,
    );
    const ledger = new PostgresRestockApplicationLedgerStore(this.pool);
    const completion = new PostgresRestockApplicationCompletionStore(
      this.pool,
      branch,
    );
    const coordinator = new RestockApplicationCoordinator(
      {
        pollForSender: candidate.pollForSender.bind(candidate),
        preparePending: preparation.preparePending.bind(preparation),
        claimPending: claim.claimPending.bind(claim),
        recordAcceptance: ledger.recordAcceptance.bind(ledger),
        recordOutcomeAck: ledger.recordOutcomeAck.bind(ledger),
        readByDecision: ledger.readByDecision.bind(ledger),
        closeAcknowledged: completion.closeAcknowledged.bind(completion),
        recordRestockApplicationOutcome:
          this.client.recordRestockApplicationOutcome.bind(this.client),
        sendText: this.sender.sendText.bind(this.sender),
      },
      branch,
      phone,
      clock,
    );
    this.coordinator = coordinator;
    this.context = context;
    this.poller = new RestockApplicationPoller(coordinator);
    this.poller.start();
  }

  enqueue(senderId: string, sourceRequestId: string): boolean {
    return this.poller?.enqueue(senderId, sourceRequestId) ?? false;
  }

  /**
   * Bounded on-demand expired-only reconciliation for ONE sender. It reads
   * only that sender's trusted recorded context (never a scan) and delegates
   * the recorded request identity to the expiry coordinator.
   *
   * Returns `true` only when the old reservation was durably ACKed and closed.
   * Inert (no query) while disabled, before bootstrap or after shutdown; a
   * concurrent recovery is refused fail-closed. It never sends WhatsApp and
   * never runs a background scan.
   */
  async reconcileExpired(senderId: string): Promise<boolean> {
    if (!this.bootstrapped || this.stopped) return false;
    const coordinator = this.coordinator;
    const context = this.context;
    if (!coordinator || !context || this.recovery) return false;
    const run = (async (): Promise<boolean> => {
      try {
        const read = await context.readRecordedForSender(senderId);
        if (read.action !== 'recorded') return false;
        const result = await coordinator.reconcileExpiredOnce(
          senderId,
          read.context.reservation.requestKey,
        );
        return result.action === 'ack_recorded';
      } catch {
        return false;
      }
    })();
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    this.recovery = tracked;
    try {
      return await run;
    } finally {
      if (this.recovery === tracked) this.recovery = undefined;
    }
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return (this.stopping ??= this.drain());
  }

  /** Drain the poller and any in-flight recovery before the pool closes. */
  private async drain(): Promise<void> {
    const recovery = this.recovery;
    await (this.poller?.stop() ?? Promise.resolve());
    if (recovery) await recovery;
  }
}

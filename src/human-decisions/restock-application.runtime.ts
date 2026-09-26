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

/** Unregistered composition seam. No scans/recovery or reservation closure.
 * Configuration is latched at bootstrap; shutdown permanently closes admission.
 * Nest registration and drain-before-pool-close ordering require separate proof. */
@Injectable()
export class RestockApplicationRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private bootstrapped = false;
  private stopped = false;
  private poller?: RestockApplicationPoller;
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
    const candidate = new RestockApplicationCandidateService(
      new PostgresRestockApplicationContextStore(this.pool),
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
    const coordinator = new RestockApplicationCoordinator(
      {
        pollForSender: candidate.pollForSender.bind(candidate),
        preparePending: preparation.preparePending.bind(preparation),
        claimPending: claim.claimPending.bind(claim),
        recordAcceptance: ledger.recordAcceptance.bind(ledger),
        recordOutcomeAck: ledger.recordOutcomeAck.bind(ledger),
        recordRestockApplicationOutcome:
          this.client.recordRestockApplicationOutcome.bind(this.client),
        sendText: this.sender.sendText.bind(this.sender),
      },
      branch,
      phone,
      clock,
    );
    this.poller = new RestockApplicationPoller(coordinator);
    this.poller.start();
  }

  enqueue(senderId: string, sourceRequestId: string): boolean {
    return this.poller?.enqueue(senderId, sourceRequestId) ?? false;
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return (this.stopping ??= this.poller?.stop() ?? Promise.resolve());
  }
}

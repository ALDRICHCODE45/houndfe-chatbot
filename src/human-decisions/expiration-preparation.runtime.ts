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
import { ExpirationExistingDecisionService } from './application/expiration-existing-decision.service';
import { ExpirationRecoveryPoller } from './application/expiration-recovery-poller';
import { ExpirationDeliveryService } from './application/expiration-delivery.service';
import { PostgresExpirationApplicationContextStore } from './infrastructure/postgres-expiration-application-context.store';
import { PostgresExpirationApplicationPreparationStore } from './infrastructure/postgres-expiration-application-preparation.store';
import { PostgresExpirationApplicationClaimStore } from './infrastructure/postgres-expiration-application-claim.store';
import { PostgresExpirationApplicationLedgerStore } from './infrastructure/postgres-expiration-application-ledger.store';
import { PostgresCustomerInboundObservationStore } from './infrastructure/postgres-customer-inbound-observation.store';
import { PostgresExpirationRecoveryDiscoveryStore } from './infrastructure/postgres-expiration-recovery-discovery.store';

/** Default-off preparation/send runtime; capture and sending share Meta phone identity. */
@Injectable()
export class ExpirationPreparationRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private bootstrapped = false;
  private stopped = false;
  private poller?: ExpirationRecoveryPoller;

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CHATBOT_API_CLIENT) private readonly client: ChatbotApiClient,
    @Inject(WHATSAPP_SENDER) private readonly sender: WhatsappSenderPort,
  ) {}

  onApplicationBootstrap(): void {
    if (this.bootstrapped || this.stopped) return;
    this.bootstrapped = true;
    if (this.config.get('minimalCatalogAgent.expirationEnabled') !== true)
      return;
    const branch = this.config.get<string>('chatbotApi.branchId');
    const phone = this.config.get<string>('meta.phoneNumberId');
    if (typeof branch !== 'string' || !branch.trim()) {
      throw new Error('EXPIRATION preparation requires branch identity');
    }
    if (typeof phone !== 'string' || !phone.trim()) {
      throw new Error(
        'EXPIRATION runtime requires the Meta receiving phone identity',
      );
    }
    const clock = () => new Date();
    const claim = new PostgresExpirationApplicationClaimStore(
      this.pool,
      branch,
      clock,
    );
    const ledger = new PostgresExpirationApplicationLedgerStore(this.pool);
    const inbound = new PostgresCustomerInboundObservationStore(this.pool);
    const delivery = new ExpirationDeliveryService(
      {
        claimPending: claim.claimPending.bind(claim),
        readLatest: inbound.readLatest.bind(inbound),
        recordAcceptance: ledger.recordAcceptance.bind(ledger),
        sendText: this.sender.sendText.bind(this.sender),
      },
      branch,
      phone,
      clock,
    );
    this.poller = new ExpirationRecoveryPoller(
      new PostgresExpirationRecoveryDiscoveryStore(this.pool),
      new ExpirationExistingDecisionService(
        new PostgresExpirationApplicationContextStore(this.pool),
        this.client,
        branch,
      ),
      new PostgresExpirationApplicationPreparationStore(
        this.pool,
        branch,
        clock,
      ),
      clock,
      delivery,
    );
    this.poller.start();
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.poller?.stop() ?? Promise.resolve();
  }
}

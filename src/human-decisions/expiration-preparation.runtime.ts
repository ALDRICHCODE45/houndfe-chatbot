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
import { ExpirationExistingDecisionService } from './application/expiration-existing-decision.service';
import { ExpirationRecoveryPoller } from './application/expiration-recovery-poller';
import { PostgresExpirationApplicationContextStore } from './infrastructure/postgres-expiration-application-context.store';
import { PostgresExpirationApplicationPreparationStore } from './infrastructure/postgres-expiration-application-preparation.store';
import { PostgresExpirationRecoveryDiscoveryStore } from './infrastructure/postgres-expiration-recovery-discovery.store';

/** Default-off preparation only. No WhatsApp sender or outcome/ACK dependency. */
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
  ) {}

  onApplicationBootstrap(): void {
    if (this.bootstrapped || this.stopped) return;
    this.bootstrapped = true;
    if (this.config.get('minimalCatalogAgent.expirationEnabled') !== true)
      return;
    const branch = this.config.get<string>('chatbotApi.branchId');
    if (typeof branch !== 'string' || !branch.trim()) {
      throw new Error('EXPIRATION preparation requires branch identity');
    }
    const clock = () => new Date();
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
    );
    this.poller.start();
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.poller?.stop() ?? Promise.resolve();
  }
}

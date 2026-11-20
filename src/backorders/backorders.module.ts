import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { CustomerProfileService } from '../customer-profile/application/customer-profile.service';
import { CustomerProfileModule } from '../customer-profile/customer-profile.module';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { PostgresCustomerInboundObservationStore } from '../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import { BACKORDER_FEED_HANDLER } from '../human-requests/domain/backorder-feed';
import { readCustomerWindowOpen } from '../receipt-media/domain/receipt-outcome';
import { BackorderFeedRecovery } from './application/backorder-feed-recovery';
import { BackorderFeedNoticeService } from './application/backorder-feed.handler';
import {
  BACKORDER_CLIENT,
  BACKORDER_RECOVERY_CLIENT,
  type BackorderRecoveryClient,
} from './domain/backorder';
import { BackorderOfferRegistry } from './domain/backorder-offer';
import type { BackorderTemplateNames } from './domain/backorder-notices';
import { BackorderHttpClient } from './infrastructure/backorder-http.client';

/**
 * BackordersModule (restock backorder, T4 and T5a)
 *
 *   - `BACKORDER_CLIENT` → HTTP adapter of `/chatbot-api/backorders`, a port
 *     apart from `CHATBOT_API_CLIENT` (its fakes stay valid).
 *   - `BackorderOfferRegistry` → late-bound holder of the offer capability,
 *     registered by `LlmAgentModule` (which owns the customer turn and the
 *     conversation gates) and resolved at call time by the RESTOCK
 *     application coordinator of `HumanDecisionsModule`.
 *   - `BACKORDER_FEED_HANDLER` → the `backorder.*` feed notices (T5a),
 *     resolved by the delivery service of `HumanRequestsServicesModule`.
 *     `BACKORDER_TEMPLATES_ENABLED` (config `backorder.templatesEnabled`,
 *     exactly `true`) lets them go out as Meta templates outside the 24 h
 *     window.
 *   - `BackorderFeedRecovery` → the backorder position of the feed recovery
 *     after `410 CURSOR_EXPIRED`, used by `HumanRequestsModule`.
 */
@Module({
  imports: [ConfigModule, HttpModule, DatabaseModule, CustomerProfileModule],
  providers: [
    BackorderHttpClient,
    { provide: BACKORDER_CLIENT, useExisting: BackorderHttpClient },
    { provide: BACKORDER_RECOVERY_CLIENT, useExisting: BackorderHttpClient },
    BackorderOfferRegistry,
    {
      provide: BACKORDER_FEED_HANDLER,
      useFactory: (
        config: ConfigService,
        pool: Pool,
        profiles?: CustomerProfileService,
      ) => {
        const inbound = new PostgresCustomerInboundObservationStore(pool);
        const names = config.get<Partial<BackorderTemplateNames>>(
          'backorder.templateNames',
        );
        return new BackorderFeedNoticeService({
          // Same local 24 h window as every other notice; a failed read
          // rejects (the page is read again), never "closed".
          isWindowOpen: (senderId) => {
            const phone = config.get<string>('meta.phoneNumberId');
            if (typeof phone !== 'string' || !phone.trim())
              return Promise.reject(
                new Error('the Meta receiving phone identity is missing'),
              );
            return readCustomerWindowOpen(inbound, senderId, phone, new Date());
          },
          ...(profiles === undefined
            ? {}
            : { customerStyle: (id: string) => profiles.styleFor(id) }),
          templatesEnabled:
            config.get<unknown>('backorder.templatesEnabled') === true,
          ...(names === undefined ? {} : { templateNames: names }),
        });
      },
      inject: [
        ConfigService,
        PG_POOL,
        { token: CustomerProfileService, optional: true },
      ],
    },
    {
      provide: BackorderFeedRecovery,
      useFactory: (client: BackorderRecoveryClient) =>
        new BackorderFeedRecovery(client),
      inject: [BACKORDER_RECOVERY_CLIENT],
    },
  ],
  exports: [
    BACKORDER_CLIENT,
    BackorderOfferRegistry,
    BACKORDER_FEED_HANDLER,
    BackorderFeedRecovery,
  ],
})
export class BackordersModule {}

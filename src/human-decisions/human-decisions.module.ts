import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import { RestockApplicationRuntime } from './restock-application.runtime';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import {
  RESTOCK_INTAKE_SERVICE,
  RestockIntakeService,
} from './application/restock-intake.service';
import {
  RESTOCK_EXISTING_REQUEST_STATUS_SERVICE,
  RestockExistingRequestStatusService,
} from './application/restock-existing-request-status.service';
import {
  RESTOCK_POST_LEDGER,
  type RestockPostLedgerPort,
} from './domain/restock-post-ledger';
import {
  SHARED_RESERVATION,
  type SharedReservationPort,
} from './domain/shared-reservation';
import { SHARED_ROUTE_MARKERS } from './domain/shared-route-markers';
import { PostgresRestockApplicationContextStore } from './infrastructure/postgres-restock-application-context.store';
import { PostgresRestockPostLedgerStore } from './infrastructure/postgres-restock-post-ledger.store';
import { PostgresSharedReservationStore } from './infrastructure/postgres-shared-reservation.store';
import { PostgresSharedRouteMarkersStore } from './infrastructure/postgres-shared-route-markers.store';

/**
 * HumanDecisionsModule
 *
 * Provides the route-agnostic durable ports for the human-decision flows:
 *   - `SHARED_RESERVATION` → `PostgresSharedReservationStore` (the ACTIVE
 *     claim/replay/close over `human_decision_reservations`).
 *   - `SHARED_ROUTE_MARKERS` → `PostgresSharedRouteMarkersStore` (the read-only
 *     trusted route-marker snapshot).
 *   - `RESTOCK_POST_LEDGER` → `PostgresRestockPostLedgerStore` (the route-scoped
 *     RESTOCK POST state machine).
 *   - `RESTOCK_INTAKE_SERVICE` → `RestockIntakeService`, built by a factory that
 *     forwards fresh receipt hints to the private application runtime.
 *   - `RESTOCK_EXISTING_REQUEST_STATUS_SERVICE` →
 *     `RestockExistingRequestStatusService`, the READ-ONLY recovery seam for an
 *     already accepted request; it reads the recorded context and polls the
 *     current decision and can never POST, reserve or release.
 *
 * Imports `DatabaseModule` for `PG_POOL` and `ChatbotApiModule` for
 * `CHATBOT_API_CLIENT`; the acyclic sender leaf supplies outbound delivery.
 * Init stays idle. Only strict `restockEnabled === true` starts the private
 * runtime; fresh receipt hints schedule bounded application polling.
 * Shared reservation guards remain available independently of that flag.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ChatbotApiModule,
    WhatsappSenderModule,
  ],
  providers: [
    RestockApplicationRuntime,
    {
      provide: SHARED_RESERVATION,
      useClass: PostgresSharedReservationStore,
    },
    {
      provide: SHARED_ROUTE_MARKERS,
      useClass: PostgresSharedRouteMarkersStore,
    },
    {
      provide: RESTOCK_POST_LEDGER,
      useClass: PostgresRestockPostLedgerStore,
    },
    {
      provide: PostgresRestockApplicationContextStore,
      useFactory: (pool: Pool) =>
        new PostgresRestockApplicationContextStore(pool),
      inject: [PG_POOL],
    },
    {
      provide: RESTOCK_EXISTING_REQUEST_STATUS_SERVICE,
      useFactory: (
        context: PostgresRestockApplicationContextStore,
        client: ChatbotApiClient,
        config: ConfigService,
      ) =>
        new RestockExistingRequestStatusService(
          context,
          client,
          config.get<string>('chatbotApi.branchId') as string,
          () => new Date(),
        ),
      inject: [
        PostgresRestockApplicationContextStore,
        CHATBOT_API_CLIENT,
        ConfigService,
      ],
    },
    {
      provide: RESTOCK_INTAKE_SERVICE,
      useFactory: (
        reservations: SharedReservationPort,
        ledger: RestockPostLedgerPort,
        client: ChatbotApiClient,
        runtime: RestockApplicationRuntime,
      ) =>
        new RestockIntakeService(
          reservations,
          ledger,
          client,
          (senderId, sourceRequestId) => {
            runtime.enqueue(senderId, sourceRequestId);
          },
        ),
      inject: [
        SHARED_RESERVATION,
        RESTOCK_POST_LEDGER,
        CHATBOT_API_CLIENT,
        RestockApplicationRuntime,
      ],
    },
  ],
  exports: [
    SHARED_RESERVATION,
    SHARED_ROUTE_MARKERS,
    RESTOCK_POST_LEDGER,
    RESTOCK_INTAKE_SERVICE,
    RESTOCK_EXISTING_REQUEST_STATUS_SERVICE,
  ],
})
export class HumanDecisionsModule {}

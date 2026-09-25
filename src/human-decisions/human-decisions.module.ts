import { Module } from '@nestjs/common';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { DatabaseModule } from '../database/database.module';
import {
  RESTOCK_INTAKE_SERVICE,
  RestockIntakeService,
} from './application/restock-intake.service';
import {
  RESTOCK_POST_LEDGER,
  type RestockPostLedgerPort,
} from './domain/restock-post-ledger';
import {
  SHARED_RESERVATION,
  type SharedReservationPort,
} from './domain/shared-reservation';
import { SHARED_ROUTE_MARKERS } from './domain/shared-route-markers';
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
 *     injects `[SHARED_RESERVATION, RESTOCK_POST_LEDGER, CHATBOT_API_CLIENT]`.
 *
 * Imports `DatabaseModule` for `PG_POOL` and `ChatbotApiModule` for
 * `CHATBOT_API_CLIENT`. This module is intentionally inert: nothing is
 * reserved, posted, queried, or sent during init. `HumanHandoffModule` imports
 * it for the REQUIRED `SHARED_RESERVATION` guard; the RESTOCK caller and its
 * feature flag are a later cut, so the coordinator is provided but uninvoked.
 */
@Module({
  imports: [DatabaseModule, ChatbotApiModule],
  providers: [
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
      provide: RESTOCK_INTAKE_SERVICE,
      useFactory: (
        reservations: SharedReservationPort,
        ledger: RestockPostLedgerPort,
        client: ChatbotApiClient,
      ) => new RestockIntakeService(reservations, ledger, client),
      inject: [SHARED_RESERVATION, RESTOCK_POST_LEDGER, CHATBOT_API_CLIENT],
    },
  ],
  exports: [
    SHARED_RESERVATION,
    SHARED_ROUTE_MARKERS,
    RESTOCK_POST_LEDGER,
    RESTOCK_INTAKE_SERVICE,
  ],
})
export class HumanDecisionsModule {}

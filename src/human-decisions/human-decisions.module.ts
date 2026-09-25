import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SHARED_RESERVATION } from './domain/shared-reservation';
import { PostgresSharedReservationStore } from './infrastructure/postgres-shared-reservation.store';

/**
 * HumanDecisionsModule
 *
 * Provides the route-agnostic `SharedReservationPort` bound to the durable
 * `PostgresSharedReservationStore` (writes to `human_decision_reservations`).
 * `DatabaseModule` is imported so `PG_POOL` is in scope for the store's
 * constructor.
 *
 * This module is intentionally inert: it performs no reserve/create/send during
 * init and is not yet imported by HumanHandoffModule, AppModule or SaleFlowModule
 * (that wiring is a later cut).
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: SHARED_RESERVATION,
      useClass: PostgresSharedReservationStore,
    },
  ],
  exports: [SHARED_RESERVATION],
})
export class HumanDecisionsModule {}

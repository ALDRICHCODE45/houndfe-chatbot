import {
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { BackendOutboxDrainWorker } from './application/backend-outbox-drain.worker';
import { BackendOutboxService } from './application/backend-outbox.service';
import {
  BACKEND_OUTBOX_DELIVERY,
  BACKEND_OUTBOX_STORE,
  type BackendOutboxDeliveryPort,
  type BackendOutboxStore,
} from './domain/backend-outbox';
import { PostgresBackendOutboxStore } from './infrastructure/postgres-backend-outbox.store';
import { RoutingBackendOutboxDelivery } from './infrastructure/routing-backend-outbox.delivery';

/**
 * Owns the drain worker (always on): starts once on bootstrap, never
 * restarts after shutdown, and stops in onModuleDestroy so the in-flight
 * tick finishes before PostgresPoolLifecycle (DatabaseModule, farther from
 * the root) closes the pool. onApplicationShutdown would run after the pool
 * is already closed.
 */
@Injectable()
export class BackendOutboxDrainLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker: BackendOutboxDrainWorker | undefined;
  private stopped = false;

  constructor(
    @Inject(BACKEND_OUTBOX_STORE) private readonly store: BackendOutboxStore,
    @Inject(BACKEND_OUTBOX_DELIVERY)
    private readonly delivery: BackendOutboxDeliveryPort,
  ) {}

  onApplicationBootstrap(): void {
    if (this.worker || this.stopped) return;
    this.worker = new BackendOutboxDrainWorker(this.store, this.delivery, {
      owner: `backend-outbox:${randomUUID()}`,
    });
    this.worker.start();
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.worker?.stop() ?? Promise.resolve();
  }
}

/**
 * BackendOutboxEnqueueModule: the enqueue side only, for feature graphs
 * (transcript mirror, webhook statuses). It never starts the drain worker.
 *
 *   - `BACKEND_OUTBOX_STORE` → `backend_outbox` (migration 3900).
 *   - `BackendOutboxService` → enqueue API for other modules.
 *   - `RoutingBackendOutboxDelivery` → the per-kind delivery router; feature
 *     modules register their adapters on it at init (no import back here).
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: BACKEND_OUTBOX_STORE,
      useFactory: (pool: Pool) => new PostgresBackendOutboxStore(pool),
      inject: [PG_POOL],
    },
    BackendOutboxService,
    {
      provide: RoutingBackendOutboxDelivery,
      useFactory: () => new RoutingBackendOutboxDelivery(),
    },
  ],
  exports: [
    BackendOutboxService,
    BACKEND_OUTBOX_STORE,
    RoutingBackendOutboxDelivery,
  ],
})
export class BackendOutboxEnqueueModule {}

/**
 * BackendOutboxModule (S2, human-intervention contract v1 §10.1)
 *
 *   - Re-exports `BackendOutboxEnqueueModule` (store + enqueue API).
 *   - `BACKEND_OUTBOX_DELIVERY` → the shared `RoutingBackendOutboxDelivery`:
 *     REQUEST_CREATE / REQUEST_CANCEL go to the adapter `HumanRequestsModule`
 *     registers; every other kind keeps the not-wired retry (nothing is
 *     lost).
 *   - Runs the drain worker; imported only by `AppModule`, so there is one
 *     worker per process.
 */
@Module({
  imports: [BackendOutboxEnqueueModule],
  providers: [
    {
      provide: BACKEND_OUTBOX_DELIVERY,
      useExisting: RoutingBackendOutboxDelivery,
    },
    BackendOutboxDrainLifecycle,
  ],
  exports: [BackendOutboxEnqueueModule],
})
export class BackendOutboxModule {}

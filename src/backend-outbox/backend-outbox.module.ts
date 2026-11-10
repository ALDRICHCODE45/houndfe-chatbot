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
import { NotWiredBackendOutboxDelivery } from './infrastructure/not-wired-backend-outbox.delivery';
import { PostgresBackendOutboxStore } from './infrastructure/postgres-backend-outbox.store';

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
 * BackendOutboxModule (S2, human-intervention contract v1 §10.1)
 *
 *   - `BACKEND_OUTBOX_STORE` → `backend_outbox` (migration 3900).
 *   - `BACKEND_OUTBOX_DELIVERY` → not-wired adapter until backend unit 5
 *     exists (every row retries; nothing is lost). Swap in the HTTP adapter
 *     here.
 *   - `BackendOutboxService` → enqueue API for other modules.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: BACKEND_OUTBOX_STORE,
      useFactory: (pool: Pool) => new PostgresBackendOutboxStore(pool),
      inject: [PG_POOL],
    },
    {
      provide: BACKEND_OUTBOX_DELIVERY,
      useFactory: () => new NotWiredBackendOutboxDelivery(),
    },
    BackendOutboxService,
    BackendOutboxDrainLifecycle,
  ],
  exports: [BackendOutboxService, BACKEND_OUTBOX_STORE],
})
export class BackendOutboxModule {}

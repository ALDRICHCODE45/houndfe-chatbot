import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  BACKEND_OUTBOX_STORE,
  type BackendOutboxEnqueueInput,
  type BackendOutboxEnqueueResult,
  type BackendOutboxStore,
} from '../domain/backend-outbox';

/**
 * Enqueue API for other modules (S2). Each call commits one row in its own
 * transaction, or joins the caller's open transaction when `client` is
 * given (the row then commits or rolls back with the caller's write). A
 * duplicate idempotency key is a no-op that returns the existing row.
 */
@Injectable()
export class BackendOutboxService {
  constructor(
    @Inject(BACKEND_OUTBOX_STORE) private readonly store: BackendOutboxStore,
  ) {}

  enqueue(
    input: BackendOutboxEnqueueInput,
    options: { client?: PoolClient } = {},
  ): Promise<BackendOutboxEnqueueResult> {
    return this.store.enqueue(input, options.client);
  }
}

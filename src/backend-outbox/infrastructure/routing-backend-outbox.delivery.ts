import {
  isBatchDelivery,
  type BackendOutboxBatchDeliveryPort,
  type BackendOutboxDeliveryPort,
  type BackendOutboxDeliveryResult,
  type BackendOutboxEntry,
  type BackendOutboxKind,
} from '../domain/backend-outbox';
import { NotWiredBackendOutboxDelivery } from './not-wired-backend-outbox.delivery';

/**
 * The `BACKEND_OUTBOX_DELIVERY` adapter: delegates each row by kind to the
 * adapter a feature module registered at init (before the drain starts on
 * bootstrap). Kinds without an adapter keep the not-wired retry, so their
 * rows stay queued. Registration at runtime keeps this module free of
 * feature imports (no module cycle).
 */
export class RoutingBackendOutboxDelivery implements BackendOutboxBatchDeliveryPort {
  private readonly routes = new Map<
    BackendOutboxKind,
    BackendOutboxDeliveryPort
  >();

  constructor(
    private readonly fallback: BackendOutboxDeliveryPort = new NotWiredBackendOutboxDelivery(),
  ) {}

  /** Idempotent for the same adapter; a different one is a wiring error. */
  register(
    kinds: readonly BackendOutboxKind[],
    adapter: BackendOutboxDeliveryPort,
  ): void {
    for (const kind of kinds) {
      const existing = this.routes.get(kind);
      if (existing !== undefined && existing !== adapter)
        throw new Error(`backend outbox: kind ${kind} already has an adapter`);
    }
    for (const kind of kinds) this.routes.set(kind, adapter);
  }

  deliver(entry: BackendOutboxEntry): Promise<BackendOutboxDeliveryResult> {
    return (this.routes.get(entry.kind) ?? this.fallback).deliver(entry);
  }

  /** The adapter's batch limit for the kind; `1` when it has no batching. */
  batchLimit(kind: BackendOutboxKind): number {
    const adapter = this.routes.get(kind);
    return adapter !== undefined && isBatchDelivery(adapter)
      ? adapter.batchLimit(kind)
      : 1;
  }

  /** A run is always of one kind. An adapter without batching (not expected:
   *  the worker only batches kinds with a limit above 1) goes row by row. */
  async deliverBatch(
    entries: readonly BackendOutboxEntry[],
    options?: { signal?: AbortSignal },
  ): Promise<BackendOutboxDeliveryResult[]> {
    const adapter = this.routes.get(entries[0]?.kind) ?? this.fallback;
    if (isBatchDelivery(adapter)) return adapter.deliverBatch(entries, options);
    const results: BackendOutboxDeliveryResult[] = [];
    for (const entry of entries) results.push(await adapter.deliver(entry));
    return results;
  }
}

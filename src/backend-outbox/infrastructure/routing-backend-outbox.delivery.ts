import type {
  BackendOutboxDeliveryPort,
  BackendOutboxDeliveryResult,
  BackendOutboxEntry,
  BackendOutboxKind,
} from '../domain/backend-outbox';
import { NotWiredBackendOutboxDelivery } from './not-wired-backend-outbox.delivery';

/**
 * The `BACKEND_OUTBOX_DELIVERY` adapter: delegates each row by kind to the
 * adapter a feature module registered at init (before the drain starts on
 * bootstrap). Kinds without an adapter keep the not-wired retry, so their
 * rows stay queued. Registration at runtime keeps this module free of
 * feature imports (no module cycle).
 */
export class RoutingBackendOutboxDelivery implements BackendOutboxDeliveryPort {
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
}

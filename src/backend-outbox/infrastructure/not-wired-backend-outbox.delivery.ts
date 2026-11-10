import { Injectable, Logger } from '@nestjs/common';
import type {
  BackendOutboxDeliveryPort,
  BackendOutboxDeliveryResult,
  BackendOutboxEntry,
  BackendOutboxKind,
} from '../domain/backend-outbox';

const LOG_EVERY_MS = 60_000;

/**
 * Default delivery while the backend endpoints (backend unit 5) do not
 * exist: every row is retryable, so rows accumulate safely and nothing is
 * lost. No HTTP call is made. Replace the `BACKEND_OUTBOX_DELIVERY`
 * provider with the HTTP adapter once the endpoints are live.
 */
@Injectable()
export class NotWiredBackendOutboxDelivery implements BackendOutboxDeliveryPort {
  private readonly logger = new Logger(NotWiredBackendOutboxDelivery.name);
  private readonly lastLogged = new Map<BackendOutboxKind, number>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  deliver(entry: BackendOutboxEntry): Promise<BackendOutboxDeliveryResult> {
    const error = `backend outbox delivery not wired for kind ${entry.kind}`;
    const now = this.clock();
    const last = this.lastLogged.get(entry.kind);
    if (last === undefined || now - last >= LOG_EVERY_MS) {
      this.lastLogged.set(entry.kind, now);
      this.logger.warn(`${error}; will retry`);
    }
    return Promise.resolve({ outcome: 'RETRY', error });
  }
}

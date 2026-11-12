import type { BackendOutboxDeliveryResult } from '../../backend-outbox/domain/backend-outbox';
import type { MirrorDeliveryGate } from './mirror-delivery-gate';

/**
 * The S4 reactions to a `messages:batch` / `statuses:batch` answer, shared by
 * the mirror and status adapters. One reactor runs one delivered run:
 *
 *   ok                      → `onOk` (rows DELIVERED unless it says otherwise)
 *   413 BATCH_TOO_LARGE /
 *   413 BODY_TOO_LARGE      → halve and resend (a single row is DEAD)
 *   422 MEDIA_NOT_FOUND     → re-upload every media (force) and resend once,
 *                             then RETRY (bounded)
 *   400 / 409 / 422 type    → isolate: bisect to the offending row(s), DEAD
 *                             only those, deliver the rest. A failing batch
 *                             whose left half succeeded knows the right half
 *                             holds an offender and skips resending it whole
 *   401 / 403               → STOP: nothing is killed; every unresolved row
 *                             RETRYs with a long backoff, one alert, and the
 *                             gate blocks the other batches meanwhile
 *   429 / 5xx / timeout     → RETRY the unresolved rows (Retry-After honored)
 *   anything else           → like STOP (never DEAD for an undocumented answer)
 *
 * Calls are bounded (`maxCalls`) and stop when the worker's `signal` aborts:
 * unresolved rows are RETRY, never lost. Every text here is fixed (S6).
 */

/** The call result shape the reactor reads (superset of both routes). */
export interface ReactorResult {
  kind: string;
  retryAfterSeconds?: number | null;
  status?: number | null;
  cause?: string;
  code?: string | null;
  /** statuses:batch ok: ids that match no mirrored message yet. */
  unknown?: string[];
}

export interface BatchItem<T> {
  /** Position in the run handed to `deliverBatch`. */
  index: number;
  value: T;
}

export interface BatchReactorDeps<T> {
  /** Used in alert texts only ("messages" / "statuses"). */
  label: string;
  gate: MirrorDeliveryGate;
  signal?: AbortSignal;
  maxCalls?: number;
  call(items: BatchItem<T>[]): Promise<ReactorResult>;
  /** Sets per-row results of an ok answer (default: all DELIVERED). */
  onOk?(
    items: BatchItem<T>[],
    result: ReactorResult,
    set: (index: number, result: BackendOutboxDeliveryResult) => void,
  ): Promise<void>;
  /** Mirror only: does any media of `items` still need a forced re-upload? */
  needsMediaRefresh?(items: BatchItem<T>[]): boolean;
  /** Mirror only: force-resolve every media; a result means halt with it. */
  refreshMedia?(
    items: BatchItem<T>[],
  ): Promise<BackendOutboxDeliveryResult | undefined>;
}

export const DEFAULT_MAX_CALLS = 30;

export const DELIVERED: BackendOutboxDeliveryResult = { outcome: 'DELIVERED' };

export class BatchReactor<T> {
  private readonly results: Array<BackendOutboxDeliveryResult | undefined>;
  private halted: BackendOutboxDeliveryResult | undefined;
  private calls = 0;
  private readonly maxCalls: number;

  constructor(
    private readonly deps: BatchReactorDeps<T>,
    size: number,
    preset: ReadonlyArray<BackendOutboxDeliveryResult | undefined> = [],
  ) {
    this.results = Array.from({ length: size }, (_, i) => preset[i]);
    this.maxCalls = deps.maxCalls ?? DEFAULT_MAX_CALLS;
  }

  /** Results aligned with the run; every row is resolved on return. */
  async run(items: BatchItem<T>[]): Promise<BackendOutboxDeliveryResult[]> {
    await this.process(items);
    return this.results.map(
      (result) => result ?? { outcome: 'RETRY', error: 'row was not resolved' },
    );
  }

  private set = (index: number, result: BackendOutboxDeliveryResult): void => {
    this.results[index] = result;
  };

  private setAll(
    items: BatchItem<T>[],
    result: BackendOutboxDeliveryResult,
  ): void {
    for (const item of items)
      if (this.results[item.index] === undefined) this.set(item.index, result);
  }

  private halt(
    items: BatchItem<T>[],
    result: BackendOutboxDeliveryResult,
  ): void {
    this.halted ??= result;
    this.setAll(items, result);
  }

  private dead(item: BatchItem<T>, error: string): void {
    this.set(item.index, { outcome: 'PERMANENT', error });
  }

  private async process(
    items: BatchItem<T>[],
    knownBad?: string,
  ): Promise<void> {
    if (items.length === 0) return;
    if (this.halted !== undefined) return this.setAll(items, this.halted);
    if (this.deps.signal?.aborted)
      return this.halt(items, {
        outcome: 'RETRY',
        error: 'delivery budget spent, resuming later',
      });
    if (knownBad !== undefined) {
      if (items.length === 1) return this.dead(items[0], knownBad);
      return this.isolate(items, knownBad);
    }
    if (this.calls >= this.maxCalls)
      return this.halt(items, {
        outcome: 'RETRY',
        error: 'isolation call budget spent, resuming later',
      });
    this.calls += 1;
    const result = await this.deps.call(items);

    switch (result.kind) {
      case 'ok':
        if (this.deps.onOk) await this.deps.onOk(items, result, this.set);
        else this.setAll(items, DELIVERED);
        return;
      case 'BATCH_TOO_LARGE':
      case 'BODY_TOO_LARGE':
        if (items.length > 1) return this.split(items);
        if (result.kind === 'BODY_TOO_LARGE')
          return this.dead(items[0], '413 BODY_TOO_LARGE');
        return this.setAll(items, {
          outcome: 'RETRY',
          error: '413 BATCH_TOO_LARGE for a single row',
        });
      case 'MEDIA_NOT_FOUND':
        return this.mediaNotFound(items);
      case 'MEDIA_TYPE_MISMATCH':
        return this.isolateOrDie(items, '422 MEDIA_TYPE_MISMATCH');
      case 'MESSAGE_ID_CONFLICT':
        return this.isolateOrDie(items, '409 MESSAGE_ID_CONFLICT');
      case 'VALIDATION_ERROR':
        return this.isolateOrDie(items, '400 VALIDATION_ERROR');
      case 'UNAUTHORIZED':
        return this.stop(items, '401 UNAUTHORIZED', true);
      case 'FORBIDDEN':
        return this.stop(items, `403 ${result.code ?? 'FORBIDDEN'}`, true);
      case 'RATE_LIMITED':
        return this.halt(items, {
          outcome: 'RETRY',
          error: '429 RATE_LIMITED',
          ...retryAfter(result.retryAfterSeconds),
        });
      case 'RETRYABLE':
        return this.halt(items, {
          outcome: 'RETRY',
          error: `retryable ${result.cause ?? 'error'}${
            typeof result.status === 'number' ? ` ${result.status}` : ''
          }`,
          ...retryAfter(result.retryAfterSeconds),
        });
      default:
        return this.stop(
          items,
          `unexpected ${typeof result.status === 'number' ? result.status : '?'}${
            result.code ? ` ${result.code}` : ''
          }`,
          false,
        );
    }
  }

  private async split(items: BatchItem<T>[]): Promise<void> {
    const mid = Math.ceil(items.length / 2);
    await this.process(items.slice(0, mid));
    await this.process(items.slice(mid));
  }

  private async isolateOrDie(
    items: BatchItem<T>[],
    reason: string,
  ): Promise<void> {
    if (items.length === 1) return this.dead(items[0], reason);
    return this.isolate(items, reason);
  }

  /** Bisect a batch known to fail: the left half is sent; when it goes
   *  through cleanly the right half must hold the offender, so it is not
   *  sent whole (one call per level instead of two). */
  private async isolate(items: BatchItem<T>[], reason: string): Promise<void> {
    const mid = Math.ceil(items.length / 2);
    const left = items.slice(0, mid);
    const right = items.slice(mid);
    await this.process(left);
    const leftClean = left.every(
      (item) => this.results[item.index]?.outcome === 'DELIVERED',
    );
    await this.process(right, leftClean ? reason : undefined);
  }

  private async mediaNotFound(items: BatchItem<T>[]): Promise<void> {
    const { deps } = this;
    if (
      deps.refreshMedia === undefined ||
      deps.needsMediaRefresh === undefined ||
      !deps.needsMediaRefresh(items)
    )
      return this.setAll(items, {
        outcome: 'RETRY',
        error: '422 MEDIA_NOT_FOUND',
      });
    const halted = await deps.refreshMedia(items);
    if (halted !== undefined) return this.halt(items, halted);
    return this.process(items);
  }

  private stop(
    items: BatchItem<T>[],
    error: string,
    conversationWrites: boolean,
  ): void {
    const { gate, label } = this.deps;
    const delay = conversationWrites
      ? gate.blockConversationWrites()
      : gate.stopDelayMs();
    gate.alert(
      `${label}:${error}`,
      `conversation mirror ${label} stopped (${error}): rows kept, retrying in ${Math.round(delay / 60_000)} min; check the credential or the backend`,
    );
    this.halt(items, { outcome: 'RETRY', error, retryAfterMs: delay });
  }
}

const retryAfter = (
  seconds: number | null | undefined,
): { retryAfterMs?: number } =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? { retryAfterMs: Math.round(seconds * 1000) }
    : {};

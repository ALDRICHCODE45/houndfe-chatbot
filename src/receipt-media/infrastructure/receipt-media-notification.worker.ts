/** WU9 notification worker: drains only committed inbound-caused intents at
 * least once through the shared `WhatsappSenderPort` — never an LLM path.
 * The store seam is local to this surface (the shared port and PostgreSQL
 * outbox drain adapter are WU14): `claimBatch` leases durable `PENDING` or
 * expired `SENDING` rows as `SENDING` inside a short transaction that must
 * finish before any Meta send. `markSent` is a fenced CAS (id + lease owner
 * + expected `SENDING` status + live lease) persisting the provider wamid;
 * a loser mutates nothing further even though the external send happened.
 * Crash/send-success-before-mark replays byte-identically after lease
 * expiry (at-least-once). Retryable failures reschedule; the third failed
 * attempt becomes `FAILED` and emits the local exhaustion alert seam.
 * Shutdown stops claims, wakes polling, and drains active sends — the port
 * has no AbortSignal, so no send cancellation is pretended. */
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type {
  ReceiptMediaOutboxRow,
  ReceiptTemplateKey,
} from '../domain/receipt-media.types';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';

export interface NotificationStoreSeam {
  claimBatch(limit: number, owner: string): Promise<ReceiptMediaOutboxRow[]>;
  /** Fenced CAS after provider success; loser false. The claimed row's
   * exact leaseExpiresAt rides along as the ABA fence token. */
  markSent(
    id: string,
    owner: string,
    providerMessageId: string,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
  /** Fenced requeue: attempts+1, PENDING at nextAttemptAt; the third failed
   * attempt becomes FAILED and yields 'exhausted'. Loser 'lost'. The
   * exact claimed leaseExpiresAt is the ABA fence token. */
  reschedule(
    id: string,
    owner: string,
    delayMs: number,
    leaseExpiresAt: Date,
  ): Promise<'rescheduled' | 'exhausted' | 'lost'>;
}

export interface NotificationAlertSeam {
  onExhausted(intent: ReceiptMediaOutboxRow): Promise<void>;
}

export const RETRY_DELAY_MS = 60_000;

const money = (value: number | 'PENDING' | undefined): string =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`
    : '';

/** Deterministic canonical Spanish texts keyed by the tracked WU3 template
 * keys; the bounded WU3 args are the only substitutions. Never free text. */
const TEXT: Record<ReceiptTemplateKey, string> = {
  RECEIPT_AMOUNT_PROMPT: '¿Cuál fue el monto de tu transferencia?',
  RECEIPT_AMOUNT_CONFIRM:
    'Detectamos {amountCents} MXN. Responde CONFIRMAR o CANCELAR.',
  RECEIPT_AMOUNT_REASK: 'No pudimos leer el monto. Envíalo como número.',
  RECEIPT_CANCELLED: 'Cancelamos el comprobante. Puedes enviarlo de nuevo.',
  RECEIPT_ATTACHED_PENDING:
    'Comprobante recibido, queda PENDIENTE ({backendStatus}).',
  RECEIPT_ATTACH_DEFINITE_FAILURE:
    'No pudimos adjuntar el comprobante. Contacta a soporte.',
  RECEIPT_ATTACH_UNKNOWN: 'Estamos verificando el adjunto del comprobante.',
  RECEIPT_UNAVAILABLE_LATER:
    'El servicio no está disponible. Intenta más tarde.',
  RECEIPT_IN_PROGRESS: 'Estamos procesando tu comprobante.',
  RECEIPT_FINISH_OR_CANCEL:
    'Tienes un proceso abierto: finalízalo o cancélalo.',
  RECEIPT_PLACE_SALE_FIRST: 'Primero registra la venta en el sistema.',
  RECEIPT_UNSUPPORTED_FORMAT: 'Formato no soportado. Envía JPEG o PNG.',
  RECEIPT_RECEIPTS_ONLY: 'Solo podemos procesar comprobantes de pago.',
};

export const renderNotificationText = (
  row: Pick<ReceiptMediaOutboxRow, 'templateKey' | 'templateArgs'>,
): string =>
  TEXT[row.templateKey]
    .replace('{amountCents}', money(row.templateArgs.amountCents))
    .replace('{backendStatus}', String(row.templateArgs.backendStatus ?? ''));

export interface NotificationWorkerOptions {
  owner: string;
  pollIntervalMs: number;
  batchSize: number;
  maxConcurrency: number;
}

const bounded = (v: number, lo: number, hi: number): boolean =>
  Number.isInteger(v) && v >= lo && v <= hi;

@Injectable()
export class ReceiptMediaNotificationWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private running = false;
  private readonly owner: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxConcurrency: number;
  private loop: Promise<void> | undefined;
  private stopped: Promise<void> | null = null;
  private wakeRequested = false;
  private wakeWait: (() => void) | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly store: NotificationStoreSeam,
    private readonly sender: Pick<WhatsappSenderPort, 'sendText'>,
    private readonly alert: NotificationAlertSeam,
    options: NotificationWorkerOptions,
  ) {
    const { owner, pollIntervalMs, batchSize, maxConcurrency } = options;
    if (
      owner.length < 1 ||
      owner.length > 100 ||
      !bounded(pollIntervalMs, 50, 3_600_000) ||
      !bounded(batchSize, 1, 20) ||
      !bounded(maxConcurrency, 1, 10)
    )
      throw new Error('receipt-media: invalid worker options');
    this.owner = owner;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.maxConcurrency = maxConcurrency;
  }

  /** Idempotent: exactly one loop per instance; never restarts after stop. */
  onApplicationBootstrap(): void {
    if (this.running || this.stopped !== null) return;
    this.running = true;
    this.loop = this.runLoop();
  }

  /** Coalesced: repeated calls yield at most one immediate re-poll. */
  wake(): void {
    this.wakeRequested = true;
    this.wakeWait?.();
    this.wakeWait = null;
  }

  /** Idempotent: stops claims, wakes polling, drains in-flight sends. */
  onModuleDestroy(): Promise<void> {
    if (this.stopped !== null) return this.stopped;
    this.running = false;
    this.wake();
    const loop = this.loop;
    this.stopped = Promise.allSettled([...this.inFlight]).then(() => loop);
    return this.stopped;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      await this.claimAndDispatch();
      if (!this.running) break;
      if (!this.wakeRequested) await this.waitForPollOrWake();
      this.wakeRequested = false;
    }
  }

  private waitForPollOrWake(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wakeWait === done) this.wakeWait = null;
        resolve();
      };
      const timer = setTimeout(done, this.pollIntervalMs);
      this.wakeWait = done;
    });
  }

  private async claimAndDispatch(): Promise<void> {
    const capacity = this.maxConcurrency - this.inFlight.size;
    if (capacity <= 0 || !this.running) return;
    let batch: ReceiptMediaOutboxRow[];
    try {
      batch = await this.store.claimBatch(
        Math.min(capacity, this.batchSize),
        this.owner,
      );
    } catch {
      return;
    }
    for (const intent of batch) if (this.running) this.dispatch(intent);
  }

  private dispatch(intent: ReceiptMediaOutboxRow): void {
    const settled = Promise.resolve()
      .then(() => this.deliver(intent))
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.inFlight.delete(settled);
        if (this.running) this.wake();
      });
    this.inFlight.add(settled);
  }

  /** Fail closed: a claimed intent without a valid lease-expiration token
   * cannot be fenced, so nothing is sent and nothing is bookkept. */
  private leaseToken(intent: ReceiptMediaOutboxRow): Date | null {
    return intent.leaseExpiresAt instanceof Date &&
      !Number.isNaN(intent.leaseExpiresAt.getTime())
      ? intent.leaseExpiresAt
      : null;
  }

  private async deliver(intent: ReceiptMediaOutboxRow): Promise<void> {
    const lease = this.leaseToken(intent);
    if (lease === null) return;
    let wamid: string;
    try {
      ({ providerMessageId: wamid } = await this.sender.sendText({
        to: intent.recipientId,
        text: renderNotificationText(intent),
      }));
    } catch {
      const outcome = await this.store
        .reschedule(intent.id, this.owner, RETRY_DELAY_MS, lease)
        .catch(() => 'lost' as const);
      if (outcome === 'exhausted')
        await this.alert.onExhausted(intent).catch(() => undefined);
      return;
    }
    // Fenced CAS after provider success only; a loser (false) mutates
    // nothing further — at-least-once replay covers the unmarked send.
    await this.store
      .markSent(intent.id, this.owner, wamid, lease)
      .catch(() => false);
  }
}

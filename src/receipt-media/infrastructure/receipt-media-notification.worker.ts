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
 * has no AbortSignal, so no send cancellation is pretended.
 * Human-outcome intents (R5) may wait in the queue: the 24 h window is
 * re-checked right before sending; closed means not delivered, no retry,
 * while a failed window read is retried like a failed send. */
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
import {
  applyCustomerStyle,
  type CustomerStyle,
} from '../../customer-profile/domain/notice-style';

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

/** R5 send-time window gate for the human-outcome intents. */
export interface OutcomeWindowSeam {
  /** Same inbound-observation evidence as the outcome poller. Rejects when
   * the read fails: that is transient, not a closed window. */
  isOpen(recipientId: string): Promise<boolean>;
  /** Fenced terminal mark: the intent is not delivered and never retried. */
  markNotDelivered(
    id: string,
    owner: string,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
}

const OUTCOME_TEMPLATE_KEYS: ReadonlySet<ReceiptTemplateKey> = new Set([
  'RECEIPT_PAYMENT_CONFIRMED',
  'RECEIPT_PAYMENT_PARTIAL',
  'RECEIPT_PAYMENT_REJECTED',
]);

export interface NotificationAlertSeam {
  onExhausted(intent: ReceiptMediaOutboxRow): Promise<void>;
}

export const RETRY_DELAY_MS = 60_000;

const isCents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `$1,500.00 MXN`: the one customer-facing money format of receipt texts. */
const pesos = (cents: number): string =>
  `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')} MXN`;

/** "del pedido F-12", or "de su pedido" when the folio is unknown. */
const ofOrder = (folio: string | null): string =>
  folio === null ? 'de su pedido' : `del pedido ${folio}`;

const RECEIVED_SUFFIX =
  'Lo estamos revisando y le avisamos en cuanto se confirme.';

/** Deterministic canonical Spanish texts keyed by the tracked template keys;
 * the bounded args are the only substitutions. The only backend-supplied
 * text is the customer-safe rejection reason (R5). */
const TEXT: Record<ReceiptTemplateKey, string> = {
  RECEIPT_ATTACHED_PENDING: `Recibimos su comprobante. ${RECEIVED_SUFFIX}`,
  RECEIPT_ATTACH_DEFINITE_FAILURE:
    'No pudimos registrar su comprobante. Escríbanos y le ayudamos.',
  RECEIPT_ATTACH_UNKNOWN:
    'Estamos registrando su comprobante; le avisamos en cuanto quede.',
  RECEIPT_UNAVAILABLE_LATER:
    'No pudimos recibir su comprobante. Por favor envíelo de nuevo más tarde.',
  RECEIPT_UNSUPPORTED_FORMAT:
    'Envíenos su comprobante como imagen JPEG o PNG, o como PDF, de menos de 10 MB.',
  RECEIPT_SALE_ALREADY_PAID: 'Su pedido ya está pagado.',
  RECEIPT_SALE_NOT_PAYABLE:
    'Ese pedido ya no admite pagos; si cree que es un error, escríbanos.',
  RECEIPT_PDF_ENCRYPTED:
    'Su PDF está protegido con contraseña y no podemos abrirlo. ¿Nos envía una captura de pantalla del comprobante?',
  RECEIPT_NOT_A_RECEIPT:
    'Esta imagen no parece un comprobante de pago. Si quería enviarnos su comprobante, mándelo de nuevo; si no, dígame en qué le ayudo.',
  RECEIPT_PAYMENT_CONFIRMED:
    '¡Listo! Confirmamos su pago de su pedido. Gracias por su compra.',
  RECEIPT_PAYMENT_PARTIAL:
    'Confirmamos un pago de su pedido. Puede enviarnos el comprobante del resto cuando lo tenga.',
  RECEIPT_PAYMENT_REJECTED:
    'No pudimos confirmar su comprobante de su pedido. ¿Me puede enviar otro comprobante?',
};

const folioOf = (args: ReceiptMediaOutboxRow['templateArgs']): string | null =>
  typeof args.folio === 'string' && args.folio.length > 0 ? args.folio : null;

/** The customer-safe backend rejection reason, trimmed, no final dots. */
const rejectionReason = (
  args: ReceiptMediaOutboxRow['templateArgs'],
): string =>
  typeof args.reason === 'string' ? args.reason.trim().replace(/\.+$/, '') : '';

/** Stands in for the backend reason while the fixed copy is styled. */
const REASON_SLOT = '\u0000reason\u0000';

/**
 * S1: the canonical usted text, or the customer's stored style applied to
 * the fixed copy only — the backend rejection reason is never rewritten.
 * Without a style the text is byte-identical to the usted copy.
 */
export const renderNotificationText = (
  row: Pick<ReceiptMediaOutboxRow, 'templateKey' | 'templateArgs'>,
  style?: CustomerStyle | null,
): string => {
  if (style === undefined || style === null) return renderUsted(row);
  return applyCustomerStyle(renderUsted(row, REASON_SLOT), style)
    .split(REASON_SLOT)
    .join(rejectionReason(row.templateArgs));
};

const renderUsted = (
  row: Pick<ReceiptMediaOutboxRow, 'templateKey' | 'templateArgs'>,
  reasonText?: string,
): string => {
  const args = row.templateArgs;
  const folio = folioOf(args);
  switch (row.templateKey) {
    case 'RECEIPT_ATTACHED_PENDING': {
      // S9: received + in review; a differing extracted amount is mentioned
      // without blocking.
      const received =
        folio === null
          ? TEXT.RECEIPT_ATTACHED_PENDING
          : `Recibimos su comprobante del pedido ${folio}. ${RECEIVED_SUFFIX}`;
      const { extractedAmountCents: seen, totalCents: owed } = args;
      return isCents(seen) && isCents(owed) && seen !== owed
        ? `${received} Vemos un monto de ${pesos(seen)} y su pedido es de ${pesos(owed)}; lo revisamos igual.`
        : received;
    }
    // R5/S5: the human outcome; the bot never decides it (S1).
    case 'RECEIPT_PAYMENT_CONFIRMED':
      return `¡Listo! Confirmamos su pago ${ofOrder(folio)}. Gracias por su compra.`;
    case 'RECEIPT_PAYMENT_PARTIAL': {
      const order = folio === null ? 'su pedido' : `su pedido ${folio}`;
      return isCents(args.debtCents)
        ? `Confirmamos un pago de ${order}. Queda un saldo pendiente de ${pesos(args.debtCents)}; puede enviarnos el comprobante del resto cuando lo tenga.`
        : `Confirmamos un pago de ${order}. Puede enviarnos el comprobante del resto cuando lo tenga.`;
    }
    case 'RECEIPT_PAYMENT_REJECTED': {
      const reason = reasonText ?? rejectionReason(args);
      return `No pudimos confirmar su comprobante ${ofOrder(folio)}${reason.length > 0 ? `: ${reason}` : ''}. ¿Me puede enviar otro comprobante?`;
    }
    case 'RECEIPT_NOT_A_RECEIPT':
      return args.mediaKind === 'pdf'
        ? 'Este archivo no parece un comprobante de pago. Si quería enviarnos su comprobante, mándelo de nuevo; si no, dígame en qué le ayudo.'
        : TEXT.RECEIPT_NOT_A_RECEIPT;
    case 'RECEIPT_SALE_ALREADY_PAID':
      return folio === null
        ? TEXT.RECEIPT_SALE_ALREADY_PAID
        : `Su pedido ${folio} ya está pagado.`;
    default:
      return TEXT[row.templateKey];
  }
};

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
    private readonly outcomeWindow?: OutcomeWindowSeam,
    // S1: the recipient's stored style; null/failure keeps the usted copy.
    private readonly customerStyle?: (
      recipientId: string,
    ) => Promise<CustomerStyle | null>,
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

  /** Fenced requeue; the third failed attempt alerts exhaustion. */
  private async retry(
    intent: ReceiptMediaOutboxRow,
    lease: Date,
  ): Promise<void> {
    const outcome = await this.store
      .reschedule(intent.id, this.owner, RETRY_DELAY_MS, lease)
      .catch(() => 'lost' as const);
    if (outcome === 'exhausted')
      await this.alert.onExhausted(intent).catch(() => undefined);
  }

  /** Never throws: a missing or failed profile read sends the usted copy. */
  private async recipientStyle(
    recipientId: string,
  ): Promise<CustomerStyle | null> {
    if (this.customerStyle === undefined) return null;
    try {
      return await this.customerStyle(recipientId);
    } catch {
      return null;
    }
  }

  private async deliver(intent: ReceiptMediaOutboxRow): Promise<void> {
    const lease = this.leaseToken(intent);
    if (lease === null) return;
    if (
      this.outcomeWindow !== undefined &&
      OUTCOME_TEMPLATE_KEYS.has(intent.templateKey)
    ) {
      let open: boolean;
      try {
        open = await this.outcomeWindow.isOpen(intent.recipientId);
      } catch {
        // A failed read proves nothing about the window: retry like a
        // transient send failure, within the same attempt cap.
        return this.retry(intent, lease);
      }
      if (!open) {
        await this.outcomeWindow
          .markNotDelivered(intent.id, this.owner, lease)
          .catch(() => false);
        return;
      }
    }
    const style = await this.recipientStyle(intent.recipientId);
    let wamid: string;
    try {
      ({ providerMessageId: wamid } = await this.sender.sendText({
        to: intent.recipientId,
        text: renderNotificationText(intent, style),
      }));
    } catch {
      return this.retry(intent, lease);
    }
    // Fenced CAS after provider success only; a loser (false) mutates
    // nothing further — at-least-once replay covers the unmarked send.
    await this.store
      .markSent(intent.id, this.owner, wamid, lease)
      .catch(() => false);
  }
}

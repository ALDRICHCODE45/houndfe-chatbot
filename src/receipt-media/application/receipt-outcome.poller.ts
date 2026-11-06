import { Logger } from '@nestjs/common';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CustomerInboundObservationStore } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import {
  DEFAULT_RECEIPT_OUTCOME_POLL_POLICY,
  isCustomerWindowOpen,
  outcomeTemplate,
  type ReceiptOutcomeCandidate,
  type ReceiptOutcomePollPolicy,
  type ReceiptOutcomeStore,
} from '../domain/receipt-outcome';

export type ReceiptOutcomePollerPorts = Pick<
  ChatbotApiClient,
  'getReceiptOutcome'
> &
  Pick<CustomerInboundObservationStore, 'readLatest'>;

export interface ReceiptOutcomePollerOptions {
  /** Tick period; also the base gap between reads of one receipt. */
  intervalMs?: number;
  /** Receipts per tick (bounds backend calls per interval). */
  batchSize?: number;
  /** Age after which a receipt is read every `slowIntervalMs`. */
  slowAfterMs?: number;
  slowIntervalMs?: number;
}

/**
 * Durable receipt-outcome loop (R5/S5), same shape as the DELIVERY_ZONE
 * poller: on boot and every `intervalMs` it reads a bounded batch of ATTACHED
 * receipts still awaiting their human outcome and advances each one. No
 * in-memory queue or horizon: a review may stay PENDING for days and a
 * restart resumes from the table.
 *
 * A decided outcome is recorded once, with its notification, in one store
 * transaction: the customer text is queued on the receipt outbox (sent by the
 * notification worker, which re-checks the window right before sending) when
 * the 24 h window is open; outside it the free-text
 * message cannot be sent, so it is recorded as `OUTSIDE_WINDOW` and never
 * retried. The bot never decides the outcome (S1).
 */
export class ReceiptOutcomePoller {
  private readonly logger = new Logger(ReceiptOutcomePoller.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly policy: ReceiptOutcomePollPolicy;
  private started = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;

  constructor(
    private readonly store: ReceiptOutcomeStore,
    private readonly ports: ReceiptOutcomePollerPorts,
    private readonly receivingPhoneNumberId: string,
    options: ReceiptOutcomePollerOptions = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.intervalMs =
      options.intervalMs ?? DEFAULT_RECEIPT_OUTCOME_POLL_POLICY.intervalMs;
    this.batchSize = options.batchSize ?? 20;
    this.policy = {
      intervalMs: this.intervalMs,
      slowAfterMs:
        options.slowAfterMs ?? DEFAULT_RECEIPT_OUTCOME_POLL_POLICY.slowAfterMs,
      slowIntervalMs:
        options.slowIntervalMs ??
        DEFAULT_RECEIPT_OUTCOME_POLL_POLICY.slowIntervalMs,
    };
    for (const value of [
      this.intervalMs,
      this.batchSize,
      this.policy.slowAfterMs,
      this.policy.slowIntervalMs,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('Poller bounds must be positive safe integers');
    if (this.intervalMs > 2 ** 31 - 1)
      throw new RangeError('Poller interval exceeds timer range');
  }

  /** First tick runs immediately (boot), then every `intervalMs`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return this.inFlight ?? Promise.resolve();
  }

  /** One bounded batch; a failing receipt never stops the others. */
  async tick(): Promise<void> {
    let rows: ReceiptOutcomeCandidate[];
    try {
      rows = await this.store.listOutcomeDue(this.batchSize, this.policy);
    } catch {
      this.logger.warn('receipt outcome due read failed');
      return;
    }
    for (const row of rows) {
      if (this.stopped) return;
      try {
        await this.process(row);
      } catch (error) {
        this.logger.warn(
          `receipt outcome step failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
  }

  async process(row: ReceiptOutcomeCandidate): Promise<void> {
    let outcome;
    try {
      outcome = await this.ports.getReceiptOutcome(row.backendReceiptId);
    } catch {
      // Transport, 4xx or malformed body: back off and read again later.
      await this.store.markOutcomePolled(row.id);
      return;
    }
    const template = outcomeTemplate(outcome, row.saleFolio);
    if (template === null || outcome.status === 'PENDING') {
      await this.store.markOutcomePolled(row.id);
      return;
    }
    const inside = await this.insideCustomerWindow(row.senderId);
    if (!inside)
      // Leftover: a Meta template would reach the customer here.
      this.logger.warn(
        'receipt outcome recorded outside the 24 h window; not delivered',
      );
    await this.store.commitOutcome({
      id: row.id,
      status: outcome.status,
      customerReason: outcome.customerReason,
      debtCents: outcome.sale.debtCents,
      delivery: inside ? 'QUEUED' : 'OUTSIDE_WINDOW',
      ...template,
    });
  }

  private insideCustomerWindow(senderId: string): Promise<boolean> {
    return isCustomerWindowOpen(
      this.ports,
      senderId,
      this.receivingPhoneNumberId,
      this.clock(),
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = Promise.resolve()
        .then(() => this.tick())
        .finally(() => {
          this.inFlight = undefined;
          this.schedule(this.intervalMs);
        });
    }, delayMs);
  }
}

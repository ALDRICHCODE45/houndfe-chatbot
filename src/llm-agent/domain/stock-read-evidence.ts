/**
 * Private per-call stock-read evidence (S3a, SDK-agnostic).
 *
 * The model may choose a tool and a requested subject, but only a
 * server-observed tool execution can create a trusted subject or a verified
 * stock fact. This module keeps two deliberately separated phases:
 *
 *   1. `recordExecution` captures a detached receipt for one server-owned
 *      execution: run binding, SDK call id, step, validated subject and the
 *      normalized backend outcome with catalog-generation validation.
 *   2. `admitCompletedStep` correlates those receipts with the SDK calls that
 *      actually completed a step. Only admitted receipts become facts, and any
 *      ambiguity (missing receipt, duplicate call id, mismatched model input,
 *      wrong step) fails closed.
 *
 * Model-visible tool output is never authority: it describes a result but
 * cannot authenticate a product name, a stock status or a subject. Only a
 * trusted subject's validated backend names may be displayed, and an unbound
 * attempted reference is retained as a failure, never renamed into another
 * product's success.
 *
 * This module is READ evidence only. It grants no write and cannot relax the
 * conservative non-RESTOCK mutation gate; mutation authorization stays outside
 * this file.
 */
import type { StockStatus } from '../../chatbot-api/domain/dtos/catalog.dto';

/** Verified stock statuses: a trustworthy integer quantity always accompanies them. */
export type VerifiedStockStatus = Exclude<StockStatus, 'not_managed'>;

/** Closed set of reasons a stock read produced no authoritative fact. */
export type StockUnverifiedReason =
  | 'identity_unverified'
  | 'catalog_changed'
  | 'backend_error'
  | 'mismatch'
  | 'not_managed'
  | 'inconsistent';

/** Exact product/variant identity of a stock subject. */
export interface StockReadSubject {
  productId: string;
  variantId: string | null;
}

/** Server-validated subject: backend display names are safe to show. */
export interface TrustedStockSubject extends StockReadSubject {
  productName: string;
  variantName: string | null;
}

/** Server-observed inputs captured when one tool execution completed. */
export interface StockReadReceiptInput {
  serverTurnId: string;
  toolCallId: string;
  step: number;
  /** `null` when the attempted reference never matched a trusted catalog subject. */
  subject: TrustedStockSubject | null;
  catalogGenerationBefore: number;
  catalogGenerationAfter: number;
  /** Server tool result wrapping the fresh backend DTO; never model-authored. */
  output: unknown;
}

/**
 * Server-owned observer installed in tool execution context (S3b).
 *
 * The running bot supplies the genuine server turn id and the current step
 * number; a tool reports its execution receipt synchronously through
 * `recordExecution`. This is never model input and carries no algorithm: the
 * S3a recorder remains the sole authority that admits evidence.
 */
export interface StockReadExecutionObserver {
  readonly serverTurnId: string;
  readonly step: number;
  recordExecution: (receipt: StockReadReceiptInput) => void;
}

/**
 * Adapter-mapped SDK call that completed inside a step.
 *
 * `outcome` is mapped from the SDK step shape, never from model-visible tool
 * JSON: `result`/`error` are genuine executions, while `denied` (approval
 * refused) and `unaccounted` (no terminal record) never executed. Denied and
 * unaccounted calls are deliberately NOT collapsed into `error`, so a refusal
 * is never fabricated as an executed backend failure.
 */
export interface AdmittedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  outcome: 'result' | 'error' | 'denied' | 'unaccounted';
  /**
   * Normalized SDK completion terminal for a `result` call, when the adapter
   * supplies it. The property's PRESENCE is the signal to cross-check the SDK
   * terminal against the private receipt: an adapter result carrying
   * `output: undefined` is a present-but-unusable terminal and must NOT bypass
   * validation. A caller that omits the property keeps the historical
   * receipt-only protocol.
   */
  output?: unknown;
}

/** A read that produced an authoritative fact for a trusted subject. */
export interface VerifiedStockFact {
  kind: 'verified';
  subject: StockReadSubject;
  productName: string;
  variantName: string | null;
  status: VerifiedStockStatus;
  quantity: number;
  step: number;
}

/** A read that produced no authoritative fact (trusted or unbound). */
export interface UnconfirmedStockFact {
  kind: 'unconfirmed';
  subject: StockReadSubject | null;
  productName: string | null;
  variantName: string | null;
  reason: StockUnverifiedReason;
  step: number;
}

export type StockSubjectRecord = VerifiedStockFact | UnconfirmedStockFact;

/** Truthful generic reply when only an unbound attempted reference failed. */
export const UNBOUND_STOCK_REPLY =
  'Por ahora no puedo confirmar la disponibilidad de lo que consultó. ' +
  '¿Desea que lo revise de nuevo con usted?';

function subjectKey(subject: StockReadSubject): string {
  return JSON.stringify([subject.productId, subject.variantId]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Parse a server-validated subject, or `null` when it is not trustworthy. */
function parseTrustedSubject(raw: unknown): TrustedStockSubject | null {
  const record = asRecord(raw);
  if (record === null) return null;
  if (!isNonEmptyString(record.productId)) return null;
  if (!isNonEmptyString(record.productName)) return null;
  const variantId = record.variantId;
  if (variantId !== null && !isNonEmptyString(variantId)) return null;
  const variantName = record.variantName;
  if (variantName !== null && !isNonEmptyString(variantName)) return null;
  if (variantId === null && variantName !== null) return null;
  return {
    productId: record.productId,
    variantId: variantId === null ? null : variantId,
    productName: record.productName,
    variantName: variantName === null ? null : variantName,
  };
}

function identity(subject: TrustedStockSubject): StockReadSubject {
  return { productId: subject.productId, variantId: subject.variantId };
}

type ReadOutcome =
  | { status: VerifiedStockStatus; quantity: number }
  | StockUnverifiedReason;

type CapturedRead = {
  step: number;
  subject: TrustedStockSubject | null;
  outcome: ReadOutcome;
};

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** An attempted identity can revoke evidence, but never supply names or facts. */
function attemptedSubject(raw: unknown): StockReadSubject | null {
  const input = asRecord(raw);
  if (input === null || !isNonEmptyString(input.productId)) return null;
  const variantId = input.variantId ?? null;
  if (variantId !== null && !isNonEmptyString(variantId)) return null;
  return { productId: input.productId, variantId };
}

function detached<T extends StockSubjectRecord>(record: T): T {
  return {
    ...record,
    subject: record.subject === null ? null : { ...record.subject },
  };
}

/** Authoritative status only: a consistent integer quantity is mandatory. */
function authoritativeStatus(stock: unknown): ReadOutcome {
  const record = asRecord(stock);
  if (record === null) return 'inconsistent';
  if (record.status === 'available' || record.status === 'low_stock') {
    return typeof record.quantity === 'number' &&
      Number.isInteger(record.quantity) &&
      record.quantity > 0
      ? { status: record.status, quantity: record.quantity }
      : 'inconsistent';
  }
  if (record.status === 'out_of_stock') {
    return record.quantity === 0
      ? { status: 'out_of_stock', quantity: 0 }
      : 'inconsistent';
  }
  if (record.status === 'not_managed') return 'not_managed';
  return 'inconsistent';
}

/** Validate raw backend output against the exact requested subject. */
function validateRead(
  subject: TrustedStockSubject,
  output: unknown,
): ReadOutcome {
  const record = asRecord(output);
  if (record === null) return 'inconsistent';
  if (record.ok !== true) {
    if (record.ok === false) {
      const error = asRecord(record.error);
      return error?.kind === 'catalog_identity_unverified'
        ? 'identity_unverified'
        : 'backend_error';
    }
    return 'inconsistent';
  }
  if (record.productId !== subject.productId) return 'mismatch';
  if (!isNonEmptyString(record.name)) return 'inconsistent';
  if (subject.variantId === null) return authoritativeStatus(record.stock);
  const variants = record.variants;
  if (!Array.isArray(variants)) return 'inconsistent';
  const matches = variants.filter(
    (candidate) => asRecord(candidate)?.variantId === subject.variantId,
  );
  if (matches.length === 0) return 'mismatch';
  if (matches.length > 1) return 'inconsistent';
  return authoritativeStatus(asRecord(matches[0])?.stock);
}

/**
 * Structural agreement between two normalized stock outcomes. A status and a
 * consistent integer quantity are compared semantically (never by DTO shape
 * or key order); a failure reason only matches the identical reason.
 */
function readOutcomesAgree(left: ReadOutcome, right: ReadOutcome): boolean {
  if (typeof left === 'string' || typeof right === 'string') {
    return left === right;
  }
  return left.status === right.status && left.quantity === right.quantity;
}

/** True only when the caller EXPLICITLY attached a terminal, even `undefined`. */
function hasOwnOutput(call: AdmittedToolCall): boolean {
  return Object.prototype.hasOwnProperty.call(call, 'output');
}

/**
 * Private stock-read evidence recorder for one server turn. Not persisted and
 * not serialized: a cross-turn stock fact is never current evidence.
 */
export class StockReadEvidence {
  readonly #serverTurnId: string;
  readonly #receipts = new Map<string, CapturedRead[]>();
  readonly #admittedCallIds = new Set<string>();
  /** Latest trusted record per exact subject; unbound failures live separately. */
  readonly #latest = new Map<string, StockSubjectRecord>();
  readonly #unbound: UnconfirmedStockFact[] = [];
  #lastAdmittedStep = -1;

  constructor(serverTurnId: string) {
    this.#serverTurnId = serverTurnId;
  }

  /** Capture detached values now; duplicate receipts remain ambiguous at admission. */
  recordExecution(input: StockReadReceiptInput): void {
    try {
      if (input.serverTurnId !== this.#serverTurnId) return;
      if (!isNonEmptyString(input.toolCallId)) return;
      if (!isNonnegativeInteger(input.step)) return;
      const subject = parseTrustedSubject(input.subject);
      const generationMatches =
        isNonnegativeInteger(input.catalogGenerationBefore) &&
        isNonnegativeInteger(input.catalogGenerationAfter) &&
        input.catalogGenerationBefore === input.catalogGenerationAfter;
      let outcome: ReadOutcome = 'identity_unverified';
      if (subject !== null) {
        outcome = generationMatches
          ? validateRead(subject, input.output)
          : 'catalog_changed';
      }
      const captured: CapturedRead = { step: input.step, subject, outcome };
      const list = this.#receipts.get(input.toolCallId);
      if (list === undefined) this.#receipts.set(input.toolCallId, [captured]);
      else list.push(captured);
    } catch {
      // Malformed receipts never become evidence.
    }
  }

  /** Admit the receipts correlated with one completed SDK step, in order. */
  admitCompletedStep(step: number, calls: readonly AdmittedToolCall[]): void {
    if (!isNonnegativeInteger(step)) return;
    // Stale or replayed steps never restore an older fact.
    if (step <= this.#lastAdmittedStep) return;
    this.#lastAdmittedStep = step;

    const counts = new Map<string, number>();
    for (const call of calls) {
      if (asRecord(call) !== null && isNonEmptyString(call.toolCallId)) {
        counts.set(call.toolCallId, (counts.get(call.toolCallId) ?? 0) + 1);
      }
    }
    const revocations = new Map<string, StockUnverifiedReason>();
    const failures = new Map<string, UnconfirmedStockFact>();
    const successes = new Map<string, VerifiedStockFact[]>();
    for (const call of calls) {
      if (asRecord(call) === null || call.toolName !== 'checkStock') continue;
      const record = this.#admitCall(
        step,
        call,
        counts.get(call.toolCallId) === 1,
      );
      if (record.kind === 'verified') {
        const key = subjectKey(record.subject);
        const list = successes.get(key);
        if (list === undefined) successes.set(key, [record]);
        else list.push(record);
        continue;
      }
      if (record.subject === null) {
        this.#unbound.push(record);
        const attempted = attemptedSubject(call.input);
        if (attempted !== null) {
          revocations.set(subjectKey(attempted), record.reason);
        }
        for (const receipt of this.#receipts.get(call.toolCallId) ?? []) {
          if (receipt.subject !== null) {
            revocations.set(subjectKey(receipt.subject), record.reason);
          }
        }
        continue;
      }
      failures.set(subjectKey(record.subject), record);
    }

    for (const [key, record] of successes) {
      const failure = failures.get(key);
      if (failure !== undefined) {
        this.#latest.set(key, failure);
        continue;
      }
      const first = record[0];
      const conflict = record.some(
        (candidate) =>
          candidate.status !== first.status ||
          candidate.quantity !== first.quantity,
      );
      this.#latest.set(
        key,
        conflict ? this.#unconfirmed(first, step, 'inconsistent') : first,
      );
    }
    for (const [key, record] of failures) {
      if (!successes.has(key)) this.#latest.set(key, record);
    }
    // Apply revocations last so a missing/ambiguous receipt cannot be bypassed
    // by moving a successful sibling before or after it in the same step.
    for (const [key, reason] of revocations) {
      const known = this.#latest.get(key);
      if (
        known !== undefined &&
        (known.kind === 'verified' || known.step < step)
      ) {
        this.#latest.set(key, this.#unconfirmed(known, step, reason));
      }
    }
    for (const id of counts.keys()) this.#admittedCallIds.add(id);
  }

  /** Latest record for an exact subject, verified or unconfirmed. */
  getLatestCompleted(subject: StockReadSubject): StockSubjectRecord | null {
    const record = this.#latest.get(subjectKey(subject));
    return record === undefined ? null : detached(record);
  }

  /** Latest verified shortage (qty 0) for an exact subject from a prior step. */
  getLatestVerifiedShortage(
    subject: StockReadSubject,
    beforeStep: number,
  ): VerifiedStockFact | null {
    const record = this.#latest.get(subjectKey(subject));
    if (record === undefined || record.kind !== 'verified') return null;
    if (record.status !== 'out_of_stock' || record.quantity !== 0) return null;
    if (!isNonnegativeInteger(beforeStep) || !(record.step < beforeStep))
      return null;
    return detached(record);
  }

  /**
   * True when any subject currently holds a live verified out-of-stock fact
   * (a prior completed `qty === 0` shortage). Used to decide whether the
   * narrow RESTOCK exception may be presented to the model; it grants no
   * write by itself.
   */
  hasVerifiedShortage(): boolean {
    for (const record of this.#latest.values()) {
      if (
        record.kind === 'verified' &&
        record.status === 'out_of_stock' &&
        record.quantity === 0
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * True when the ledger holds a CURRENT-step verified fact for the exact
   * requested subject. The adapter consults this before it lets an SDK
   * `result` terminal clear the conservative guard's unresolved failure: only
   * private authority may clear it, never a model-visible completion. The
   * requested identity is normalized strictly, so a malformed variant can
   * never match a fact.
   */
  hasCurrentVerifiedSubject(rawInput: unknown, step: number): boolean {
    if (!isNonnegativeInteger(step)) return false;
    const subject = attemptedSubject(rawInput);
    if (subject === null) return false;
    const record = this.#latest.get(subjectKey(subject));
    return (
      record !== undefined && record.kind === 'verified' && record.step === step
    );
  }

  /**
   * Deterministic trusted-name projection. `null` means no stock read was even
   * attempted, so ordinary model behavior is preserved by the caller. When
   * only unbound failures exist, the truthful generic reply is returned.
   */
  projectStockFacts(): string | null {
    if (this.#latest.size === 0) {
      return this.#unbound.length === 0 ? null : UNBOUND_STOCK_REPLY;
    }
    const records = [...this.#latest.entries()].sort(
      ([leftKey, left], [rightKey, right]) =>
        left.step - right.step || leftKey.localeCompare(rightKey),
    );
    return records.map(([, record]) => renderRecord(record)).join(' ');
  }

  #admitCall(
    step: number,
    call: AdmittedToolCall,
    uniqueId: boolean,
  ): StockSubjectRecord {
    if (!uniqueId || this.#admittedCallIds.has(call.toolCallId)) {
      return this.#unboundRecord(step, 'identity_unverified');
    }
    if (call.outcome === 'error') {
      // Only a genuine execution that threw is a backend error. A denial or an
      // unaccounted call never reached the backend, so it stays unverified.
      return this.#unboundRecord(step, 'backend_error');
    }
    if (call.outcome !== 'result') {
      return this.#unboundRecord(step, 'identity_unverified');
    }
    const receipts = this.#receipts.get(call.toolCallId);
    if (receipts === undefined || receipts.length !== 1) {
      return this.#unboundRecord(step, 'identity_unverified');
    }
    const receipt = receipts[0];
    if (receipt.step !== step)
      return this.#unboundRecord(step, 'identity_unverified');
    const subject = receipt.subject;
    if (subject === null)
      return this.#unboundRecord(step, 'identity_unverified');
    const input = asRecord(call.input);
    if (
      input === null ||
      input.productId !== subject.productId ||
      (input.variantId ?? null) !== subject.variantId
    ) {
      return this.#unboundRecord(step, 'identity_unverified');
    }
    const base = {
      kind: 'unconfirmed' as const,
      subject: identity(subject),
      productName: subject.productName,
      variantName: subject.variantName,
      step,
    };
    const outcome = receipt.outcome;
    // A private failure is final: the SDK completion terminal can never flip
    // it into a verified fact, and its real reason is preserved untouched.
    if (typeof outcome === 'string') return { ...base, reason: outcome };
    // When the adapter supplies the SDK terminal, its PRESENCE is the signal
    // to cross-check: a null, failed, or semantically different terminal must
    // not corroborate a verified fact. An omitted property keeps the
    // historical standalone protocol.
    if (hasOwnOutput(call)) {
      if (!readOutcomesAgree(validateRead(subject, call.output), outcome)) {
        return { ...base, reason: 'mismatch' };
      }
    }
    return {
      kind: 'verified',
      subject: identity(subject),
      productName: subject.productName,
      variantName: subject.variantName,
      status: outcome.status,
      quantity: outcome.quantity,
      step,
    };
  }

  #unboundRecord(
    step: number,
    reason: StockUnverifiedReason,
  ): UnconfirmedStockFact {
    return {
      kind: 'unconfirmed',
      subject: null,
      productName: null,
      variantName: null,
      reason,
      step,
    };
  }

  #unconfirmed(
    record: StockSubjectRecord,
    step: number,
    reason: StockUnverifiedReason,
  ): UnconfirmedStockFact {
    return {
      kind: 'unconfirmed',
      subject: record.subject,
      productName: record.productName,
      variantName: record.variantName,
      reason,
      step,
    };
  }
}

function describeLabel(
  productName: string,
  variantName: string | null,
): string {
  return variantName === null ? productName : `${productName} (${variantName})`;
}

function renderRecord(record: StockSubjectRecord): string {
  const label = describeLabel(record.productName ?? '', record.variantName);
  if (record.kind === 'verified') {
    return record.status === 'out_of_stock'
      ? `Por el momento no tenemos existencias de ${label}.`
      : `Con gusto le confirmo que ${label} sí está disponible.`;
  }
  return `No pude confirmar las existencias de ${label} en esta consulta.`;
}

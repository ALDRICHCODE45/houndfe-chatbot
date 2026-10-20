/**
 * Minimal checkout customer/address confirmation — a pure, SDK/HTTP/store
 * agnostic readiness gate and volatile confirmation lifecycle (T3 Unit A).
 *
 * It does NOT register customers, edit saved addresses, create orders, reserve
 * stock or call shipping providers, and it performs no I/O. `prepare` only
 * OFFERS a server-owned summary; `consume` turns a strict, deterministic,
 * sender-bound affirmative into a server-owned CANDIDATE (never a
 * confirmation); `finalize` confirms locally ONLY after the caller reports the
 * real success of the existing `commitMinimalCheckoutDraft` raw-expected →
 * same-validated-draft CAS.
 *
 * S7 gate: for BOTH new and saved addresses, `firstName`, `street`,
 * `exteriorNumber` (`S/N` is a valid value), `neighborhood`, `zipCode`,
 * `state`, and `city` OR `municipality` must be non-blank. `lastName` is
 * optional. Partial drafts stay valid for collection but cannot be offered for
 * confirmation, and a saved snapshot is never edited to satisfy the gate.
 *
 * Volatile state: one pending (and any local confirmation) per sender, held in
 * this instance only, with a five-minute pending TTL mirroring the RESTOCK
 * lifecycle. An offer arms ONLY through its identity-checked `onSent`, invoked
 * after the transport accepted the summary; replaced or expired callbacks
 * cannot arm. A restart loses the presentation/confirmation: the durable draft
 * survives elsewhere, so the coordinator must re-present and re-confirm.
 *
 * Composition duty (coordinator-owned): this pure domain cannot read the store,
 * prove CAS or revalidate backend freshness. Before trusting a confirmation the
 * coordinator MUST (1) revalidate any selected saved address against the
 * backend freshness version, (2) re-read the RAW expected draft and run
 * `commitMinimalCheckoutDraft(senderId, rawExpected, candidate.draft, now)`,
 * and (3) pass that exact CAS result to `finalize`. A `false` checkpoint never
 * finalizes and never retries. Any content or revision change invalidates the
 * pending and the local confirmation (a same-revision content change too).
 */
import { randomUUID } from 'node:crypto';
import {
  normalizeMinimalCheckoutDraft,
  type MinimalCheckoutDraft,
} from '../../conversation/domain/minimal-checkout-draft';
import { bindRestockInboundEvent } from '../../human-decisions/domain/restock-source-identity';

/** Pending-confirmation TTL; mirrors the RESTOCK volatile lifecycle. */
export const MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export const MINIMAL_CHECKOUT_AMBIGUOUS_REPLY =
  'Por ahora no puedo confirmar sus datos de entrega. Dígame «quiero comprar» para revisar su dirección y mostrarle los datos de nuevo.';
export const MINIMAL_CHECKOUT_CHANGED_REPLY =
  'Sus datos de entrega cambiaron. Le mostraré el resumen actualizado para que lo confirme de nuevo.';
export const MINIMAL_CHECKOUT_CONFIRMED_REPLY =
  'Gracias. Confirmé sus datos de entrega para este chat. Esta confirmación no crea un pedido, no registra al cliente ni activa el envío. Para continuar, dígame «hacer pedido» y le mostraré el resumen con el total.';
export const MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY =
  'No pude confirmar sus datos de entrega. Le mostraré el resumen actualizado para que lo confirme de nuevo.';

/**
 * Closed readiness field ids, in the fixed order the gate evaluates them. Never
 * derived from raw input.
 */
export type MinimalCheckoutMissingField =
  | 'firstName'
  | 'street'
  | 'exteriorNumber'
  | 'neighborhood'
  | 'zipCode'
  | 'state'
  | 'cityOrMunicipality';

export interface MinimalCheckoutReadiness {
  readonly ready: boolean;
  readonly missing: readonly MinimalCheckoutMissingField[];
}

/** True only for a string that contains at least one non-whitespace character. */
function isFilled(value: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The delivery fields shared by the `new` and `saved` address variants. */
function addressFields(draft: MinimalCheckoutDraft): {
  street: string | null;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  neighborhood: string | null;
  zipCode: string | null;
  state: string | null;
  city: string | null;
  municipality: string | null;
} {
  const source =
    draft.address.kind === 'saved'
      ? draft.address.snapshot
      : draft.address.fields;
  return {
    street: source.street,
    exteriorNumber: source.exteriorNumber,
    interiorNumber: source.interiorNumber,
    neighborhood: source.neighborhood,
    zipCode: source.zipCode,
    state: source.state,
    city: source.city,
    municipality: source.municipality,
  };
}

/**
 * Pure S7 readiness over an already-validated draft. The same gate applies to
 * `new` and `saved` addresses and never edits a saved snapshot.
 */
export function evaluateMinimalCheckoutReadiness(
  draft: MinimalCheckoutDraft,
): MinimalCheckoutReadiness {
  const missing: MinimalCheckoutMissingField[] = [];
  if (!isFilled(draft.customer.firstName)) missing.push('firstName');
  const fields = addressFields(draft);
  if (!isFilled(fields.street)) missing.push('street');
  if (!isFilled(fields.exteriorNumber)) missing.push('exteriorNumber');
  if (!isFilled(fields.neighborhood)) missing.push('neighborhood');
  if (!isFilled(fields.zipCode)) missing.push('zipCode');
  if (!isFilled(fields.state)) missing.push('state');
  if (!isFilled(fields.city) && !isFilled(fields.municipality)) {
    missing.push('cityOrMunicipality');
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Deterministic server-owned confirmation summary. It states the local-only
 * scope explicitly so no order, registration or shipping activation is
 * implied.
 */
export function renderMinimalCheckoutConfirmation(
  draft: MinimalCheckoutDraft,
): string {
  const fields = addressFields(draft);
  const name = [draft.customer.firstName, draft.customer.lastName]
    .filter((part): part is string => isFilled(part))
    .join(' ');
  const location = isFilled(fields.city) ? fields.city : fields.municipality;
  return [
    'Confirme sus datos de entrega:',
    `Nombre: ${name}`,
    `Calle: ${fields.street ?? ''} ${fields.exteriorNumber ?? ''}${isFilled(fields.interiorNumber) ? `, int. ${fields.interiorNumber}` : ''}`.trim(),
    `Colonia: ${fields.neighborhood ?? ''}`,
    `Código postal: ${fields.zipCode ?? ''}`,
    `Ciudad o municipio: ${location ?? ''}`,
    `Estado: ${fields.state ?? ''}`,
    '',
    'Esta confirmación es solo en este chat: no crea un pedido, no registra al cliente ni activa el envío.',
    'Responda "SÍ" para confirmar estos datos, o dígame qué quiere cambiar.',
  ].join('\n');
}

const AFFIRMATIVE = /^(?:si|sí)\.?$/i;
const OUTER_SPACING = /^[ \t]+|[ \t]+$/g;
const NEWLINES = /[\r\n]/;

/**
 * Strict deterministic affirmative: only a whole `SI`/`SÍ` with optional outer
 * spaces/tabs and one optional trailing period. Concatenated text, corrections,
 * emoji, amounts, newlines or hostile input are not consent. No model
 * inference.
 */
export function isAffirmative(raw: unknown): boolean {
  try {
    if (typeof raw !== 'string' || NEWLINES.test(raw)) return false;
    return AFFIRMATIVE.test(raw.replace(OUTER_SPACING, ''));
  } catch {
    return false;
  }
}

/** Deterministic canonical content used for exact pending binding. */
function canonicalize(draft: MinimalCheckoutDraft): string {
  return JSON.stringify(draft);
}

export type MinimalCheckoutBindingStatus =
  | {
      readonly stage: 'pending';
      readonly reference: string;
      readonly revision: number;
      readonly armed: boolean;
      readonly expiresAt: number;
    }
  | {
      readonly stage: 'confirmed';
      readonly reference: string;
      readonly revision: number;
    };

export interface MinimalCheckoutConfirmationOptions {
  /** Test seam; production uses `Date.now`. */
  readonly now?: () => number;
}

export interface MinimalCheckoutPrepareInput {
  readonly senderId: string;
  readonly inboundEvent: unknown;
  readonly draft: unknown;
}

export type MinimalCheckoutBlockedReason =
  | 'identity_unbound'
  | 'draft_unavailable'
  | 'incomplete';

export type MinimalCheckoutPrepareResult =
  | {
      readonly kind: 'offer';
      readonly reply: string;
      readonly reference: string;
      /** Arms the pending ONLY after the transport accepted the summary. */
      readonly onSent: () => void;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: MinimalCheckoutBlockedReason;
      readonly missing: readonly MinimalCheckoutMissingField[];
    };

/** Server-owned ticket: validated consent, NOT a confirmation. */
export interface MinimalCheckoutCandidate {
  readonly kind: 'candidate';
  readonly reference: string;
  readonly draft: MinimalCheckoutDraft;
}

export interface MinimalCheckoutConsumeInput {
  readonly senderId: string;
  readonly text: unknown;
  readonly inboundEvent: unknown;
  readonly draft: unknown;
}

export type MinimalCheckoutConsumeResult =
  | MinimalCheckoutCandidate
  | {
      readonly kind: 'reoffer';
      readonly reply: string;
      readonly onSent: () => void;
    }
  | { readonly kind: 'handled'; readonly reply: string }
  | null;

export interface MinimalCheckoutFinalizeInput {
  readonly senderId: string;
  /** The exact candidate issued by `consume`. */
  readonly candidate: unknown;
  /** The coordinator's real `commitMinimalCheckoutDraft` CAS result. */
  readonly committed: boolean;
}

export type MinimalCheckoutFinalizeResult =
  | { readonly kind: 'confirmed'; readonly reply: string }
  | { readonly kind: 'not_confirmed'; readonly reply: string };

interface PendingCheckoutConfirmation {
  readonly reference: string;
  readonly binding: string;
  readonly revision: number;
  readonly receivingPhoneNumberId: string;
  readonly originMessageId: string;
  readonly expiresAt: number;
  readonly presentation: string;
  armed: boolean;
}

interface ConfirmedCheckoutConfirmation {
  readonly reference: string;
  readonly binding: string;
  readonly revision: number;
}

const handledAmbiguous = (): MinimalCheckoutConsumeResult => ({
  kind: 'handled',
  reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
});

const notConfirmed = (): MinimalCheckoutFinalizeResult => ({
  kind: 'not_confirmed',
  reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
});

/**
 * Pure, instance-scoped confirmation lifecycle. The coordinator owns the
 * transport, the CAS checkpoint and saved-address freshness revalidation.
 */
export class MinimalCheckoutConfirmation {
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingCheckoutConfirmation>();
  private readonly confirmed = new Map<string, ConfirmedCheckoutConfirmation>();

  constructor(options: MinimalCheckoutConfirmationOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Observable local-binding state for one sender: the live pending, the local
   * confirmation, or `null`. Expired pending state is cleared and reported as
   * absent.
   */
  status(senderId: string): MinimalCheckoutBindingStatus | null {
    try {
      if (typeof senderId !== 'string') return null;
      const pending = this.pending.get(senderId);
      if (pending !== undefined) {
        if (this.now() < pending.expiresAt) {
          return {
            stage: 'pending',
            reference: pending.reference,
            revision: pending.revision,
            armed: pending.armed,
            expiresAt: pending.expiresAt,
          };
        }
        this.pending.delete(senderId);
      }
      const confirmed = this.confirmed.get(senderId);
      if (confirmed === undefined) return null;
      return {
        stage: 'confirmed',
        reference: confirmed.reference,
        revision: confirmed.revision,
      };
    } catch {
      return null;
    }
  }

  /**
   * Drop the local confirmation after the coordinator committed a real draft
   * change. A live pending is kept: its exact binding already rejects a SÍ for
   * the changed draft.
   */
  revokeConfirmation(senderId: string): void {
    this.confirmed.delete(senderId);
  }

  /**
   * The validated draft only while its exact canonical content equals what the
   * sender confirmed; any outside change, malformed or foreign draft yields
   * `null`. Order placement must use this instead of the bare status.
   */
  confirmedDraft(
    senderId: string,
    rawDraft: unknown,
  ): MinimalCheckoutDraft | null {
    try {
      if (typeof senderId !== 'string') return null;
      const confirmed = this.confirmed.get(senderId);
      if (confirmed === undefined) return null;
      const draft = normalizeMinimalCheckoutDraft(rawDraft, senderId);
      if (draft === null || canonicalize(draft) !== confirmed.binding) {
        return null;
      }
      return draft;
    } catch {
      return null;
    }
  }

  /**
   * Pure readiness for an untrusted draft: `null` when the draft is malformed
   * or bound to another sender, otherwise the observable missing fields.
   */
  readiness(
    senderId: string,
    rawDraft: unknown,
  ): MinimalCheckoutReadiness | null {
    try {
      const draft = normalizeMinimalCheckoutDraft(rawDraft, senderId);
      if (draft === null) return null;
      return evaluateMinimalCheckoutReadiness(draft);
    } catch {
      return null;
    }
  }

  /**
   * Prepare an offer from the trusted sender's current draft. Supersedes any
   * prior pending/confirmation for the sender; never confirms and never writes.
   */
  prepare(input: MinimalCheckoutPrepareInput): MinimalCheckoutPrepareResult {
    const blocked = (
      reason: MinimalCheckoutBlockedReason,
      missing: readonly MinimalCheckoutMissingField[] = [],
    ): MinimalCheckoutPrepareResult => ({ kind: 'blocked', reason, missing });
    try {
      const senderId = input.senderId;
      if (typeof senderId !== 'string' || senderId.trim() === '') {
        return blocked('identity_unbound');
      }
      // A new presentation supersedes any prior local binding for this sender.
      this.pending.delete(senderId);
      this.confirmed.delete(senderId);
      const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
      if (bound === null) return blocked('identity_unbound');
      const draft = normalizeMinimalCheckoutDraft(input.draft, senderId);
      if (draft === null) return blocked('draft_unavailable');
      const readiness = evaluateMinimalCheckoutReadiness(draft);
      if (!readiness.ready) return blocked('incomplete', readiness.missing);
      const pending: PendingCheckoutConfirmation = {
        reference: randomUUID(),
        binding: canonicalize(draft),
        revision: draft.revision,
        receivingPhoneNumberId: bound.event.receivingPhoneNumberId,
        originMessageId: bound.event.messageId,
        expiresAt: this.now() + MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS,
        presentation: renderMinimalCheckoutConfirmation(draft),
        armed: false,
      };
      this.pending.set(senderId, pending);
      return {
        kind: 'offer',
        reply: pending.presentation,
        reference: pending.reference,
        onSent: this.armFor(senderId, pending),
      };
    } catch {
      return blocked('identity_unbound');
    }
  }

  /**
   * Interpret one inbound turn. A strict, trusted, fresh, armed affirmative
   * whose current draft still matches the presented binding yields a candidate
   * ticket; it is still pending, not confirmed. A replay of the origin message
   * re-offers with a checked `onSent` and never confirms. Everything else
   * returns `null` (unhandled) or a handled non-confirmation.
   */
  consume(input: MinimalCheckoutConsumeInput): MinimalCheckoutConsumeResult {
    try {
      const senderId = input.senderId;
      if (typeof senderId !== 'string') return null;
      const pending = this.pending.get(senderId);
      if (pending === undefined) return null;
      const expired = this.now() >= pending.expiresAt;
      if (expired) this.pending.delete(senderId);
      const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
      const event = bound?.event;
      const trusted =
        event !== undefined &&
        event.receivingPhoneNumberId === pending.receivingPhoneNumberId;
      const replay =
        event !== undefined && event.messageId === pending.originMessageId;
      // Origin replay re-presents with a checked arming callback; never confirms.
      if (!expired && trusted && replay) {
        return {
          kind: 'reoffer',
          reply: pending.presentation,
          onSent: this.armFor(senderId, pending),
        };
      }
      // Only the current, strict, deterministic affirmative can ever confirm.
      if (!isAffirmative(input.text)) return null;
      if (expired || !trusted) return handledAmbiguous();
      if (!pending.armed) return handledAmbiguous();
      const current = normalizeMinimalCheckoutDraft(input.draft, senderId);
      if (current === null || canonicalize(current) !== pending.binding) {
        this.pending.delete(senderId);
        this.confirmed.delete(senderId);
        return { kind: 'handled', reply: MINIMAL_CHECKOUT_CHANGED_REPLY };
      }
      return {
        kind: 'candidate',
        reference: pending.reference,
        draft: current,
      };
    } catch {
      return handledAmbiguous();
    }
  }

  /**
   * Confirm locally ONLY when the caller reports a successful checkpoint, the
   * candidate matches the live pending exactly, and the pending is unexpired.
   * Any other outcome invalidates and never retries.
   */
  finalize(input: MinimalCheckoutFinalizeInput): MinimalCheckoutFinalizeResult {
    try {
      const senderId = input.senderId;
      if (typeof senderId !== 'string') return notConfirmed();
      const pending = this.pending.get(senderId);
      if (pending === undefined) return notConfirmed();
      const expired = this.now() >= pending.expiresAt;
      const matches = this.matchesPending(input.candidate, senderId, pending);
      if (input.committed !== true || expired || !matches) {
        this.pending.delete(senderId);
        this.confirmed.delete(senderId);
        return notConfirmed();
      }
      this.pending.delete(senderId);
      this.confirmed.set(senderId, {
        reference: pending.reference,
        binding: pending.binding,
        revision: pending.revision,
      });
      return { kind: 'confirmed', reply: MINIMAL_CHECKOUT_CONFIRMED_REPLY };
    } catch {
      return notConfirmed();
    }
  }

  /**
   * Identity-checked arming callback: only the SAME live, unexpired pending may
   * be armed. A replaced or expired callback is a no-op.
   */
  private armFor(
    senderId: string,
    pending: PendingCheckoutConfirmation,
  ): () => void {
    return () => {
      if (this.pending.get(senderId) !== pending) return;
      if (this.now() >= pending.expiresAt) return;
      pending.armed = true;
    };
  }

  /**
   * Revalidate a caller-supplied ticket against the live pending: exact
   * reference plus the same canonical content+revision. A forged or
   * caller-mutated candidate never matches.
   */
  private matchesPending(
    candidate: unknown,
    senderId: string,
    pending: PendingCheckoutConfirmation,
  ): boolean {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    if (record.kind !== 'candidate') return false;
    if (record.reference !== pending.reference) return false;
    const normalized = normalizeMinimalCheckoutDraft(record.draft, senderId);
    if (normalized === null) return false;
    return canonicalize(normalized) === pending.binding;
  }
}

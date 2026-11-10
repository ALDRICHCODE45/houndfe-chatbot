import { Inject, Injectable, Optional } from '@nestjs/common';
import { toMexicanState } from '../domain/mexican-state';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import {
  normalizeCustomerCheckoutContext,
  type CheckoutContextAddress,
  type NormalizedCheckoutContextQuery,
} from '../../chatbot-api/domain/dtos/checkout-context.dto';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  MINIMAL_CHECKOUT_DRAFT_SCHEMA_VERSION,
  normalizeMinimalCheckoutDraft,
  type MinimalCheckoutDraft,
  type MinimalCheckoutDraftNewAddressFields,
} from '../../conversation/domain/minimal-checkout-draft';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import { CheckoutAddressGate } from './gates/checkout-address.gate';
import { DurableCheckoutConfirmation } from './gates/checkout-confirmation.gate';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { processLocalConversationGates } from '../../conversation-gates/infrastructure/process-local-conversation-gates';
import {
  MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
  MINIMAL_CHECKOUT_CHANGED_REPLY,
  MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
  evaluateMinimalCheckoutReadiness,
  type MinimalCheckoutBindingStatus,
  type MinimalCheckoutMissingField,
} from '../domain/minimal-checkout-confirmation';

export const MINIMAL_CHECKOUT_INVALID_STATE_REPLY =
  'Indique un estado válido de México para su dirección de entrega; después deberá confirmar nuevamente sus datos de entrega.';

export const MINIMAL_CHECKOUT_ADDRESS_REQUIRED_REPLY =
  'Para crear su pedido primero necesito su dirección de entrega. Dígame «quiero comprar» para ver sus direcciones guardadas o escríbame una dirección nueva.';

export const MINIMAL_CHECKOUT_INCOMPLETE_REPLY =
  'Para mostrarle el resumen de entrega aún me falta:';
export const MINIMAL_CHECKOUT_RESELECT_REPLY =
  'Dígame «quiero comprar» para ver sus direcciones guardadas y elija cuál usar para la entrega.';
export const MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY =
  'Por ahora no puedo verificar su dirección guardada. Intente de nuevo en un momento.';

/** First page of a fresh lookup; matches the backend default limit. */
const FIRST_PAGE: NormalizedCheckoutContextQuery = {
  limit: 10,
  afterAddressId: null,
};

const MISSING_LABELS: Record<MinimalCheckoutMissingField, string> = {
  firstName: 'nombre',
  street: 'calle',
  exteriorNumber: 'número exterior o S/N',
  neighborhood: 'colonia',
  zipCode: 'código postal',
  state: 'estado',
  cityOrMunicipality: 'ciudad o municipio',
};

const ADDRESS_FIELDS = [
  'label',
  'street',
  'exteriorNumber',
  'interiorNumber',
  'zipCode',
  'neighborhood',
  'municipality',
  'city',
  'state',
  'visualReferences',
  'carrierPhone',
] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];

/** Same bounds as the backend customer DTO, so a later registration fits. */
const MAX_LENGTH: Record<'firstName' | 'lastName' | AddressField, number> = {
  firstName: 100,
  lastName: 100,
  label: 100,
  street: 200,
  exteriorNumber: 20,
  interiorNumber: 20,
  zipCode: 10,
  neighborhood: 100,
  municipality: 100,
  city: 100,
  state: 100,
  visualReferences: 500,
  carrierPhone: 20,
};

/** `null` means "no change"; a string sets the field. */
export type MinimalCheckoutDetailsPatch = {
  [K in 'firstName' | 'lastName' | AddressField]: string | null;
} & { useNewAddress: boolean };

export type MinimalCheckoutError =
  | 'identity_unavailable'
  | 'lookup_unavailable'
  | 'unknown_reference'
  | 'draft_unavailable'
  | 'draft_changed'
  | 'invalid_details';

export interface MinimalCheckoutAddressChoice {
  addressRef: string;
  ordinal: number;
  label: string | null;
  summary: string;
}

export type MinimalCheckoutLookupResult =
  | { ok: false; error: MinimalCheckoutError }
  | { ok: true; status: 'not_found' | 'ambiguous'; addresses: [] }
  | {
      ok: true;
      status: 'unique';
      customerFirstName: string;
      addresses: MinimalCheckoutAddressChoice[];
      nextPageRef: string | null;
    };

export type MinimalCheckoutDraftResult =
  | { ok: false; error: MinimalCheckoutError }
  | {
      ok: true;
      ready: boolean;
      missing: readonly MinimalCheckoutMissingField[];
    };

export interface MinimalCheckoutReply {
  reply: string;
  onSent?: () => void;
  /** Set only when this reply confirmed the delivery data (F1 continuation). */
  confirmed?: true;
}

export type MinimalCheckoutRevalidation = 'ok' | 'reselect' | 'unavailable';

/** Store-pickup identity (C1): no delivery data is involved. */
export type MinimalPickupIdentity =
  | {
      kind: 'existing';
      customerId: string;
      firstName: string;
      lastName: string | null;
    }
  | { kind: 'new'; firstName: string; lastName: string | null }
  | { kind: 'name_required' }
  | { kind: 'ambiguous' }
  | { kind: 'unavailable' };
type Revalidation = MinimalCheckoutRevalidation;

/** Server-owned incomplete reply listing the missing data in gate order. */
export function minimalCheckoutIncompleteReply(
  missing: readonly MinimalCheckoutMissingField[],
): string {
  return `${MINIMAL_CHECKOUT_INCOMPLETE_REPLY} ${missing
    .map((field) => MISSING_LABELS[field])
    .join(', ')}.`;
}

function summarize(address: CheckoutContextAddress): string {
  const place = address.city ?? address.municipality;
  return [
    [address.street, address.exteriorNumber].filter(Boolean).join(' '),
    address.interiorNumber === null ? null : `int. ${address.interiorNumber}`,
    address.neighborhood,
    address.zipCode === null ? null : `C.P. ${address.zipCode}`,
    place,
    address.state,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ');
}

const EMPTY_FIELDS = (): MinimalCheckoutDraftNewAddressFields => ({
  label: null,
  street: null,
  exteriorNumber: null,
  interiorNumber: null,
  zipCode: null,
  neighborhood: null,
  municipality: null,
  city: null,
  state: null,
  visualReferences: null,
  carrierPhone: null,
});

/**
 * Minimal-route checkout coordinator (T3): read-only sender lookup, saved
 * address selection, local draft collection and explicit local confirmation.
 * It never registers customers, edits saved addresses, creates sales, reserves
 * stock, takes payment or quotes shipping. The validated draft lives in the
 * conversation store; the confirmation and the address references are S4
 * durable gates with their original expiry (process-local when built
 * without `ConversationGates`).
 */
@Injectable()
export class MinimalCheckoutService {
  private readonly confirmation: DurableCheckoutConfirmation;
  private readonly addresses: CheckoutAddressGate;

  constructor(
    @Inject(CHATBOT_API_CLIENT) private readonly api: ChatbotApiClient,
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    @Optional() gates?: ConversationGates,
  ) {
    const shared = gates ?? processLocalConversationGates();
    this.confirmation = new DurableCheckoutConfirmation(shared);
    this.addresses = new CheckoutAddressGate(shared);
  }

  /** Only adapters with the owned draft CAS can host the checkout tools. */
  get available(): boolean {
    return typeof this.store.commitMinimalCheckoutDraft === 'function';
  }

  /** Volatile local confirmation state for the sender, or `null`. */
  confirmationStatus(senderId: string): MinimalCheckoutBindingStatus | null {
    return this.confirmation.status(senderId);
  }

  /**
   * The durable draft only while it still equals, byte for byte, the content
   * the sender confirmed; any outside change or an unreadable store is `null`.
   */
  async confirmedDraft(senderId: string): Promise<MinimalCheckoutDraft | null> {
    const current = await this.readDraft(senderId);
    if (current === null || current.draft === undefined) return null;
    return this.confirmation.confirmedDraft(senderId, current.raw);
  }

  /** Backend rejected the selected base; a fresh lookup/selection is required. */
  clearSelection(senderId: string): void {
    this.addresses.unselect(senderId);
    this.confirmation.revokeConfirmation(senderId);
  }

  /** Fresh saved-address check for order placement; see `revalidate`. */
  revalidateSelection(
    senderId: string,
    draft: MinimalCheckoutDraft,
  ): Promise<MinimalCheckoutRevalidation> {
    return this.revalidate(senderId, draft);
  }

  /**
   * Pickup identity from a fresh sender-bound lookup: the unique registered
   * customer, or a new customer by the name in the local draft (confirmed or
   * not). Never needs an address or a delivery confirmation.
   */
  async pickupIdentity(senderId: string): Promise<MinimalPickupIdentity> {
    const phone = parseMexicanWhatsAppPhone(senderId);
    if (phone === null) return { kind: 'unavailable' };
    let context;
    try {
      context = normalizeCustomerCheckoutContext(
        await this.api.getCustomerCheckoutContext(
          phone.phoneCountryCode,
          phone.phone,
          { ...FIRST_PAGE },
        ),
      );
    } catch {
      return { kind: 'unavailable' };
    }
    if (context === null) return { kind: 'unavailable' };
    if (context.status === 'ambiguous') return { kind: 'ambiguous' };
    if (context.status === 'unique') {
      const { customerId, firstName, lastName } = context.customer;
      return { kind: 'existing', customerId, firstName, lastName };
    }
    const current = await this.readDraft(senderId);
    if (current === null) return { kind: 'unavailable' };
    const name = current.draft?.customer;
    return name?.firstName === null || name === undefined
      ? { kind: 'name_required' }
      : { kind: 'new', firstName: name.firstName, lastName: name.lastName };
  }

  async lookup(
    senderId: string,
    nextPageRef: string | null,
  ): Promise<MinimalCheckoutLookupResult> {
    const phone = parseMexicanWhatsAppPhone(senderId);
    if (phone === null) return { ok: false, error: 'identity_unavailable' };
    const registry = this.addresses.registryFor(senderId);
    let query = FIRST_PAGE;
    if (nextPageRef !== null) {
      const next = registry.resolveNextPage(nextPageRef);
      if (next === null) return { ok: false, error: 'unknown_reference' };
      query = next.query;
    }
    let raw: unknown;
    try {
      raw = await this.api.getCustomerCheckoutContext(
        phone.phoneCountryCode,
        phone.phone,
        { ...query },
      );
    } catch {
      return { ok: false, error: 'lookup_unavailable' };
    }
    const context = normalizeCustomerCheckoutContext(raw);
    if (context === null) return { ok: false, error: 'lookup_unavailable' };
    if (context.status !== 'unique') {
      return { ok: true, status: context.status, addresses: [] };
    }
    const page = registry.registerPage({
      context,
      query,
      cursorReference: nextPageRef,
    });
    if (page === null) return { ok: false, error: 'lookup_unavailable' };
    this.addresses.rememberCustomer(senderId, context.customer);
    this.addresses.touch(senderId);
    const addresses: MinimalCheckoutAddressChoice[] = [];
    for (const offer of page.addresses) {
      const resolved = registry.resolveAddress(offer.reference);
      if (resolved === null) continue;
      addresses.push({
        addressRef: offer.reference,
        ordinal: offer.ordinal,
        label: offer.label,
        summary: summarize(resolved.address),
      });
    }
    return {
      ok: true,
      status: 'unique',
      customerFirstName: context.customer.firstName,
      addresses,
      nextPageRef: page.nextPageReference,
    };
  }

  async selectAddress(
    senderId: string,
    addressRef: string,
  ): Promise<MinimalCheckoutDraftResult> {
    const resolved = this.addresses
      .registryFor(senderId)
      .resolveAddress(addressRef);
    if (resolved === null) return { ok: false, error: 'unknown_reference' };
    const current = await this.readDraft(senderId);
    if (current === null) return { ok: false, error: 'draft_unavailable' };
    const known = this.addresses.customer(senderId);
    const customer =
      current.draft !== undefined && current.draft.customer.firstName !== null
        ? current.draft.customer
        : known !== undefined && known.customerId === resolved.customerId
          ? { firstName: known.firstName, lastName: known.lastName }
          : { firstName: null, lastName: null };
    const result = await this.write(senderId, current, {
      sourceCustomerId: resolved.customerId,
      customer,
      address: { kind: 'saved', snapshot: resolved.address },
    });
    if (result.ok) {
      this.addresses.select(senderId, resolved.reference);
      this.addresses.touch(senderId);
    }
    return result;
  }

  async updateDetails(
    senderId: string,
    patch: MinimalCheckoutDetailsPatch,
  ): Promise<MinimalCheckoutDraftResult> {
    const values = new Map<string, string>();
    for (const key of Object.keys(MAX_LENGTH) as Array<
      keyof typeof MAX_LENGTH
    >) {
      const value: unknown = patch[key];
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') return invalid();
      const trimmed = value.trim();
      if (trimmed === '' || trimmed.length > MAX_LENGTH[key]) return invalid();
      values.set(key, trimmed);
    }
    const current = await this.readDraft(senderId);
    if (current === null) return { ok: false, error: 'draft_unavailable' };
    const draft = current.draft;
    dropStreetNumberEcho(values, draft);
    const savedSelected = draft !== undefined && draft.address.kind !== 'new';
    const keepSaved = savedSelected && patch.useNewAddress !== true;
    const customer = {
      firstName: values.get('firstName') ?? draft?.customer.firstName ?? null,
      lastName: values.get('lastName') ?? draft?.customer.lastName ?? null,
    };
    let address: MinimalCheckoutDraft['address'];
    if (keepSaved && draft !== undefined && draft.address.kind !== 'new') {
      const snapshot = draft.address.snapshot;
      const fields: MinimalCheckoutDraftNewAddressFields = EMPTY_FIELDS();
      const source =
        draft.address.kind === 'saved' ? snapshot : draft.address.fields;
      for (const key of ADDRESS_FIELDS) {
        fields[key] = values.get(key) ?? source[key];
      }
      address = ADDRESS_FIELDS.every((key) => fields[key] === snapshot[key])
        ? { kind: 'saved', snapshot }
        : { kind: 'savedCorrected', snapshot, fields };
    } else {
      const fields =
        draft?.address.kind === 'new'
          ? { ...draft.address.fields }
          : EMPTY_FIELDS();
      for (const key of ADDRESS_FIELDS) {
        const value = values.get(key);
        if (value !== undefined) fields[key] = value;
      }
      address = { kind: 'new', fields };
    }
    const result = await this.write(senderId, current, {
      sourceCustomerId: draft?.sourceCustomerId ?? null,
      customer,
      address,
    });
    if (result.ok && !keepSaved) {
      this.addresses.unselect(senderId);
      this.addresses.touch(senderId);
    }
    return result;
  }

  /** Server-owned summary offer, or the reply explaining why it is blocked. */
  async prepareConfirmation(
    senderId: string,
    inboundEvent: unknown,
  ): Promise<MinimalCheckoutReply> {
    const current = await this.readDraft(senderId);
    if (current === null) return { reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY };
    if (current.draft === undefined) {
      return { reply: MINIMAL_CHECKOUT_ADDRESS_REQUIRED_REPLY };
    }
    const readiness = evaluateMinimalCheckoutReadiness(current.draft);
    if (!readiness.ready) {
      return { reply: minimalCheckoutIncompleteReply(readiness.missing) };
    }
    if (
      current.draft.address.kind !== 'saved' &&
      toMexicanState(current.draft.address.fields.state) === null
    ) {
      this.confirmation.revokeConfirmation(senderId);
      return { reply: MINIMAL_CHECKOUT_INVALID_STATE_REPLY };
    }
    const revalidation = await this.revalidate(senderId, current.draft);
    if (revalidation !== 'ok') return revalidationReply(revalidation);
    const prepared = this.confirmation.prepare({
      senderId,
      inboundEvent,
      draft: current.raw,
    });
    if (prepared.kind === 'offer') {
      return { reply: prepared.reply, onSent: prepared.onSent };
    }
    return prepared.reason === 'incomplete'
      ? { reply: minimalCheckoutIncompleteReply(prepared.missing) }
      : { reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY };
  }

  /**
   * Consume one inbound turn against a pending presentation. `null` means the
   * turn is not a checkout answer and other routes keep it.
   */
  async consume(input: {
    senderId: string;
    text: string;
    inboundEvent?: unknown;
  }): Promise<MinimalCheckoutReply | null> {
    if (this.confirmation.status(input.senderId)?.stage !== 'pending') {
      return null;
    }
    const current = await this.readDraft(input.senderId);
    const result = this.confirmation.consume({
      senderId: input.senderId,
      text: input.text,
      inboundEvent: input.inboundEvent,
      draft: current?.raw,
    });
    if (result === null) return null;
    if (result.kind === 'reoffer') {
      return { reply: result.reply, onSent: result.onSent };
    }
    if (result.kind === 'handled') {
      return result.reply === MINIMAL_CHECKOUT_CHANGED_REPLY
        ? this.reoffer(input.senderId, input.inboundEvent, result.reply)
        : { reply: result.reply };
    }
    const revalidation =
      current === null
        ? 'unavailable'
        : await this.revalidate(input.senderId, result.draft);
    if (current === null || revalidation !== 'ok') {
      await this.confirmation.finalize({
        senderId: input.senderId,
        candidate: result,
        committed: false,
      });
      return revalidationReply(
        revalidation === 'ok' ? 'unavailable' : revalidation,
      );
    }
    const committed = await this.commit(
      input.senderId,
      current.raw,
      result.draft,
    );
    const finalized = await this.confirmation.finalize({
      senderId: input.senderId,
      candidate: result,
      committed,
    });
    return finalized.kind === 'confirmed'
      ? { reply: finalized.reply, confirmed: true }
      : this.reoffer(
          input.senderId,
          input.inboundEvent,
          MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
        );
  }

  /**
   * Keeps the promise of `lead` ("le mostraré el resumen actualizado"): the
   * fresh summary follows it. When no summary can be offered, only the reason
   * is sent, so the customer is never told a summary is coming.
   */
  private async reoffer(
    senderId: string,
    inboundEvent: unknown,
    lead: string,
  ): Promise<MinimalCheckoutReply> {
    const prepared = await this.prepareConfirmation(senderId, inboundEvent);
    return prepared.onSent === undefined
      ? prepared
      : { reply: `${lead}\n\n${prepared.reply}`, onSent: prepared.onSent };
  }

  /**
   * Raw durable draft plus its validated copy. `raw` is `undefined` only when
   * the owned key is absent; a present but invalid value is unavailable, so it
   * is never overwritten. `null` means the store could not be read.
   */
  private async readDraft(
    senderId: string,
  ): Promise<{ raw: unknown; draft: MinimalCheckoutDraft | undefined } | null> {
    try {
      const state = await this.store.get(senderId);
      if (
        state === null ||
        !Object.hasOwn(state.data, 'minimalCheckoutDraft')
      ) {
        return { raw: undefined, draft: undefined };
      }
      const raw: unknown = state.data.minimalCheckoutDraft;
      const draft = normalizeMinimalCheckoutDraft(raw, senderId);
      return draft === null ? null : { raw, draft };
    } catch {
      return null;
    }
  }

  private async write(
    senderId: string,
    current: { raw: unknown; draft: MinimalCheckoutDraft | undefined },
    content: Pick<
      MinimalCheckoutDraft,
      'sourceCustomerId' | 'customer' | 'address'
    >,
  ): Promise<MinimalCheckoutDraftResult> {
    const previous = current.draft;
    const unchanged =
      previous !== undefined &&
      JSON.stringify([
        previous.sourceCustomerId,
        previous.customer,
        previous.address,
      ]) ===
        JSON.stringify([
          content.sourceCustomerId,
          content.customer,
          content.address,
        ]);
    const next: MinimalCheckoutDraft = unchanged
      ? previous
      : {
          schemaVersion: MINIMAL_CHECKOUT_DRAFT_SCHEMA_VERSION,
          senderId,
          revision: previous === undefined ? 0 : previous.revision + 1,
          ...content,
        };
    if (!unchanged) {
      if (!(await this.commit(senderId, current.raw, next))) {
        return { ok: false, error: 'draft_changed' };
      }
      // S3: a change invalidates the prior local confirmation.
      this.confirmation.revokeConfirmation(senderId);
    }
    const readiness = evaluateMinimalCheckoutReadiness(next);
    return { ok: true, ready: readiness.ready, missing: readiness.missing };
  }

  /** One CAS attempt; `false` never authorizes a retry. */
  private async commit(
    senderId: string,
    expected: unknown,
    next: MinimalCheckoutDraft,
  ): Promise<boolean> {
    if (typeof this.store.commitMinimalCheckoutDraft !== 'function') {
      return false;
    }
    try {
      return await this.store.commitMinimalCheckoutDraft(
        senderId,
        expected,
        next,
        new Date().toISOString(),
      );
    } catch {
      return false;
    }
  }

  /**
   * A saved snapshot is trusted only while its durable reference is live and a
   * fresh bounded read of the same page still holds the exact id and version.
   * An expired or retired reference requires a new lookup and selection.
   */
  private async revalidate(
    senderId: string,
    draft: MinimalCheckoutDraft,
  ): Promise<Revalidation> {
    if (draft.address.kind === 'new') return 'ok';
    try {
      return await this.revalidateReference(senderId, draft);
    } finally {
      this.addresses.touch(senderId);
    }
  }

  private async revalidateReference(
    senderId: string,
    draft: MinimalCheckoutDraft,
  ): Promise<Revalidation> {
    if (draft.address.kind === 'new') return 'ok';
    const reference = this.addresses.selected(senderId);
    const registry = this.addresses.registry(senderId);
    const phone = parseMexicanWhatsAppPhone(senderId);
    if (reference === undefined || registry === undefined || phone === null) {
      return 'reselect';
    }
    const resolved = registry.resolveAddress(reference);
    const snapshot = draft.address.snapshot;
    if (
      resolved === null ||
      resolved.customerId !== draft.sourceCustomerId ||
      resolved.address.id !== snapshot.id ||
      resolved.address.version !== snapshot.version
    ) {
      this.addresses.unselect(senderId);
      return 'reselect';
    }
    let fresh: unknown;
    try {
      fresh = await this.api.getCustomerCheckoutContext(
        phone.phoneCountryCode,
        phone.phone,
        { ...resolved.query },
      );
    } catch {
      return 'unavailable';
    }
    if (registry.revalidateAddress(reference, fresh) !== null) return 'ok';
    if (normalizeCustomerCheckoutContext(fresh)?.status !== 'unique') {
      return 'unavailable';
    }
    this.addresses.unselect(senderId);
    return 'reselect';
  }
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').toLowerCase() === b.replace(/\s+/g, ' ').toLowerCase();

/**
 * F3: a street equal to the current street plus the exterior number (the
 * rendered "Calle:" line copied back) is not a change; keeping it would show
 * the number twice. Only the current street is compared, so a dictated
 * street that legitimately ends in a number is kept.
 */
function dropStreetNumberEcho(
  values: Map<string, string>,
  draft: MinimalCheckoutDraft | undefined,
): void {
  const street = values.get('street');
  if (street === undefined || draft === undefined) return;
  const current =
    draft.address.kind === 'saved'
      ? draft.address.snapshot
      : draft.address.fields;
  const exterior = values.get('exteriorNumber') ?? current.exteriorNumber;
  if (current.street === null || exterior === null) return;
  if (/^s\/?n$/i.test(exterior.trim())) return;
  const echoes = [
    `${current.street} ${exterior}`,
    `${current.street} #${exterior}`,
    `${current.street} # ${exterior}`,
  ];
  if (echoes.some((echo) => sameText(echo, street)))
    values.set('street', current.street);
}

function invalid(): MinimalCheckoutDraftResult {
  return { ok: false, error: 'invalid_details' };
}

function revalidationReply(
  revalidation: Exclude<Revalidation, 'ok'>,
): MinimalCheckoutReply {
  return {
    reply:
      revalidation === 'reselect'
        ? MINIMAL_CHECKOUT_RESELECT_REPLY
        : MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY,
  };
}

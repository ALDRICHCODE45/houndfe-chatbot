import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { MinimalCheckoutAddressReferences } from '../../domain/minimal-checkout-address-references';

/** Customer identity read with the sender's last unique lookup page. */
export interface CheckoutAddressCustomer {
  readonly customerId: string;
  readonly firstName: string;
  readonly lastName: string | null;
}

const text = z.string().nullable();
const iso = z.iso.datetime();
const query = z.strictObject({
  limit: z.number().int().positive(),
  afterAddressId: z.string().nullable(),
});
const address = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  label: text,
  street: z.string(),
  exteriorNumber: text,
  interiorNumber: text,
  zipCode: text,
  neighborhood: text,
  municipality: text,
  city: text,
  state: text,
  visualReferences: text,
  carrierPhone: text,
});
const reference = z.string().min(1).max(64);
const payloadSchema = z.strictObject({
  addresses: z
    .array(
      z.strictObject({
        reference,
        customerId: z.string().min(1),
        address,
        query,
        ordinal: z.number().int().positive(),
        expiresAt: iso,
      }),
    )
    .max(100),
  pages: z
    .array(
      z.strictObject({
        reference,
        customerId: z.string().min(1),
        query,
        addressReferences: z.array(reference).max(100),
        nextPageReference: reference.nullable(),
        expiresAt: iso,
      }),
    )
    .max(100),
  nextPages: z
    .array(
      z.strictObject({
        reference,
        customerId: z.string().min(1),
        query,
        expiresAt: iso,
      }),
    )
    .max(100),
  selected: reference.nullable(),
  customer: z
    .strictObject({
      customerId: z.string().min(1),
      firstName: z.string(),
      lastName: z.string().nullable(),
    })
    .nullable(),
});

const toIso = (ms: number) => new Date(ms).toISOString();

/**
 * S4 durable `checkout_address` gate: the sender's saved-address reference
 * registry plus the selected reference and the customer read with it. The
 * row lives as long as its longest binding (five minutes from the last page
 * registered); each binding keeps its own expiry inside the payload.
 */
export class CheckoutAddressGate {
  private readonly registries = new Map<
    string,
    MinimalCheckoutAddressReferences
  >();
  private readonly selections = new Map<string, string>();
  private readonly customers = new Map<string, CheckoutAddressCustomer>();

  constructor(private readonly gates: ConversationGates) {
    gates.register({
      kind: 'checkout_address',
      read: (senderId) => this.read(senderId),
      write: (senderId, state) => {
        this.forget(senderId);
        if (state === null) return true;
        return this.restore(senderId, state.payload);
      },
    });
  }

  /** The sender's registry, created on first use. */
  registryFor(senderId: string): MinimalCheckoutAddressReferences {
    let registry = this.registries.get(senderId);
    if (registry === undefined) {
      registry = new MinimalCheckoutAddressReferences(senderId, this.gates.now);
      this.registries.set(senderId, registry);
    }
    return registry;
  }

  registry(senderId: string): MinimalCheckoutAddressReferences | undefined {
    return this.registries.get(senderId);
  }

  selected(senderId: string): string | undefined {
    return this.selections.get(senderId);
  }

  select(senderId: string, addressRef: string): void {
    this.selections.set(senderId, addressRef);
  }

  unselect(senderId: string): void {
    this.selections.delete(senderId);
  }

  customer(senderId: string): CheckoutAddressCustomer | undefined {
    return this.customers.get(senderId);
  }

  rememberCustomer(senderId: string, customer: CheckoutAddressCustomer): void {
    this.customers.set(senderId, { ...customer });
  }

  /** Schedule the write of whatever changed for the sender. */
  touch(senderId: string): void {
    this.gates.touch(senderId);
  }

  private read(senderId: string) {
    const state = this.registries.get(senderId)?.exportState() ?? null;
    if (state === null) return null;
    const expiries = [
      ...state.addresses,
      ...state.pages,
      ...state.nextPages,
    ].map((binding) => binding.expiresAt);
    return {
      payload: {
        addresses: state.addresses.map((b) => ({
          ...b,
          expiresAt: toIso(b.expiresAt),
        })),
        pages: state.pages.map((b) => ({
          ...b,
          expiresAt: toIso(b.expiresAt),
        })),
        nextPages: state.nextPages.map((b) => ({
          ...b,
          expiresAt: toIso(b.expiresAt),
        })),
        selected: this.selections.get(senderId) ?? null,
        customer: this.customers.get(senderId) ?? null,
      },
      expiresAt: Math.max(...expiries),
    };
  }

  private restore(senderId: string, payload: unknown): boolean {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) return false;
    const { addresses, pages, nextPages, selected, customer } = parsed.data;
    const fromIso = <T extends { expiresAt: string }>(binding: T) => ({
      ...binding,
      expiresAt: Date.parse(binding.expiresAt),
    });
    this.registries.set(
      senderId,
      MinimalCheckoutAddressReferences.restore(
        senderId,
        {
          addresses: addresses.map(fromIso),
          pages: pages.map(fromIso),
          nextPages: nextPages.map(fromIso),
        },
        this.gates.now,
      ),
    );
    if (selected !== null) this.selections.set(senderId, selected);
    if (customer !== null) this.customers.set(senderId, customer);
    return true;
  }

  private forget(senderId: string): void {
    this.registries.delete(senderId);
    this.selections.delete(senderId);
    this.customers.delete(senderId);
  }
}

/**
 * Pure minimal-route shipping, owned exclusively by `minimalCart.shipping`.
 * The backend chooses the carrier, computes the credit and signs `quoteId`
 * with `expiresAt` (S1-S3); this record stores that answer verbatim and pins
 * it to the cart lines (`cartPin`: identity, quantity, unit price and
 * evaluated line total) and the confirmed destination (`destinationPin`:
 * saved id/version or a SHA-256 of confirmed new-address fields). Only a
 * deliverable, unexpired quote whose pins still match may back an order.
 * Store pickup (S4) is the other record kind: `{mode: 'pickup', cartPin}`.
 * No clock, store, transport, framework or SDK dependency.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MinimalCheckoutDraftAddress } from '../../conversation/domain/minimal-checkout-draft';
import type { ShippingQuoteResponse } from '../../chatbot-api/domain/dtos/shipping-quote.dto';
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const iso = z.iso.datetime({ offset: true });
const cartLineSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  quantity: money.refine((value) => value > 0),
  unitPriceCents: money,
  finalPriceCents: money,
});
const cartLinesSchema = z
  .array(cartLineSchema)
  .min(1)
  .refine((lines) =>
    lines.every(
      (line, index) =>
        !lines
          .slice(0, index)
          .some(
            (other) =>
              line.productId === other.productId &&
              line.variantId === other.variantId,
          ),
    ),
  );
const destinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('saved'),
    addressId: z.uuid(),
    version: iso,
  }),
  z.strictObject({
    kind: z.literal('new'),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export type MinimalShippingDestination = z.infer<typeof destinationSchema>;

/** Fixed-order, lossless canonical content; never normalize away an address edit. */
export function minimalShippingDestination(
  address: MinimalCheckoutDraftAddress,
): MinimalShippingDestination {
  if (address.kind === 'saved') {
    return {
      kind: 'saved',
      addressId: address.snapshot.id,
      version: address.snapshot.version,
    };
  }
  const f = address.fields;
  return {
    kind: 'new',
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          f.street,
          f.exteriorNumber,
          f.interiorNumber,
          f.zipCode,
          f.neighborhood,
          f.municipality,
          f.city,
          f.state,
        ]),
      )
      .digest('hex'),
  };
}

const deliverableZones: ReadonlySet<string> = new Set([
  'FREE',
  'SURCHARGE',
  'CARRIER_ONLY',
]);
/**
 * Mirrors the backend DTO so every accepted response re-parses from the slot.
 * PENDING/DENIED carry null quoteId and expiresAt; older slots may lack
 * `eta.reason` or store `eta: null`.
 */
export const minimalShippingQuoteSchema = z
  .strictObject({
    quoteId: z.string().min(1).nullable(),
    expiresAt: iso.nullable(),
    zoneStatus: z.enum([
      'FREE',
      'SURCHARGE',
      'CARRIER_ONLY',
      'PENDING',
      'DENIED',
    ]),
    option: z
      .strictObject({
        carrier: z.string().min(1),
        service: z.string().min(1),
        etaDays: money.nullable(),
      })
      .nullable(),
    costCents: money,
    creditCents: money,
    customerChargeCents: money,
    currency: z.literal('MXN'),
    eta: z
      .strictObject({
        days: money.nullable(),
        reason: z.literal('STOCK_PENDING').nullable().optional(),
      })
      .nullable(),
    destinationPin: destinationSchema,
    cartPin: cartLinesSchema,
  })
  .refine(
    (record) =>
      !deliverableZones.has(record.zoneStatus) ||
      (record.quoteId !== null && record.expiresAt !== null),
  );
export type MinimalShippingQuote = z.infer<typeof minimalShippingQuoteSchema>;
export type MinimalShippingCartLine = z.infer<typeof cartLineSchema>;

/** Store the backend answer as returned; anything off-schema => null. */
export function buildMinimalShippingQuote(input: {
  response: ShippingQuoteResponse;
  cartLines: readonly MinimalShippingCartLine[];
  destination: MinimalShippingDestination;
}): MinimalShippingQuote | null {
  const r = input.response;
  const result = minimalShippingQuoteSchema.safeParse({
    quoteId: r.quoteId,
    expiresAt: r.expiresAt,
    zoneStatus: r.zoneStatus,
    option: r.option,
    costCents: r.costCents,
    creditCents: r.creditCents,
    customerChargeCents: r.customerChargeCents,
    currency: r.currency,
    eta: r.eta ?? null,
    destinationPin: input.destination,
    cartPin: input.cartLines,
  });
  return result.success ? structuredClone(result.data) : null;
}

/**
 * Store pickup (S4): no carrier and no shipping charge. Pinned to the cart
 * lines only, so any cart change invalidates it like a quote.
 */
export const minimalPickupSchema = z.strictObject({
  mode: z.literal('pickup'),
  cartPin: cartLinesSchema,
});
export type MinimalPickup = z.infer<typeof minimalPickupSchema>;

/** Pickup record for exactly these verified lines; invalid lines => null. */
export function buildMinimalPickup(
  cartLines: readonly MinimalShippingCartLine[],
): MinimalPickup | null {
  const result = minimalPickupSchema.safeParse({
    mode: 'pickup',
    cartPin: cartLines,
  });
  return result.success ? structuredClone(result.data) : null;
}

/** Store pickup vs. backend quote. */
export function isMinimalPickup(
  record: MinimalShippingQuote | MinimalPickup,
): record is MinimalPickup {
  return 'mode' in record && record.mode === 'pickup';
}

/** Same lines and quantities as the pin, in any order; prices too unless `ignorePrices`. */
function sameCartPin(
  pin: readonly MinimalShippingCartLine[],
  cartLines: readonly MinimalShippingCartLine[],
  ignorePrices = false,
): boolean {
  const lines = cartLinesSchema.safeParse(cartLines);
  return (
    lines.success &&
    lines.data.length === pin.length &&
    pin.every((line) =>
      lines.data.some(
        (other) =>
          line.productId === other.productId &&
          line.variantId === other.variantId &&
          line.quantity === other.quantity &&
          (ignorePrices ||
            (line.unitPriceCents === other.unitPriceCents &&
              line.finalPriceCents === other.finalPriceCents)),
      ),
    )
  );
}

/**
 * A pickup choice backs an order while the same products and quantities
 * remain. Pickup has no price-dependent charge, so a price or promotion
 * change keeps it and the order re-presents the updated summary (L13).
 */
export function isPickupCurrent(
  record: MinimalPickup,
  cartLines: readonly MinimalShippingCartLine[],
): boolean {
  return sameCartPin(record.cartPin, cartLines, true);
}

/** Business days from the backend, or the STOCK_PENDING reason (S7). */
export function minimalShippingEta(
  record: Pick<MinimalShippingQuote, 'eta' | 'option'>,
): { days: number | null; reason?: 'STOCK_PENDING' } | null {
  if (record.eta?.reason === 'STOCK_PENDING')
    return { days: null, reason: 'STOCK_PENDING' };
  const days = record.eta?.days ?? record.option?.etaDays ?? null;
  return days === null ? null : { days };
}

/** Customer ETA sentence, or null when the backend gave none. */
export function minimalShippingEtaLine(
  eta: { days: number | null; reason?: 'STOCK_PENDING' } | null | undefined,
): string | null {
  if (eta?.reason === 'STOCK_PENDING')
    return 'La fecha de entrega depende de la reposición de existencias; se la confirmamos en cuanto la tengamos.';
  if (eta === null || eta === undefined || eta.days === null) return null;
  return eta.days === 1
    ? 'Llega en aproximadamente 1 día hábil.'
    : `Llega en aproximadamente ${eta.days} días hábiles.`;
}

/**
 * `current` only for a deliverable zone with a quoteId, strictly before the
 * backend `expiresAt`, whose cart and destination pins match exactly.
 */
export function isShippingCurrent(
  record: MinimalShippingQuote,
  context: {
    cartLines: readonly MinimalShippingCartLine[];
    address: MinimalCheckoutDraftAddress;
    nowMs: number;
  },
): 'current' | 'expired' | 'stale' | 'undeliverable' {
  if (
    !deliverableZones.has(record.zoneStatus) ||
    record.quoteId === null ||
    record.expiresAt === null
  )
    return 'undeliverable';
  if (
    !Number.isFinite(context.nowMs) ||
    context.nowMs >= Date.parse(record.expiresAt)
  )
    return 'expired';
  const current = minimalShippingDestination(context.address);
  const pin = record.destinationPin;
  const sameDestination =
    pin.kind === 'new'
      ? current.kind === 'new' && current.fingerprint === pin.fingerprint
      : current.kind === 'saved' &&
        current.addressId === pin.addressId &&
        current.version === pin.version;
  return sameDestination && sameCartPin(record.cartPin, context.cartLines)
    ? 'current'
    : 'stale';
}

import { z } from 'zod';
import { isCheckoutUuid } from './checkout-context.dto';

/** The quote already backs another sale; nothing was written (no saleId). */
export const SHIPPING_QUOTE_ALREADY_USED = 'SHIPPING_QUOTE_ALREADY_USED';
/** Bad or mixed shipping shape; nothing was written. */
export const INVALID_CHECKOUT_REQUEST = 'INVALID_CHECKOUT_REQUEST';

const uuid = z.string().refine(isCheckoutUuid, 'Invalid checkout UUID');
const cents = z.number().int().min(0).max(2147483647);
const identifier = z.string().trim().min(1).max(200);
/** A backend-signed quote, or store pickup; the backend computes the charge. */
const shipping = z.union([
  z.object({ quoteId: identifier }).strict(),
  z.object({ mode: z.literal('pickup') }).strict(),
]);
const instant = z.string().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, 'Invalid canonical instant');

const address = z
  .object({
    street: z.string().min(1).max(200),
    label: z.string().max(100).optional(),
    exteriorNumber: z.string().max(20).optional(),
    interiorNumber: z.string().max(20).optional(),
    zipCode: z.string().max(10).optional(),
    neighborhood: z.string().max(100).optional(),
    municipality: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    // The Mexican-state enum is backend-owned, as on the existing customer DTO.
    state: z.string().max(100).optional(),
    visualReferences: z.string().max(500).optional(),
    carrierPhone: z.string().max(20).optional(),
  })
  .strict();

/**
 * Atomic intent: no legacy upsert or sale-only fields are accepted. Store
 * pickup sends no deliveryAddress; every other checkout requires one.
 */
export const CreateCheckoutInputSchema = z
  .object({
    phoneCountryCode: z.string().regex(/^[0-9]{1,10}$/),
    phone: z.string().regex(/^[0-9]{1,20}$/),
    customer: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('createIfAbsent'),
          firstName: z.string().min(1).max(100),
          lastName: z.string().max(100).optional(),
        })
        .strict(),
      z.object({ mode: z.literal('existing'), customerId: uuid }).strict(),
    ]),
    deliveryAddress: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('newSaved'), address }).strict(),
        z
          .object({
            mode: z.literal('existingUpdated'),
            addressId: uuid,
            expectedVersion: instant,
            address,
          })
          .strict(),
        z
          .object({
            mode: z.literal('existing'),
            addressId: uuid,
            expectedVersion: instant,
          })
          .strict(),
      ])
      .optional(),
    sale: z
      .object({
        cashierUserId: uuid,
        items: z
          .array(
            z
              .object({
                productId: uuid,
                variantId: uuid.nullish(),
                productName: z.string().min(1),
                variantName: z.string().nullish(),
                quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
                unitPriceCents: cents,
              })
              .strict(),
          )
          .min(1),
        expectedTotalCents: cents,
        shipping: shipping.optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (input) =>
      (input.sale.shipping !== undefined && 'mode' in input.sale.shipping) ===
      (input.deliveryAddress === undefined),
    'Pickup sends no deliveryAddress; delivery requires one',
  );

export type CreateCheckoutInput = z.infer<typeof CreateCheckoutInputSchema>;

/** Header-only key; never put it into URLs, messages or query parameters. */
export const CheckoutIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x20-\x7e]+$/);

const saleBase = {
  saleId: uuid,
  folio: z.string().nullable(),
  paymentStatus: z.enum(['CREDIT', 'PARTIAL', 'PAID']),
  channel: z.string().min(1),
  deliveryStatus: z.string().min(1),
  totalCents: cents,
  discountCents: cents,
  paidCents: cents,
  debtCents: cents,
  confirmedAt: instant.nullable(),
};
/** Quote-backed delivery: merchandise subtotal plus the shipping charge. */
const deliverySale = z
  .object({
    ...saleBase,
    subtotalCents: cents,
    shippingChargeCents: cents,
    fulfillmentMode: z.literal('DELIVERY'),
  })
  .strict();
const pickupSale = z
  .object({ ...saleBase, fulfillmentMode: z.literal('PICKUP') })
  .strict();

const text = z.string().min(1);
/** Branch shipping origin, or the free-text sucursal address (`formatted` only). */
const pickupAddress = z
  .object({
    addressLine1: text.nullable(),
    addressLine2: text.nullable(),
    neighborhood: text.nullable(),
    municipality: text.nullable(),
    state: text.nullable(),
    postalCode: text.nullable(),
    formatted: text,
  })
  .strict();
const clock = z.string().regex(/^[0-9]{2}:[0-9]{2}$/);
const pickupHours = z
  .object({
    timeZone: text,
    days: z.array(
      z
        .object({
          day: z.enum([
            'MONDAY',
            'TUESDAY',
            'WEDNESDAY',
            'THURSDAY',
            'FRIDAY',
            'SATURDAY',
            'SUNDAY',
          ]),
          label: text,
          closed: z.boolean(),
          ranges: z.array(z.object({ open: clock, close: clock }).strict()),
        })
        .strict(),
    ),
    summary: text,
  })
  .strict();
const pickupLocation = z
  .object({
    name: text,
    address: pickupAddress.nullable(),
    hours: pickupHours.nullable(),
  })
  .strict();
export type CheckoutPickupLocation = z.infer<typeof pickupLocation>;

const customerResponse = z
  .object({
    resolution: z.enum(['created', 'existing']),
    customerId: uuid,
    firstName: z.string(),
    lastName: z.string().nullable(),
  })
  .strict();
const addressResponse = z
  .object({
    resolution: z.enum(['created', 'existing', 'updated']),
    id: uuid,
    version: instant,
  })
  .strict();

/** Exactly the documented keys per fulfillment mode (checkout-shipping.md). */
const checkoutResponse = z.union([
  z
    .object({
      status: z.literal('created'),
      customer: customerResponse,
      address: addressResponse,
      sale: deliverySale,
    })
    .strict(),
  z
    .object({
      status: z.literal('created'),
      customer: customerResponse,
      address: z.null(),
      sale: pickupSale,
      pickupLocation,
    })
    .strict(),
]);
export type CheckoutResponse = z.infer<typeof checkoutResponse>;

const checkoutStatus = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('succeeded'), checkout: checkoutResponse })
    .strict(),
  z.object({ status: z.literal('not_observed'), checkout: z.null() }).strict(),
]);
/** not_observed is NOT proof of rollback; callers must retain the same key. */
export type CheckoutStatus = z.infer<typeof checkoutStatus>;

export function normalizeCheckoutResponse(
  body: unknown,
): CheckoutResponse | null {
  const parsed = checkoutResponse.safeParse(body);
  return parsed.success ? parsed.data : null;
}
export function normalizeCheckoutStatus(body: unknown): CheckoutStatus | null {
  const parsed = checkoutStatus.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** `mismatches[]` of a SHIPPING_QUOTE_MISMATCH error body; `[]` when absent. */
export function checkoutErrorMismatches(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('mismatches' in body))
    return [];
  const { mismatches } = body;
  return Array.isArray(mismatches)
    ? mismatches.filter((part): part is string => typeof part === 'string')
    : [];
}

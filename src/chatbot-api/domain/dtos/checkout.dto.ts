import { z } from 'zod';
import { isCheckoutUuid } from './checkout-context.dto';
import { BotSaleShippingInputSchema } from './sales.dto';

const uuid = z.string().refine(isCheckoutUuid, 'Invalid checkout UUID');
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
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

/** Atomic intent: no legacy upsert or sale-only fields are accepted. */
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
    deliveryAddress: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('newSaved'), address }).strict(),
      z
        .object({
          mode: z.literal('existing'),
          addressId: uuid,
          expectedVersion: instant,
        })
        .strict(),
    ]),
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
        shipping: BotSaleShippingInputSchema.strict().optional(),
      })
      .strict()
      .refine((sale) => !sale.shipping || sale.expectedTotalCents > 0, {
        path: ['expectedTotalCents'],
        message: 'expectedTotalCents must be positive when shipping is charged',
      }),
  })
  .strict();

export type CreateCheckoutInput = z.infer<typeof CreateCheckoutInputSchema>;

/** Header-only key; never put it into URLs, messages or query parameters. */
export const CheckoutIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);

const saleResponse = z
  .object({
    saleId: uuid,
    folio: z.string().nullable(),
    paymentStatus: z.enum(['CREDIT', 'PARTIAL', 'PAID']),
    channel: z.string().min(1),
    deliveryStatus: z.string().min(1),
    totalCents: cents,
    subtotalCents: cents.optional(),
    shippingChargeCents: cents.optional(),
    paidCents: cents,
    debtCents: cents,
    confirmedAt: instant.nullable(),
    discountCents: cents.default(0),
  })
  .strict();

const checkoutResponse = z
  .object({
    status: z.literal('created'),
    customer: z
      .object({
        // L16 leaves resolution vocabulary opaque; do not infer business state.
        resolution: z.string().min(1),
        customerId: uuid,
        firstName: z.string(),
        lastName: z.string().nullable(),
      })
      .strict(),
    address: z
      .object({ resolution: z.string().min(1), id: uuid, version: instant })
      .strict(),
    sale: saleResponse,
  })
  .strict();
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

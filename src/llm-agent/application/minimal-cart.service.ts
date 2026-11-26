import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import type { CartItem, CartPet } from '../../sale-flow/domain/cart-state';
import type { BackorderBot } from '../../backorders/domain/backorder';
import { backorderDateTime } from '../domain/backorder-copy';
import type { CartEvaluationResult } from '../../chatbot-api/domain/dtos/pricing.dto';
import { CheckoutPickupLocationSchema } from '../../chatbot-api/domain/dtos/checkout.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  isMinimalPickup,
  minimalPickupSchema,
  minimalShippingQuoteSchema,
} from '../domain/minimal-shipping';
import { minimalItemLines } from '../domain/minimal-order-confirmation';
import {
  bold,
  money as formatMoney,
  sectionTitle,
} from '../domain/whatsapp-format';

// Restock backorder T5b: what a backorder line remembers of its reservation.
const backorderRefSchema = z.strictObject({
  id: z.uuid(),
  folio: z.string().min(1),
  productName: z.string().min(1),
  variantName: z.string().nullable(),
  reservedUntil: z.iso.datetime({ offset: true }),
});
/** Longest pet name the backend accepts (contract §2: name 1-60). */
export const CART_PET_NAME_MAX = 60;
// Multi-pet T5a (S16, S17): a backend pet of the customer (UUID, never a
// local or legacy ref) with its display name.
const cartPetSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(CART_PET_NAME_MAX).regex(/\S/),
});
const lineSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  // Present only on the line of a RESERVED backorder (priced at its final
  // price); absent on every ordinary line.
  backorder: backorderRefSchema.optional(),
  // Multi-pet T5a: the backend pet this line is for (checkout `petId`).
  // Absent on pet-less lines and on every backorder line.
  pet: cartPetSchema.optional(),
});
// Last order created by the minimal route; informational, never a sale input.
const placedSaleSchema = z.strictObject({
  saleId: z.string().min(1),
  folio: z.string().nullable(),
  totalCents: z.number().int().nonnegative(),
  // The customer chose to pay but the bank details could not be read; the
  // team was asked once. Absent in orders stored before the payment step.
  paymentPending: z.literal(true).optional(),
  // The receipt outcome poller saw a CONFIRMED receipt with no debt left.
  // Absent in orders stored before this field: absent means unpaid.
  paid: z.literal(true).optional(),
  // Pay in store S3: a store-pickup order placed with PAY_IN_STORE_ENABLED.
  // Its checkout key reads the live hold (GET /checkouts/status) and the
  // branch is named in the replies. Absent: no «Pagar en tienda» offer.
  pickup: z
    .strictObject({
      checkoutKey: z.uuid(),
      location: CheckoutPickupLocationSchema.nullable(),
      // Follow-ups S7: the customer held the order to pay in store (the
      // PATCH payment-intent succeeded). A later receipt refused with
      // SALE_NOT_PAYABLE then explains the hold expiry. Absent: not held.
      held: z.literal(true).optional(),
    })
    .optional(),
});
const cartSchema = z.strictObject({
  items: z.array(lineSchema),
  // '' = no order attempt in flight; a UUID = the order's X-Idempotency-Key.
  idempotencyKey: z.union([z.literal(''), z.uuid()]),
  // SHA-256 of the sale payload first sent under `idempotencyKey`.
  idempotencyFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  // Sale calls made under `idempotencyKey`, persisted BEFORE each call.
  idempotencyAttempts: z.number().int().positive().optional(),
  expectedTotalCents: z.number().int().nonnegative().optional(),
  placedSale: placedSaleSchema.optional(),
  // Backend-signed quote or store pickup.
  shipping: z
    .union([minimalShippingQuoteSchema, minimalPickupSchema])
    .optional(),
  // Multi-pet T5a (S17): the pet the customer chose in the which-pet
  // question; lines added or changed afterwards are for it. Cleared with
  // the cart when the order is placed. Absent: no choice.
  currentPet: cartPetSchema.optional(),
});
export type MinimalCartState = z.infer<typeof cartSchema>;

/** Validate the owned `minimalCart` slot; absent means an empty cart. */
export function parseMinimalCart(raw: unknown): MinimalCartState | null {
  if (raw === undefined) return { items: [], idempotencyKey: '' };
  const parsed = cartSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (
    parsed.data.items.some((i, index, items) =>
      items.slice(0, index).some((j) => sameLine(i, j)),
    )
  )
    return null;
  return parsed.data;
}
export const minimalCartInput = lineSchema
  .omit({ unitPriceCents: true, backorder: true, pet: true })
  .extend({
    quantity: z.number().int().nonnegative(),
  });
export type MinimalCartInput = z.infer<typeof minimalCartInput>;
export const minimalCartAdjustmentInput = minimalCartInput
  .omit({ quantity: true })
  .extend({
    delta: z
      .number()
      .int()
      .refine((value) => value !== 0),
  });
export type MinimalCartAdjustmentInput = z.infer<
  typeof minimalCartAdjustmentInput
>;
type QuotedItem = CartItem & {
  name: string;
  variantName?: string;
  finalPriceCents: number;
  appliedPromotionTitle: string | null;
  discountAmountCents: number;
};
export type MinimalCartResult =
  | { ok: false; error: string }
  | {
      ok: true;
      items: QuotedItem[];
      totalCents: number;
      promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
      /**
       * Restock backorder T5b: set only by a write that removed a backorder
       * line; the backorder itself stays reserved until `reservedUntil`.
       */
      removedBackorders?: Array<{ folio: string; reservedUntil: string }>;
    };
/** Synchronous, observational-only callback; never returned to the model or stored. */
export type MinimalCartVariantDiagnostic = {
  linePosition: number;
  lineOrigin: 'requested' | 'stored';
  catalogVariantFound: boolean;
  stockVariantFound: boolean;
  variantIsProductId: boolean;
};
type VariantDiagnosticObserver = (event: MinimalCartVariantDiagnostic) => void;

/**
 * The same cart line. A backorder line is never the same line as an ordinary
 * one of the same product (and two backorder lines differ by backorder), so
 * an ordinary request never merges into it or changes it.
 */
const sameLine = (
  a: Pick<CartItem, 'productId' | 'variantId' | 'backorder'>,
  b: Pick<CartItem, 'productId' | 'variantId' | 'backorder'>,
) =>
  a.productId === b.productId &&
  a.variantId === b.variantId &&
  a.backorder?.id === b.backorder?.id;
const sameProduct = (
  a: Pick<CartItem, 'productId' | 'variantId'>,
  b: Pick<CartItem, 'productId' | 'variantId'>,
) => a.productId === b.productId && a.variantId === b.variantId;
/**
 * The stored shape of a quoted line; a backorder line keeps its reservation
 * and a pet line its pet.
 */
const storedLine = ({
  productId,
  variantId,
  quantity,
  unitPriceCents,
  backorder,
  pet,
}: QuotedItem): CartItem => ({
  productId,
  ...(variantId ? { variantId } : {}),
  quantity,
  unitPriceCents,
  ...(backorder ? { backorder } : {}),
  ...(pet ? { pet } : {}),
});
/** The cart after a line write: fresh lines and total, no order key or
 * shipping, the customer's current pet kept. */
const rewritten = (
  cart: MinimalCartState,
  quote: Extract<MinimalCartResult, { ok: true }>,
): MinimalCartState => ({
  items: quote.items.map(storedLine),
  idempotencyKey: '',
  expectedTotalCents: quote.totalCents,
  ...(cart.currentPet === undefined ? {} : { currentPet: cart.currentPet }),
});
/**
 * Multi-pet T5a: the pet of a cart write, normalized and valid, else
 * `undefined` (the line gets no pet; an invalid pet never reaches the store,
 * where it would make the cart unreadable).
 */
function validPet(pet: CartPet | null | undefined): CartPet | undefined {
  if (pet === null || pet === undefined) return undefined;
  const parsed = cartPetSchema.safeParse({
    id: pet.id,
    name:
      typeof pet.name === 'string'
        ? pet.name.replace(/\s+/g, ' ').trim()
        : pet.name,
  });
  return parsed.success ? parsed.data : undefined;
}
/**
 * Multi-pet T5a R3 (S9): one line per product (and presentation). A new line
 * is for `pet`; fewer units keep the line's pet; more units keep it only
 * when they are for the same pet; another pet, or a pet and no pet, make it
 * one line without pet (the backend refuses lines that disagree).
 */
function mergedPet(
  existing: CartItem | undefined,
  pet: CartPet | undefined,
  quantity: number,
): CartPet | undefined {
  if (existing === undefined) return pet;
  if (quantity <= existing.quantity) return existing.pet;
  return existing.pet !== undefined && existing.pet.id === pet?.id
    ? existing.pet
    : undefined;
}
const money = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Cart only: no reservation, sale or payment calls. Prices are server-derived. */
@Injectable()
export class MinimalCartService {
  constructor(
    @Inject(CHATBOT_API_CLIENT) private readonly api: ChatbotApiClient,
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
  ) {}

  async view(
    senderId: string,
    onInvalidVariant?: VariantDiagnosticObserver,
  ): Promise<MinimalCartResult> {
    try {
      const raw = (await this.store.get(senderId))?.data.minimalCart;
      const cart = this.read(raw);
      if (!cart) return { ok: false, error: 'invalid_cart' };
      return await this.quote(senderId, cart.items, onInvalidVariant);
    } catch {
      return { ok: false, error: 'cart_unavailable' };
    }
  }

  /** Stored line identities (and units) without a backend read; `[]` when
   *  unreadable. */
  async storedLines(
    senderId: string,
  ): Promise<Array<Pick<CartItem, 'productId' | 'variantId' | 'quantity'>>> {
    try {
      const cart = this.read(
        (await this.store.get(senderId))?.data.minimalCart,
      );
      return (cart?.items ?? []).map(({ productId, variantId, quantity }) => ({
        productId,
        ...(variantId ? { variantId } : {}),
        quantity,
      }));
    } catch {
      return [];
    }
  }

  /**
   * S2: identity of the stored cart lines (product, presentation, quantity),
   * so a cart-summary button is honoured only for the cart it was sent with.
   * `null` when the cart is unreadable.
   */
  async fingerprint(senderId: string): Promise<string | null> {
    try {
      const cart = this.read(
        (await this.store.get(senderId))?.data.minimalCart,
      );
      return cart === null ? null : minimalCartFingerprint(cart.items);
    } catch {
      return null;
    }
  }

  /** The stored shipping choice, if any; `null` when none or unreadable. */
  async shippingMode(senderId: string): Promise<'pickup' | 'delivery' | null> {
    try {
      const shipping = parseMinimalCart(
        (await this.store.get(senderId))?.data.minimalCart,
      )?.shipping;
      if (shipping === undefined) return null;
      return isMinimalPickup(shipping) ? 'pickup' : 'delivery';
    } catch {
      return null;
    }
  }

  /**
   * Quote the stored lines and, when only their prices or total changed,
   * store the fresh unit prices and total in one CAS, keeping shipping and
   * every other field; never retry. A cart with an outstanding order key is
   * never rewritten. `repriced` means this call committed a rewrite.
   */
  async refreshPrices(
    senderId: string,
  ): Promise<{ quote: MinimalCartResult; repriced: boolean }> {
    try {
      // Keep the EXACT raw slot for CAS, never the zod-parsed reconstruction.
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      if (!cart)
        return { quote: { ok: false, error: 'invalid_cart' }, repriced: false };
      const quote = await this.quote(senderId, cart.items);
      if (
        !quote.ok ||
        cart.idempotencyKey !== '' ||
        (cart.items.every(
          (line, index) =>
            line.unitPriceCents === quote.items[index].unitPriceCents,
        ) &&
          (cart.expectedTotalCents === undefined ||
            cart.expectedTotalCents === quote.totalCents))
      )
        return { quote, repriced: false };
      const next: MinimalCartState = structuredClone({
        ...cart,
        items: quote.items.map(storedLine),
        expectedTotalCents: quote.totalCents,
      });
      if (!this.store.commitMinimalCart)
        return {
          quote: { ok: false, error: 'cart_unavailable' },
          repriced: false,
        };
      const saved = await this.store.commitMinimalCart(
        senderId,
        raw,
        next,
        new Date().toISOString(),
      );
      return saved
        ? { quote, repriced: true }
        : { quote: { ok: false, error: 'cart_changed' }, repriced: false };
    } catch {
      return {
        quote: { ok: false, error: 'cart_unavailable' },
        repriced: false,
      };
    }
  }

  /** Quantity is the desired TOTAL for this line, not an increment; zero removes. */
  /** `pet`: the customer's current pet (T5a R2); never model input. */
  async setItem(
    senderId: string,
    input: MinimalCartInput,
    allowedIds: ReadonlySet<string>,
    onInvalidVariant?: VariantDiagnosticObserver,
    pet?: CartPet,
  ): Promise<MinimalCartResult> {
    return this.changeItem(
      senderId,
      input,
      allowedIds,
      'set',
      onInvalidVariant,
      pet,
    );
  }

  /** Apply a signed unit delta to the same snapshot used by CAS; never retry it. */
  async adjustItem(
    senderId: string,
    input: MinimalCartAdjustmentInput,
    allowedIds: ReadonlySet<string>,
    onInvalidVariant?: VariantDiagnosticObserver,
    pet?: CartPet,
  ): Promise<MinimalCartResult> {
    return this.changeItem(
      senderId,
      input,
      allowedIds,
      'adjust',
      onInvalidVariant,
      pet,
    );
  }

  /** T5a R2 (S17): the pet the customer chose for this cart, or `null`. */
  async currentPet(senderId: string): Promise<CartPet | null> {
    try {
      return (
        this.read((await this.store.get(senderId))?.data.minimalCart)
          ?.currentPet ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * T5a R2 (S17): remember (or, with `null`, forget) the pet the customer
   * chose, in one CAS that keeps every other field; never retried. Refused
   * (`false`) for an invalid pet, an unreadable cart or an order in flight.
   */
  async setCurrentPet(senderId: string, pet: CartPet | null): Promise<boolean> {
    try {
      const chosen = pet === null ? null : validPet(pet);
      if (chosen === undefined) return false;
      const raw = structuredClone(
        (await this.store.get(senderId))?.data.minimalCart,
      );
      const cart = this.read(raw);
      if (!cart || cart.idempotencyKey !== '') return false;
      const current = cart.currentPet;
      if (
        chosen === null
          ? current === undefined
          : current?.id === chosen.id && current.name === chosen.name
      )
        return true;
      const next: MinimalCartState = structuredClone({ ...cart });
      if (chosen === null) delete next.currentPet;
      else next.currentPet = chosen;
      if (!this.store.commitMinimalCart) return false;
      return await this.store.commitMinimalCart(
        senderId,
        raw,
        next,
        new Date().toISOString(),
      );
    } catch {
      return false;
    }
  }

  /** Retain exact existing pairs with unchanged quantities, in one CAS; never retry. */
  async keepOnly(
    senderId: string,
    keep: Array<Pick<CartItem, 'productId' | 'variantId'>>,
  ): Promise<MinimalCartResult> {
    try {
      const raw = structuredClone(
        (await this.store.get(senderId))?.data.minimalCart,
      );
      const cart = this.read(raw);
      if (!cart) return { ok: false, error: 'invalid_cart' };
      if (cart.idempotencyKey !== '')
        return { ok: false, error: 'order_unresolved' };
      if (
        keep.length === 0 ||
        keep.some(
          (identity) => !cart.items.some((line) => sameProduct(line, identity)),
        )
      )
        return { ok: false, error: 'unknown_cart_line' };
      const items = cart.items.filter((line) =>
        keep.some((identity) => sameProduct(line, identity)),
      );
      const dropped = cart.items.filter((line) => !items.includes(line));
      const quote = await this.quote(senderId, items);
      if (!quote.ok || items.length === cart.items.length) return quote;
      const next = rewritten(cart, quote);
      if (!this.store.commitMinimalCart)
        return { ok: false, error: 'cart_unavailable' };
      const saved = await this.store.commitMinimalCart(
        senderId,
        raw,
        next,
        new Date().toISOString(),
      );
      return saved
        ? withRemovedBackorders(quote, dropped)
        : { ok: false, error: 'cart_changed' };
    } catch {
      return { ok: false, error: 'cart_unavailable' };
    }
  }

  /** Quote lines with today's stock and prices, without writing the cart. */
  async preview(
    senderId: string,
    lines: Array<Pick<CartItem, 'productId' | 'variantId' | 'quantity'>>,
  ): Promise<MinimalCartResult> {
    try {
      return await this.quote(
        senderId,
        lines.map((line) => ({ ...line, unitPriceCents: 0 })),
      );
    } catch {
      return { ok: false, error: 'cart_unavailable' };
    }
  }

  /**
   * S2 reorder: add server-owned lines (the customer's own last order) in one
   * CAS, each quantity on top of the line already in the cart; all or
   * nothing, never retried. No `allowedIds`: the lines never come from the
   * model.
   */
  async addItems(
    senderId: string,
    lines: Array<Pick<CartItem, 'productId' | 'variantId' | 'quantity'>>,
    /** T5a R2: the customer's current pet; never model input. */
    pet?: CartPet,
  ): Promise<MinimalCartResult> {
    try {
      if (
        lines.length === 0 ||
        lines.some(
          (line) =>
            !minimalCartAdjustmentInput.safeParse({
              productId: line.productId,
              ...(line.variantId ? { variantId: line.variantId } : {}),
              delta: line.quantity,
            }).success || line.quantity < 1,
        )
      )
        return { ok: false, error: 'invalid_quantity_or_identity' };
      const raw = structuredClone(
        (await this.store.get(senderId))?.data.minimalCart,
      );
      const cart = this.read(raw);
      if (!cart) return { ok: false, error: 'invalid_cart' };
      if (cart.idempotencyKey !== '')
        return { ok: false, error: 'order_unresolved' };
      const tag = validPet(pet);
      const items: CartItem[] = cart.items.map((item) => ({ ...item }));
      for (const line of lines) {
        const identity = {
          productId: line.productId,
          ...(line.variantId ? { variantId: line.variantId } : {}),
        };
        const existing = items.find((item) => sameLine(item, identity));
        if (existing) {
          const merged = mergedPet(
            existing,
            tag,
            existing.quantity + line.quantity,
          );
          existing.quantity += line.quantity;
          if (merged === undefined) delete existing.pet;
          else existing.pet = merged;
        } else
          items.push({
            ...identity,
            quantity: line.quantity,
            unitPriceCents: 0,
            ...(tag === undefined ? {} : { pet: tag }),
          });
      }
      if (items.some((item) => !Number.isSafeInteger(item.quantity)))
        return { ok: false, error: 'invalid_quantity_or_identity' };
      const quote = await this.quote(senderId, items);
      if (!quote.ok) return quote;
      const next = rewritten(cart, quote);
      if (!this.store.commitMinimalCart)
        return { ok: false, error: 'cart_unavailable' };
      const saved = await this.store.commitMinimalCart(
        senderId,
        raw,
        next,
        new Date().toISOString(),
      );
      return saved ? quote : { ok: false, error: 'cart_changed' };
    } catch {
      return { ok: false, error: 'cart_unavailable' };
    }
  }

  /**
   * Restock backorder T5b: put the customer's RESERVED backorder in the cart
   * as its own line, priced at the backorder's `finalPriceCents` with the
   * quantity it was reserved for. Never merges into an ordinary line of the
   * same product. Adding the same backorder twice keeps one line (no write).
   * One CAS, never retried; an outstanding order key blocks it like any cart
   * change.
   */
  async addBackorderLine(
    senderId: string,
    backorder: Pick<
      BackorderBot,
      | 'id'
      | 'folio'
      | 'productId'
      | 'productName'
      | 'variantId'
      | 'variantName'
      | 'quantity'
      | 'finalPriceCents'
      | 'reservedUntil'
    >,
  ): Promise<MinimalCartResult> {
    try {
      const { finalPriceCents, reservedUntil } = backorder;
      if (
        finalPriceCents === null ||
        reservedUntil === null ||
        !money(finalPriceCents) ||
        !money(finalPriceCents * backorder.quantity)
      )
        return { ok: false, error: 'invalid_quantity_or_identity' };
      const raw = structuredClone(
        (await this.store.get(senderId))?.data.minimalCart,
      );
      const cart = this.read(raw);
      if (!cart) return { ok: false, error: 'invalid_cart' };
      if (cart.idempotencyKey !== '')
        return { ok: false, error: 'order_unresolved' };
      if (cart.items.some((item) => item.backorder?.id === backorder.id))
        return await this.quote(senderId, cart.items);
      const line: CartItem = {
        productId: backorder.productId,
        ...(backorder.variantId === null
          ? {}
          : { variantId: backorder.variantId }),
        quantity: backorder.quantity,
        unitPriceCents: finalPriceCents,
        backorder: {
          id: backorder.id,
          folio: backorder.folio,
          productName: backorder.productName,
          variantName: backorder.variantName,
          reservedUntil,
        },
      };
      const parsed = lineSchema.safeParse(line);
      if (!parsed.success)
        return { ok: false, error: 'invalid_quantity_or_identity' };
      const quote = await this.quote(senderId, [...cart.items, parsed.data]);
      if (!quote.ok) return quote;
      const next = rewritten(cart, quote);
      if (!this.store.commitMinimalCart)
        return { ok: false, error: 'cart_unavailable' };
      const saved = await this.store.commitMinimalCart(
        senderId,
        raw,
        next,
        new Date().toISOString(),
      );
      return saved ? quote : { ok: false, error: 'cart_changed' };
    } catch {
      return { ok: false, error: 'cart_unavailable' };
    }
  }

  private async changeItem(
    senderId: string,
    input: MinimalCartInput | MinimalCartAdjustmentInput,
    allowedIds: ReadonlySet<string>,
    operation: 'set' | 'adjust',
    onInvalidVariant?: VariantDiagnosticObserver,
    pet?: CartPet,
  ): Promise<MinimalCartResult> {
    try {
      const parsed =
        operation === 'adjust'
          ? minimalCartAdjustmentInput.safeParse(input)
          : minimalCartInput.safeParse(input);
      if (!parsed.success)
        return { ok: false, error: 'invalid_quantity_or_identity' };
      const request = parsed.data;
      const raw = structuredClone(
        (await this.store.get(senderId))?.data.minimalCart,
      );
      const cart = this.read(raw);
      if (!cart) return { ok: false, error: 'invalid_cart' };
      // An outstanding sale key means an order may exist for these lines;
      // editing the cart would drop the key and could duplicate it (S7).
      if (cart.idempotencyKey !== '')
        return { ok: false, error: 'order_unresolved' };
      const existing = cart.items.find((i) => sameLine(i, request));
      if (!existing && !allowedIds.has(request.productId))
        return { ok: false, error: 'unknown_product' };
      // Restock backorder T5b: the product is in the cart only as a reserved
      // backorder line. Removing it is allowed (the backorder stays
      // reserved); more units are another, ordinary line; any other change
      // of its quantity is refused, and its price is never editable.
      const backorderLine = existing
        ? undefined
        : cart.items.find(
            (i) => i.backorder !== undefined && sameProduct(i, request),
          );
      if (backorderLine !== undefined) {
        const removal = 'delta' in request ? false : request.quantity === 0;
        const addition = 'delta' in request && request.delta > 0;
        if (!removal && !addition)
          return { ok: false, error: 'backorder_line_locked' };
        if (removal) {
          const rest = cart.items.filter((i) => i !== backorderLine);
          const quote = await this.quote(
            senderId,
            rest,
            onInvalidVariant,
            request,
          );
          if (!quote.ok) return quote;
          const next = rewritten(cart, quote);
          if (!this.store.commitMinimalCart)
            return { ok: false, error: 'cart_unavailable' };
          const saved = await this.store.commitMinimalCart(
            senderId,
            raw,
            next,
            new Date().toISOString(),
          );
          return saved
            ? withRemovedBackorders(quote, [backorderLine])
            : { ok: false, error: 'cart_changed' };
        }
      }
      if (
        !existing &&
        ('delta' in request ? request.delta < 0 : request.quantity === 0)
      )
        return { ok: false, error: 'item_not_in_cart' };
      const quantity =
        'delta' in request
          ? (existing?.quantity ?? 0) + request.delta
          : request.quantity;
      if (!Number.isSafeInteger(quantity) || quantity < 0)
        return { ok: false, error: 'invalid_quantity_or_identity' };
      const items = cart.items.filter((i) => !sameLine(i, request));
      const tag = mergedPet(existing, validPet(pet), quantity);
      if (quantity > 0)
        items.push({
          productId: request.productId,
          ...(request.variantId ? { variantId: request.variantId } : {}),
          quantity,
          unitPriceCents: 0,
          ...(tag === undefined ? {} : { pet: tag }),
        });
      const quote = await this.quote(
        senderId,
        items,
        onInvalidVariant,
        request,
      );
      if (!quote.ok) return quote;
      const next = rewritten(cart, quote);
      if (!this.store.commitMinimalCart)
        return { ok: false, error: 'cart_unavailable' };
      const saved = await this.store.commitMinimalCart(
        senderId,
        raw,
        next,
        new Date().toISOString(),
      );
      return saved ? quote : { ok: false, error: 'cart_changed' };
    } catch {
      return { ok: false, error: 'cart_unavailable' };
    }
  }

  private read(raw: unknown): MinimalCartState | null {
    return parseMinimalCart(raw);
  }

  private async quote(
    senderId: string,
    items: CartItem[],
    onInvalidVariant?: VariantDiagnosticObserver,
    requestedLine?: Pick<CartItem, 'productId' | 'variantId'>,
  ): Promise<MinimalCartResult> {
    if (items.length === 0)
      return {
        ok: true,
        items: [],
        totalCents: 0,
        promotionEvaluationStatus: 'fully_evaluated',
      };
    const trusted: Omit<
      QuotedItem,
      'finalPriceCents' | 'appliedPromotionTitle' | 'discountAmountCents'
    >[] = [];
    for (const [index, line] of items.entries()) {
      if (line.backorder !== undefined) {
        // Restock backorder T5b: a reserved line is not sellable stock and
        // is priced at its frozen final price, never from the catalog.
        if (!money(line.unitPriceCents * line.quantity))
          return { ok: false, error: 'price_unavailable' };
        trusted.push({
          ...line,
          name: line.backorder.productName,
          ...(line.backorder.variantName === null
            ? {}
            : { variantName: line.backorder.variantName }),
        });
        continue;
      }
      const stock = await this.api.getStock(line.productId);
      if (stock.productId !== line.productId)
        return { ok: false, error: 'unknown_product' };
      const matches = (await this.api.searchCatalog(stock.name, 20)).filter(
        (i) => i.productId === line.productId,
      );
      if (matches.length !== 1)
        return { ok: false, error: 'price_unavailable' };
      const product = matches[0];
      if (product.variants.length > 0 && !line.variantId)
        return { ok: false, error: 'variant_required' };
      const variant = line.variantId
        ? product.variants.find((v) => v.variantId === line.variantId)
        : undefined;
      const variantStock = line.variantId
        ? stock.variants.find((v) => v.variantId === line.variantId)
        : undefined;
      if (line.variantId && (!variant || !variantStock)) {
        try {
          onInvalidVariant?.({
            linePosition: index + 1,
            lineOrigin:
              requestedLine && sameLine(line, requestedLine)
                ? 'requested'
                : 'stored',
            catalogVariantFound: variant !== undefined,
            stockVariantFound: variantStock !== undefined,
            variantIsProductId: line.variantId === line.productId,
          });
        } catch {
          // Diagnostics must never replace the original rejection or permit a write.
        }
        return { ok: false, error: 'invalid_variant' };
      }
      if (!line.variantId && stock.variants.length > 0)
        return { ok: false, error: 'variant_required' };
      const inventory = variantStock?.stock ?? stock.stock;
      if (
        !['available', 'low_stock', 'out_of_stock'].includes(
          inventory.status,
        ) ||
        !money(inventory.quantity ?? NaN)
      )
        return { ok: false, error: 'stock_unverified' };
      if (
        inventory.status === 'out_of_stock' ||
        inventory.quantity! < line.quantity
      )
        return { ok: false, error: 'insufficient_stock' };
      const price = variant ? variant.priceCents : product.price.priceCents;
      if (price === null || !money(price) || !money(price * line.quantity))
        return { ok: false, error: 'price_unavailable' };
      trusted.push({
        ...line,
        unitPriceCents: price,
        name: product.name,
        ...(variant ? { variantName: variant.name } : {}),
      });
    }
    // Backorder lines are outside the promotion base: only the ordinary
    // lines are evaluated (contract §7).
    const ordinary = trusted.filter((line) => line.backorder === undefined);
    const evaluationItems = ordinary.map(
      ({ productId, variantId, quantity, unitPriceCents }) => ({
        productId,
        ...(variantId ? { variantId } : {}),
        quantity,
        unitPriceCents,
      }),
    );
    const customer = parseMexicanWhatsAppPhone(senderId);
    let evaluation: CartEvaluationResult;
    try {
      evaluation =
        evaluationItems.length === 0
          ? {
              items: [],
              promotionEvaluationStatus: 'fully_evaluated',
            }
          : customer
            ? await this.api.evaluateCart(evaluationItems, customer)
            : await this.api.evaluateCart(evaluationItems);
    } catch (error) {
      if (
        error instanceof ChatbotApiError &&
        error.statusCode === 409 &&
        error.errorCode === 'PRICE_OUT_OF_DATE'
      )
        return { ok: false, error: 'price_unavailable' };
      // Includes CUSTOMER_NOT_FOUND: keep the generic retryable failure and no write.
      throw error;
    }
    if (
      !['fully_evaluated', 'needs_human_review'].includes(
        evaluation.promotionEvaluationStatus,
      ) ||
      (evaluation.customerResolution !== undefined &&
        !['unique', 'not_found', 'ambiguous', 'not_provided'].includes(
          evaluation.customerResolution,
        )) ||
      evaluation.items.length !== ordinary.length
    )
      return { ok: false, error: 'invalid_evaluation' };
    let totalCents = 0;
    const quoted: QuotedItem[] = [];
    let evaluated = 0;
    for (const expected of trusted) {
      if (expected.backorder !== undefined) {
        const lineTotal = expected.unitPriceCents * expected.quantity;
        totalCents += lineTotal;
        if (!money(totalCents))
          return { ok: false, error: 'invalid_evaluation' };
        quoted.push({
          ...expected,
          finalPriceCents: lineTotal,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        });
        continue;
      }
      const actual = evaluation.items[evaluated++];
      if (
        actual.productId !== expected.productId ||
        (actual.variantId ?? undefined) !== expected.variantId ||
        actual.quantity !== expected.quantity ||
        !money(actual.unitPriceCents) ||
        !money(actual.originalPriceCents) ||
        actual.originalPriceCents !==
          actual.unitPriceCents * expected.quantity ||
        !money(actual.finalPriceCents) ||
        !money(actual.discountAmountCents) ||
        (actual.appliedPromotionTitle !== null &&
          typeof actual.appliedPromotionTitle !== 'string') ||
        actual.finalPriceCents + actual.discountAmountCents !==
          actual.originalPriceCents
      )
        return { ok: false, error: 'invalid_evaluation' };
      totalCents += actual.finalPriceCents;
      if (!money(totalCents)) return { ok: false, error: 'invalid_evaluation' };
      quoted.push({
        ...expected,
        unitPriceCents: actual.unitPriceCents,
        finalPriceCents: actual.finalPriceCents,
        appliedPromotionTitle: actual.appliedPromotionTitle,
        discountAmountCents: actual.discountAmountCents,
      });
    }
    return {
      ok: true,
      items: quoted,
      totalCents,
      promotionEvaluationStatus: evaluation.promotionEvaluationStatus,
    };
  }
}

/** Stable short digest of cart lines; order-independent. */
export function minimalCartFingerprint(
  items: ReadonlyArray<
    Pick<CartItem, 'productId' | 'variantId' | 'quantity' | 'backorder' | 'pet'>
  >,
): string {
  const lines = items
    .map(
      (item) =>
        `${item.productId}|${item.variantId ?? ''}|${item.quantity}` +
        (item.backorder === undefined ? '' : `|${item.backorder.id}`) +
        (item.pet === undefined ? '' : `|pet:${item.pet.id}`),
    )
    .sort();
  return createHash('sha256')
    .update(JSON.stringify(lines))
    .digest('hex')
    .slice(0, 16);
}

/** Last sentence of a non-empty cart summary (see `minimalCartReply`). */
export const MINIMAL_CART_SUMMARY_TAIL =
  'No incluye envío y no reserva existencias. Todavía no se ha creado un pedido.';

/** S2: the question that closes a cart summary (usted; styled per customer). */
export const MINIMAL_CART_NEXT_STEP_QUESTION =
  '¿Desea agregar algo más o seguimos con su compra?';

/** Server-owned acknowledgement: failed persistence must never look successful. */
export function minimalCartReply(result: MinimalCartResult): string {
  if (!result.ok) {
    if (result.error === 'variant_required')
      return '¿Qué presentación desea agregar al carrito?';
    if (result.error === 'insufficient_stock')
      return 'No hay existencias suficientes para esa cantidad. Su carrito no fue modificado.';
    if (result.error === 'backorder_line_locked')
      return 'Esa pieza viene de su pedido apartado y no puedo cambiar su cantidad ni su precio; si quiere más, agrego otra línea. Su carrito no fue modificado.';
    if (result.error === 'order_unresolved')
      return 'Tengo un pedido suyo pendiente de confirmar. Para no duplicarlo no puedo cambiar el carrito: pida de nuevo el resumen y responda SÍ para reintentar ese mismo pedido, o comuníquese con la tienda. Su carrito no fue modificado.';
    return 'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.';
  }
  const kept = removedBackorderNote(result.removedBackorders);
  if (result.items.length === 0) return `Su carrito está vacío.${kept}`;
  // Message formatting F3a (S2/S4): the order summary's item lines, so the
  // cart and the summary read the same; the tail stays last (before any
  // removed-backorder note) because callers detect a cart summary by it.
  return (
    [
      sectionTitle('Su carrito'),
      ...result.items.flatMap(minimalItemLines),
      '',
      bold(`Total de productos: ${formatMoney(result.totalCents)}`),
      ...(result.promotionEvaluationStatus === 'needs_human_review'
        ? ['Las promociones requieren revisión del equipo.']
        : []),
      MINIMAL_CART_SUMMARY_TAIL,
    ].join('\n') + kept
  );
}

/** The result of a write, naming the backorder lines it removed (if any). */
function withRemovedBackorders(
  quote: MinimalCartResult,
  dropped: readonly CartItem[],
): MinimalCartResult {
  const removed = dropped.flatMap((line) =>
    line.backorder === undefined
      ? []
      : [
          {
            folio: line.backorder.folio,
            reservedUntil: line.backorder.reservedUntil,
          },
        ],
  );
  return quote.ok && removed.length > 0
    ? { ...quote, removedBackorders: removed }
    : quote;
}

/**
 * Restock backorder T5b: removing the line from the cart does not cancel the
 * backorder; say it stays reserved until its deadline.
 */
function removedBackorderNote(
  removed: Array<{ folio: string; reservedUntil: string }> | undefined,
): string {
  if (removed === undefined || removed.length === 0) return '';
  const now = new Date();
  return removed
    .map(({ folio, reservedUntil }) => {
      const until =
        Date.parse(reservedUntil) > now.getTime()
          ? backorderDateTime(reservedUntil, now)
          : null;
      return until === null
        ? `\nSu pedido apartado ${folio} no se canceló al quitarlo del carrito.`
        : `\nSu pedido apartado ${folio} sigue apartado ${until}; no se canceló al quitarlo del carrito.`;
    })
    .join('');
}

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
import type { CartItem, CartState } from '../../sale-flow/domain/cart-state';

const lineSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
});
const cartSchema = z.strictObject({
  items: z.array(lineSchema),
  idempotencyKey: z.literal(''),
  expectedTotalCents: z.number().int().nonnegative().optional(),
});
export const minimalCartInput = lineSchema
  .omit({ unitPriceCents: true })
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
};
export type MinimalCartResult =
  | { ok: false; error: string }
  | {
      ok: true;
      items: QuotedItem[];
      totalCents: number;
      promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
    };
const sameLine = (
  a: Pick<CartItem, 'productId' | 'variantId'>,
  b: Pick<CartItem, 'productId' | 'variantId'>,
) => a.productId === b.productId && a.variantId === b.variantId;
const money = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Cart only: no reservation, sale or payment calls. Prices are server-derived. */
@Injectable()
export class MinimalCartService {
  constructor(
    @Inject(CHATBOT_API_CLIENT) private readonly api: ChatbotApiClient,
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
  ) {}

  async view(senderId: string): Promise<MinimalCartResult> {
    try {
      const raw = (await this.store.get(senderId))?.data.minimalCart;
      const cart = this.read(raw);
      if (!cart) return { ok: false, error: 'invalid_cart' };
      return await this.quote(cart.items);
    } catch {
      return { ok: false, error: 'cart_unavailable' };
    }
  }

  /** Quantity is the desired TOTAL for this line, not an increment; zero removes. */
  async setItem(
    senderId: string,
    input: MinimalCartInput,
    allowedIds: ReadonlySet<string>,
  ): Promise<MinimalCartResult> {
    return this.changeItem(senderId, input, allowedIds, 'set');
  }

  /** Apply a signed unit delta to the same snapshot used by CAS; never retry it. */
  async adjustItem(
    senderId: string,
    input: MinimalCartAdjustmentInput,
    allowedIds: ReadonlySet<string>,
  ): Promise<MinimalCartResult> {
    return this.changeItem(senderId, input, allowedIds, 'adjust');
  }

  private async changeItem(
    senderId: string,
    input: MinimalCartInput | MinimalCartAdjustmentInput,
    allowedIds: ReadonlySet<string>,
    operation: 'set' | 'adjust',
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
      const existing = cart.items.find((i) => sameLine(i, request));
      if (!existing && !allowedIds.has(request.productId))
        return { ok: false, error: 'unknown_product' };
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
      if (quantity > 0)
        items.push({
          productId: request.productId,
          ...(request.variantId ? { variantId: request.variantId } : {}),
          quantity,
          unitPriceCents: 0,
        });
      const quote = await this.quote(items);
      if (!quote.ok) return quote;
      const next: CartState = {
        items: quote.items.map(
          ({ productId, variantId, quantity, unitPriceCents }) => ({
            productId,
            ...(variantId ? { variantId } : {}),
            quantity,
            unitPriceCents,
          }),
        ),
        idempotencyKey: '',
        expectedTotalCents: quote.totalCents,
      };
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

  private read(raw: unknown): CartState | null {
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

  private async quote(items: CartItem[]): Promise<MinimalCartResult> {
    if (items.length === 0)
      return {
        ok: true,
        items: [],
        totalCents: 0,
        promotionEvaluationStatus: 'fully_evaluated',
      };
    const trusted: Omit<QuotedItem, 'finalPriceCents'>[] = [];
    for (const line of items) {
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
      if (line.variantId && (!variant || !variantStock))
        return { ok: false, error: 'invalid_variant' };
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
    const evaluation = await this.api.evaluateCart(
      trusted.map(({ productId, variantId, quantity, unitPriceCents }) => ({
        productId,
        ...(variantId ? { variantId } : {}),
        quantity,
        unitPriceCents,
      })),
    );
    if (
      !['fully_evaluated', 'needs_human_review'].includes(
        evaluation.promotionEvaluationStatus,
      ) ||
      evaluation.items.length !== trusted.length
    )
      return { ok: false, error: 'invalid_evaluation' };
    let totalCents = 0;
    const quoted: QuotedItem[] = [];
    for (const [index, expected] of trusted.entries()) {
      const actual = evaluation.items[index];
      if (
        actual.productId !== expected.productId ||
        (actual.variantId ?? undefined) !== expected.variantId ||
        actual.quantity !== expected.quantity ||
        actual.unitPriceCents !== expected.unitPriceCents ||
        actual.originalPriceCents !==
          expected.unitPriceCents * expected.quantity ||
        !money(actual.finalPriceCents) ||
        !money(actual.discountAmountCents) ||
        actual.finalPriceCents + actual.discountAmountCents !==
          actual.originalPriceCents
      )
        return { ok: false, error: 'invalid_evaluation' };
      totalCents += actual.finalPriceCents;
      if (!money(totalCents)) return { ok: false, error: 'invalid_evaluation' };
      quoted.push({ ...expected, finalPriceCents: actual.finalPriceCents });
    }
    return {
      ok: true,
      items: quoted,
      totalCents,
      promotionEvaluationStatus: evaluation.promotionEvaluationStatus,
    };
  }
}

/** Server-owned acknowledgement: failed persistence must never look successful. */
export function minimalCartReply(result: MinimalCartResult): string {
  if (!result.ok) {
    if (result.error === 'variant_required')
      return '¿Qué presentación desea agregar al carrito?';
    if (result.error === 'insufficient_stock')
      return 'No hay existencias suficientes para esa cantidad. Su carrito no fue modificado.';
    return 'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.';
  }
  if (result.items.length === 0) return 'Su carrito está vacío.';
  const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;
  const lines = result.items.map(
    (i) =>
      `• ${i.name}${i.variantName ? ` — ${i.variantName}` : ''}: ${i.quantity} × ${mxn(i.unitPriceCents)}; importe ${mxn(i.finalPriceCents)}`,
  );
  return `Su carrito:\n${lines.join('\n')}\nTotal de productos: ${mxn(result.totalCents)}.${result.promotionEvaluationStatus === 'needs_human_review' ? '\nLas promociones requieren revisión del equipo.' : ''}\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.`;
}

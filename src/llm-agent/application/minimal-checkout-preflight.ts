import type { MinimalCartService } from './minimal-cart.service';

export type MinimalCheckoutPreflight =
  | {
      ok: false;
      status: 'blocked';
      reason: 'empty_cart' | 'cart_unverified' | 'promotion_review';
      orderCreated: false;
    }
  | {
      ok: true;
      status: 'incomplete';
      productsSubtotalCents: number;
      missing: readonly [
        'customer_and_address',
        'approved_shipping',
        'explicit_confirmation',
      ];
      orderCreated: false;
    };

/** Observational only: a fresh product quote is not permission to place an order. */
export async function reviewMinimalCheckout(
  cart: Pick<MinimalCartService, 'view'>,
  senderId: string,
): Promise<MinimalCheckoutPreflight> {
  try {
    const quote = await cart.view(senderId);
    if (!quote.ok) return blocked('cart_unverified');
    if (quote.items.length === 0) return blocked('empty_cart');
    if (quote.promotionEvaluationStatus !== 'fully_evaluated')
      return blocked('promotion_review');
    return {
      ok: true,
      status: 'incomplete',
      productsSubtotalCents: quote.totalCents,
      missing: [
        'customer_and_address',
        'approved_shipping',
        'explicit_confirmation',
      ],
      orderCreated: false,
    };
  } catch {
    return blocked('cart_unverified');
  }
}

const blocked = (
  reason: Extract<MinimalCheckoutPreflight, { ok: false }>['reason'],
): MinimalCheckoutPreflight => ({
  ok: false,
  status: 'blocked',
  reason,
  orderCreated: false,
});

/** Only application-owned wording reaches the customer after a preflight call. */
export function minimalCheckoutReply(
  result: MinimalCheckoutPreflight,
  flow: { checkout: boolean; shipping: boolean } = {
    checkout: false,
    shipping: false,
  },
): string {
  if (result.ok && flow.checkout)
    return `Revisión de compra: subtotal de productos $${(result.productsSubtotalCents / 100).toFixed(2)} MXN. No incluye envío. Para continuar falta confirmar sus datos y dirección de entrega${flow.shipping ? ', obtener un envío aprobado' : ''} y después confirmar su pedido. Si desea comprar, dígame «quiero comprar» y revisaré sus direcciones guardadas. No se creó ningún pedido ni se reservaron existencias.`;
  if (result.ok)
    return `Revisión de compra: subtotal de productos $${(result.productsSubtotalCents / 100).toFixed(2)} MXN. No incluye envío. Falta confirmar sus datos y dirección, obtener un envío aprobado y confirmar explícitamente el total final. No se creó ningún pedido ni se reservaron existencias.`;
  switch (result.reason) {
    case 'empty_cart':
      return 'Su carrito está vacío. Agregue productos antes de revisar la compra. No se creó ningún pedido.';
    case 'promotion_review':
      return 'Las promociones o precios de su carrito requieren revisión del equipo. Comuníquese con la tienda para revisarlos; esta revisión no registró una solicitud ni creó un pedido.';
    case 'cart_unverified':
      return 'No pude verificar los precios y existencias del carrito. Dígame «revisar mi compra» para intentarlo de nuevo; no se creó ningún pedido ni se modificó su carrito.';
  }
}

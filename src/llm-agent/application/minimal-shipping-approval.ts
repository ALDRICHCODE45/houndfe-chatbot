import { isDeepStrictEqual } from 'node:util';
import {
  readPendingHumanRequest,
  type ConversationState,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ShippingApprovalDigest } from '../../human-handoff/domain/human-handoff.types';
import {
  requestMinimalShippingApproval,
  transitionShippingApproval,
  type MinimalShipping,
} from '../domain/minimal-shipping';
import { parseMinimalCart } from './minimal-cart.service';

export const MINIMAL_SHIPPING_UNCONFIRMED =
  'No pudimos confirmar el envío. No se creó ningún pedido. Puedes solicitar otra cotización, por ejemplo con otra dirección guardada.';

/** Same redacted digest as legacy; never publish provider identity or address. */
export function shippingDigest(s: MinimalShipping): ShippingApprovalDigest {
  return {
    kind: 'shipping_approval',
    draftCreatedAt: s.createdAt,
    customerPaysCents: s.customerPaysCents,
    totalCreditCents: s.totalCreditCents,
    carrierName: s.carrierName,
    serviceName: s.serviceName,
    estimatedDeliveryDays: s.estimatedDeliveryDays,
  };
}

/** Only a matching pending minimal request selects the minimal decision route. */
export function pendingMinimalShipping(
  state: ConversationState | null,
  requestId: string,
): MinimalShipping | null {
  const s = parseMinimalCart(state?.data.minimalCart)?.shipping;
  return s?.approval.state === 'pending' && s.approval.requestId === requestId
    ? s
    : null;
}

/** Handoff first, then ONE cart CAS against the exact stored raw slot. */
export async function requestApproval(
  store: ConversationStore,
  handoff: Pick<HumanHandoffService, 'create'>,
  senderId: string,
  nowMs: number,
): Promise<boolean> {
  const state = await store.get(senderId);
  const raw = state?.data.minimalCart;
  const cart = parseMinimalCart(raw);
  const s = cart?.shipping;
  if (
    !store.commitMinimalCart ||
    !cart ||
    !s ||
    cart.idempotencyKey !== '' ||
    readPendingHumanRequest(state) ||
    s.approval.state !== 'not_requested' ||
    nowMs < Date.parse(s.createdAt) ||
    nowMs >= Date.parse(s.expiresAt)
  )
    return false;
  const result = await handoff.create({
    senderId,
    kind: 'shipping_approval',
    digest: shippingDigest(s),
  });
  if (!result.ok) return false;
  const shipping = requestMinimalShippingApproval(s, {
    requestId: result.requestId,
    nowMs,
  });
  if (!shipping || shipping.approval.state !== 'pending') return false;
  const committed = await store.commitMinimalCart(
    senderId,
    raw,
    { ...cart, shipping },
    new Date(nowMs).toISOString(),
  );
  if (!committed)
    await store.clearPendingHumanRequest(senderId, result.requestId);
  return committed;
}

/** No whole-bag write. CAS pins all quote/rate/credit fields, not a reconstruction. */
export async function decideApproval(
  store: ConversationStore,
  senderId: string,
  requestId: string,
  digest: ShippingApprovalDigest,
  decision: 'approved' | 'rejected',
  nowMs: number,
): Promise<{
  state: 'approved' | 'rejected' | 'expired';
  reply: string;
} | null> {
  const state = await store.get(senderId);
  const raw = state?.data.minimalCart;
  const cart = parseMinimalCart(raw);
  const s = pendingMinimalShipping(state, requestId);
  if (
    !store.commitMinimalCart ||
    !cart ||
    cart.idempotencyKey !== '' ||
    !s ||
    readPendingHumanRequest(state)?.requestId !== requestId ||
    !isDeepStrictEqual(shippingDigest(s), digest)
  )
    return null;
  const shipping = transitionShippingApproval(s, {
    state: decision,
    requestId,
    nowMs,
  });
  if (
    !shipping ||
    !['approved', 'rejected', 'expired'].includes(shipping.approval.state)
  )
    return null;
  if (
    !(await store.commitMinimalCart(
      senderId,
      raw,
      { ...cart, shipping },
      new Date(nowMs).toISOString(),
    ))
  )
    return null;
  const next = shipping.approval.state as 'approved' | 'rejected' | 'expired';
  return {
    state: next,
    reply:
      next !== 'approved'
        ? MINIMAL_SHIPPING_UNCONFIRMED
        : shipping.customerPaysCents === 0
          ? 'El envío cubierto por su compra se incluirá en el resumen del pedido. No se creó ningún pedido.'
          : `El flete aprobado es de $${(shipping.customerPaysCents / 100).toFixed(2)} MXN y se incluirá en el resumen del pedido. No se creó ningún pedido.`,
  };
}

/** Lazy expiry: no handoff scheduler exists. Conditional clear cannot erase a sibling request. */
export async function expireApproval(
  store: ConversationStore,
  senderId: string,
  nowMs: number,
): Promise<boolean> {
  const state = await store.get(senderId);
  const raw = state?.data.minimalCart;
  const cart = parseMinimalCart(raw);
  const s = cart?.shipping;
  const pending = readPendingHumanRequest(state);
  if (
    !store.commitMinimalCart ||
    !cart ||
    !s ||
    s.approval.state !== 'pending' ||
    pending?.requestId !== s.approval.requestId ||
    nowMs < Date.parse(s.expiresAt)
  )
    return false;
  const shipping = transitionShippingApproval(s, {
    state: 'expired',
    requestId: pending.requestId,
    nowMs,
  });
  if (
    !shipping ||
    !(await store.commitMinimalCart(
      senderId,
      raw,
      { ...cart, shipping },
      new Date(nowMs).toISOString(),
    ))
  )
    return false;
  if (!(await store.clearPendingHumanRequest(senderId, pending.requestId)))
    throw new Error('minimal shipping expiry pending clear failed');
  return true;
}

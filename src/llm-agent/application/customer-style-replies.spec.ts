import { MINIMAL_FULFILMENT_QUESTION } from '../domain/minimal-checkout-start';
import { normalizeMinimalCheckoutDraft } from '../../conversation/domain/minimal-checkout-draft';
import { PENDING_HUMAN_REQUEST_REPLY } from '../../human-handoff/application/human-handoff.service';
import {
  PRODUCT_IMAGE_UNAVAILABLE_REPLY,
  PRODUCT_IMAGE_UNCLEAR_REPLY,
  RECEIPT_IMAGE_WITHOUT_ORDER_REPLY,
} from '../../product-image/domain/product-image';
import {
  DEFAULT_CUSTOMER_STYLE,
  applyCustomerStyle,
  type CustomerStyle,
} from '../domain/customer-style';
import {
  MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
  MINIMAL_CHECKOUT_CHANGED_REPLY,
  MINIMAL_CHECKOUT_CONFIRMED_REPLY,
  MINIMAL_CHECKOUT_DECLINED_REPLY,
  MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
  renderMinimalCheckoutConfirmation,
} from '../domain/minimal-checkout-confirmation';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_DECLINED_REPLY,
  renderMinimalOrderSummary,
  type MinimalOrderSnapshot,
} from '../domain/minimal-order-confirmation';
import {
  CART_OPERATION_CLARIFICATION,
  CART_PRESENTATION_QUESTION,
  CART_QUANTITY_QUESTION,
  CART_UNKNOWN_REFERENCE_REPLY,
} from './minimal-cart-conversation';
import { minimalCartReply } from './minimal-cart.service';
import { renderNotificationText } from '../../receipt-media/infrastructure/receipt-media-notification.worker';
import { RECEIPT_TEMPLATE_KEYS } from '../../receipt-media/domain/receipt-media.types';
import {
  deliveryZoneResolvedText,
  deliveryZoneResumedText,
} from '../../delivery-zones/domain/delivery-zone-requester';
import { minimalZoneResumeShippingSentence } from '../domain/minimal-shipping';
import {
  BACKORDER_ASK_NAME_REPLY,
  BACKORDER_ASK_QUANTITY_REPLY,
  BACKORDER_DECLINE_REPLY,
  BACKORDER_CANCEL_FAILED_REPLY,
  BACKORDER_CANCEL_PICK_PROMPT,
  BACKORDER_FAILED_REPLY,
  BACKORDER_RETRY_REPLY,
  BACKORDER_STATUS_FAILED_REPLY,
  backorderAvailableNowReply,
  backorderCancelKeptReply,
  backorderCancelledReply,
  backorderCancelPickReply,
  backorderCancelPrompt,
  backorderCancelQuestion,
  backorderDuplicateReply,
  backorderInactiveReply,
  backorderNotCancellableReply,
  backorderScheduledReply,
  backorderStatusListReply,
  backorderStatusReply,
} from '../domain/backorder-copy';
import {
  BACKORDER_OFFER_CLOSING,
  BACKORDER_OFFER_PROMPT,
} from '../../backorders/domain/backorder-offer';
import {
  BUSY_REPLY,
  CHECKOUT_TOOL_CLARIFICATION,
  FORGET_MY_DATA_REPLY,
  RESTOCK_CAUTIOUS_REPLY,
  minimalPickupReply,
  minimalShippingReply,
} from './minimal-catalog-agent.service';
import { minimalCheckoutReply } from './minimal-checkout-preflight';
import {
  MINIMAL_CHECKOUT_ADDRESS_REQUIRED_REPLY,
  MINIMAL_CHECKOUT_INVALID_STATE_REPLY,
  MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY,
  MINIMAL_CHECKOUT_RESELECT_REPLY,
  minimalCheckoutIncompleteReply,
} from './minimal-checkout.service';
import {
  MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
  MINIMAL_EXPIRATION_CLARIFY_REPLY,
} from './minimal-expiration-request.service';
import {
  MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
  MINIMAL_ORDER_CHANGED_REPLY,
  MINIMAL_ORDER_CUSTOMER_RECHECK_REPLY,
  MINIMAL_ORDER_HELD_REPLY,
  MINIMAL_ORDER_INELIGIBLE_REPLIES,
  MINIMAL_ORDER_PACKAGING_MISSING_REPLY,
  MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_PICKUP_CUSTOMER_UNAVAILABLE_REPLY,
  MINIMAL_ORDER_PICKUP_NAME_REQUIRED_REPLY,
  MINIMAL_ORDER_REJECTED_REPLY,
  MINIMAL_ORDER_SHIPPING_QUOTE_NOT_FOUND_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
  MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY,
  MINIMAL_ORDER_STOCK_CHANGED_REPLY,
  MINIMAL_ORDER_UNRESOLVED_REPLY,
  MINIMAL_ORDER_VARIANT_CHANGED_REPLY,
  minimalOrderCreatedReply,
} from './minimal-order.service';
import {
  MINIMAL_PAYMENT_BUTTONS_PROMPT,
  MINIMAL_PAYMENT_NEW_ORDER_REPLY,
  MINIMAL_PAYMENT_QUESTION,
  MINIMAL_PAYMENT_UNAVAILABLE_REPLY,
  minimalPaymentInstructions,
  minimalReceiptInReviewReply,
} from './minimal-payment.service';
import {
  MINIMAL_RESTOCK_AMBIGUOUS_REPLY,
  MINIMAL_RESTOCK_CLARIFY_REPLY,
  MINIMAL_RESTOCK_DECLINE_REPLY,
  minimalRestockAlreadyReply,
  minimalRestockConfirmedReply,
  minimalRestockProposal,
} from './minimal-restock-request.service';
import type { MinimalShippingRefusal } from './minimal-shipping.service';

/**
 * S2 "en todos los mensajes": every server-owned customer reply has a tú
 * variant with no usted markers, an usted variant equal to today's copy, and
 * no emojis for a customer who uses none.
 */
const SENDER = '5215550001111';
const tu: CustomerStyle = { register: 'tu', emojis: true, tone: 'neutral' };
const ustedEmoji: CustomerStyle = { ...DEFAULT_CUSTOMER_STYLE, emojis: true };
const USTED_MARKERS =
  /\b(usted|ustedes|su|sus|suyo|le|les|desea|envíe|envíenos|puede|dígame|pídame|comuníquese|revise|quiere|prefiere|confirme)\b/i;

const draft = (address: Record<string, unknown>) =>
  normalizeMinimalCheckoutDraft(
    {
      schemaVersion: 1,
      senderId: SENDER,
      revision: 0,
      sourceCustomerId: null,
      customer: { firstName: 'Ana', lastName: 'Pérez' },
      address,
    },
    SENDER,
  )!;
const fields = {
  label: null,
  street: 'Av. Reforma',
  exteriorNumber: '123',
  interiorNumber: null,
  zipCode: '06600',
  neighborhood: 'Juárez',
  municipality: null,
  city: 'Ciudad de México',
  state: 'Ciudad de México',
  visualReferences: null,
  carrierPhone: null,
};
const line = {
  productId: '11111111-1111-4111-8111-111111111111',
  name: 'Croquetas Adulto',
  variantName: '15 kg',
  quantity: 1,
  unitPriceCents: 89900,
  finalPriceCents: 89900,
};
const order = (over: Partial<MinimalOrderSnapshot>): MinimalOrderSnapshot => ({
  customerId: '',
  shippingAddressId: '',
  draft: draft({ kind: 'new', fields }),
  items: [line],
  totalCents: 89900,
  ...over,
});
const REFUSALS: MinimalShippingRefusal[] = [
  'cart_unverified',
  'empty_cart',
  'promotion_review',
  'delivery_unconfirmed',
  'new_address_unsupported',
  'invalid_state',
  'order_unresolved',
  'cart_changed',
  'address_changed',
  'address_unverified',
  'unsupported_destination',
];
const quoted = {
  kind: 'quoted' as const,
  costCents: 20000,
  creditCents: 12000,
  customerChargeCents: 8000,
  option: { carrier: 'Carrier', service: 'Ground', etaDays: 3 },
  eta: { days: 3 },
} as never;
const payment = {
  bankName: 'Banco',
  beneficiary: 'HoundFe',
  clabe: '012345678901234567',
  accountNumber: '1234567890',
};

const BO = {
  folio: 'BO-000012',
  quantity: 2,
  productName: 'Collar',
  variantName: null,
};
const BO_NOW = new Date('2026-11-20T12:00:00.000Z');
const BO_WAITING = {
  folio: 'BO-000012',
  status: 'WAITING' as const,
  estimatedAt: '2026-11-27T15:00:00.000Z',
  reservedUntil: null,
};
const BO_RESERVED = {
  folio: 'BO-000012',
  status: 'RESERVED' as const,
  estimatedAt: '2026-11-27T15:00:00.000Z',
  reservedUntil: '2026-11-21T15:00:00.000Z',
};

const REPLIES: Record<string, string> = {
  BUSY_REPLY,
  RESTOCK_CAUTIOUS_REPLY,
  CHECKOUT_TOOL_CLARIFICATION,
  PENDING_HUMAN_REQUEST_REPLY,
  PRODUCT_IMAGE_UNCLEAR_REPLY,
  PRODUCT_IMAGE_UNAVAILABLE_REPLY,
  RECEIPT_IMAGE_WITHOUT_ORDER_REPLY,
  MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
  MINIMAL_CHECKOUT_CHANGED_REPLY,
  MINIMAL_CHECKOUT_CONFIRMED_REPLY,
  MINIMAL_CHECKOUT_DECLINED_REPLY,
  MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
  checkoutSummaryNew: renderMinimalCheckoutConfirmation(
    draft({ kind: 'new', fields }),
  ),
  MINIMAL_CHECKOUT_ADDRESS_REQUIRED_REPLY,
  MINIMAL_CHECKOUT_INVALID_STATE_REPLY,
  MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY,
  MINIMAL_CHECKOUT_RESELECT_REPLY,
  checkoutIncomplete: minimalCheckoutIncompleteReply(['street', 'zipCode']),
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_DECLINED_REPLY,
  orderSummaryNewAddressQuoted: renderMinimalOrderSummary(
    order({
      shipping: {
        quoteId: 'q',
        customerChargeCents: 3000,
        creditCents: 12000,
        option: { carrier: 'Carrier', service: 'Ground' },
        eta: { days: null, reason: 'STOCK_PENDING' },
      },
    }),
  ),
  orderSummaryFree: renderMinimalOrderSummary(
    order({ shipping: { quoteId: 'q', customerChargeCents: 0 } }),
  ),
  orderSummaryPickup: renderMinimalOrderSummary(
    order({
      draft: null,
      customer: { firstName: 'Ana', lastName: null },
      shipping: { mode: 'pickup' },
    }),
  ),
  orderCreatedFolio: minimalOrderCreatedReply(
    { saleId: 's', folio: 'A-12', totalCents: 89900 },
    { customerChargeCents: 0 },
    null,
  ),
  orderCreatedPickup: minimalOrderCreatedReply(
    { saleId: 's', folio: null, totalCents: 89900 },
    { mode: 'pickup' },
    {
      name: 'HoundFe Centro',
      address: { formatted: 'Calle 1, Centro.' },
      hours: { summary: 'Lun-Sáb 9-19 h' },
    } as never,
  ),
  orderCreatedNoShipping: minimalOrderCreatedReply(
    { saleId: 's', folio: 'A-12', totalCents: 89900 },
    undefined,
    null,
  ),
  orderCreatedPaid: minimalOrderCreatedReply(
    { saleId: 's', folio: 'A-12', totalCents: 89900 },
    { customerChargeCents: 8000 },
    null,
  ),
  paymentInstructions: minimalPaymentInstructions(payment),
  MINIMAL_PAYMENT_QUESTION,
  MINIMAL_PAYMENT_BUTTONS_PROMPT,
  MINIMAL_PAYMENT_UNAVAILABLE_REPLY,
  MINIMAL_PAYMENT_NEW_ORDER_REPLY,
  receiptInReview: minimalReceiptInReviewReply('A-12'),
  receiptInReviewNoFolio: minimalReceiptInReviewReply(null),
  MINIMAL_FULFILMENT_QUESTION,
  ...Object.fromEntries(
    Object.entries(MINIMAL_ORDER_INELIGIBLE_REPLIES).map(([k, v]) => [
      `ineligible_${k}`,
      v,
    ]),
  ),
  MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY,
  MINIMAL_ORDER_PICKUP_NAME_REQUIRED_REPLY,
  MINIMAL_ORDER_PICKUP_CUSTOMER_UNAVAILABLE_REPLY,
  MINIMAL_ORDER_CUSTOMER_RECHECK_REPLY,
  MINIMAL_ORDER_CHANGED_REPLY,
  MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_REJECTED_REPLY,
  MINIMAL_ORDER_VARIANT_CHANGED_REPLY,
  MINIMAL_ORDER_STOCK_CHANGED_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY,
  MINIMAL_ORDER_SHIPPING_QUOTE_NOT_FOUND_REPLY,
  MINIMAL_ORDER_PACKAGING_MISSING_REPLY,
  MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY,
  MINIMAL_ORDER_HELD_REPLY,
  MINIMAL_ORDER_UNRESOLVED_REPLY,
  MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
  shippingQuoted: minimalShippingReply({
    ...(quoted as object),
    zoneStatus: 'SURCHARGE',
    zipCode: '06600',
  } as never),
  shippingFree: minimalShippingReply({
    ...(quoted as object),
    zoneStatus: 'FREE',
    zipCode: '06600',
  } as never),
  shippingFreeNoZip: minimalShippingReply({
    ...(quoted as object),
    zoneStatus: 'FREE',
    zipCode: null,
    eta: { days: null, reason: 'STOCK_PENDING' },
  } as never),
  shippingPending: minimalShippingReply({
    kind: 'zone_pending',
    zipCode: '06600',
  }),
  shippingDenied: minimalShippingReply({ kind: 'zone_denied', zipCode: null }),
  ...Object.fromEntries(
    (
      [
        'prices_changed',
        'cart_invalid',
        'address_invalid',
        'phone_ambiguous',
        'packaging_missing',
        'unavailable',
      ] as const
    ).map((kind) => [`shipping_${kind}`, minimalShippingReply({ kind })]),
  ),
  ...Object.fromEntries(
    REFUSALS.map((reason) => [
      `shippingRefused_${reason}`,
      minimalShippingReply({ kind: 'refused', reason }),
    ]),
  ),
  pickup: minimalPickupReply({ kind: 'pickup' }),
  ...Object.fromEntries(
    (
      [
        'cart_unverified',
        'empty_cart',
        'promotion_review',
        'order_unresolved',
        'cart_changed',
      ] as const
    ).map((reason) => [
      `pickupRefused_${reason}`,
      minimalPickupReply({ kind: 'refused', reason }),
    ]),
  ),
  CART_QUANTITY_QUESTION,
  CART_PRESENTATION_QUESTION,
  CART_OPERATION_CLARIFICATION,
  CART_UNKNOWN_REFERENCE_REPLY,
  ...Object.fromEntries(
    [
      'variant_required',
      'insufficient_stock',
      'order_unresolved',
      'invalid_cart',
    ].map((error) => [`cart_${error}`, minimalCartReply({ ok: false, error })]),
  ),
  cartEmpty: minimalCartReply({
    ok: true,
    items: [],
    totalCents: 0,
    promotionEvaluationStatus: 'fully_evaluated',
  }),
  cartView: minimalCartReply({
    ok: true,
    items: [
      { ...line, appliedPromotionTitle: null, discountAmountCents: 0 },
    ] as never,
    totalCents: 89900,
    promotionEvaluationStatus: 'needs_human_review',
  }),
  ...Object.fromEntries(
    (['empty_cart', 'cart_unverified', 'promotion_review'] as const).map(
      (reason) => [
        `preflight_${reason}`,
        minimalCheckoutReply({
          ok: false,
          status: 'blocked',
          reason,
          orderCreated: false,
        }),
      ],
    ),
  ),
  ...Object.fromEntries(
    [
      { checkout: true, shipping: true },
      { checkout: true, shipping: false },
      { checkout: false, shipping: false },
    ].map((flow, index) => [
      `preflight_incomplete_${index}`,
      minimalCheckoutReply(
        {
          ok: true,
          status: 'incomplete',
          productsSubtotalCents: 89900,
          missing: [
            'customer_and_address',
            'approved_shipping',
            'explicit_confirmation',
          ],
          orderCreated: false,
        },
        flow,
      ),
    ]),
  ),
  MINIMAL_RESTOCK_AMBIGUOUS_REPLY,
  MINIMAL_RESTOCK_CLARIFY_REPLY,
  MINIMAL_RESTOCK_DECLINE_REPLY,
  restockConfirmed: minimalRestockConfirmedReply('Collar'),
  restockAlready: minimalRestockAlreadyReply('Collar'),
  restockProposal: minimalRestockProposal('Collar'),
  MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
  MINIMAL_EXPIRATION_CLARIFY_REPLY,
  // S1: "olvida mis datos" and the later notices sent in the stored style.
  FORGET_MY_DATA_REPLY,
  ...Object.fromEntries(
    RECEIPT_TEMPLATE_KEYS.flatMap((key) =>
      [
        {
          folio: 'F-1',
          debtCents: 1000,
          extractedAmountCents: 500,
          totalCents: 900,
        } as Record<string, string | number>,
        {},
      ].map((args, index) => [
        `receipt_${key}_${index}`,
        renderNotificationText({ templateKey: key, templateArgs: args }),
      ]),
    ),
  ),
  receiptPdfNotAReceipt: renderNotificationText({
    templateKey: 'RECEIPT_NOT_A_RECEIPT',
    templateArgs: { mediaKind: 'pdf' },
  }),
  zoneDenied: deliveryZoneResolvedText('06700', 'DENIED'),
  zoneFree: deliveryZoneResolvedText('06700', 'FREE'),
  // S4: the zone-approved notice that resumes the checkout.
  zoneResumedFree: deliveryZoneResumedText(
    '06700',
    minimalZoneResumeShippingSentence({
      customerChargeCents: 0,
      eta: { days: 2 },
      option: null,
    }),
  ),
  zoneResumedCharged: deliveryZoneResumedText(
    '06700',
    minimalZoneResumeShippingSentence({
      customerChargeCents: 12500,
      eta: { days: 1 },
      option: null,
    }),
  ),
  zoneResumedStockPending: deliveryZoneResumedText(
    '06700',
    minimalZoneResumeShippingSentence({
      customerChargeCents: 0,
      eta: { days: null, reason: 'STOCK_PENDING' },
      option: null,
    }),
  ),
  restockEstimate:
    '¡Gracias por la espera! 😊 El equipo nos confirmó un estimado de 3 días para la reposición de «Collar», contados desde su confirmación. La fecha puede variar. ¿Quiere que se lo apartemos en cuanto llegue? Le aviso y no paga nada hasta entonces.',
  // Restock backorder S1/S14: the offer, its button body and the answers.
  backorderOfferClosing: BACKORDER_OFFER_CLOSING,
  backorderOfferPrompt: BACKORDER_OFFER_PROMPT,
  backorderDecline: BACKORDER_DECLINE_REPLY,
  backorderAskQuantity: BACKORDER_ASK_QUANTITY_REPLY,
  backorderAskName: BACKORDER_ASK_NAME_REPLY,
  backorderRetry: BACKORDER_RETRY_REPLY,
  backorderFailed: BACKORDER_FAILED_REPLY,
  backorderScheduled: backorderScheduledReply(
    {
      folio: 'BO-000012',
      quantity: 2,
      productName: 'Collar',
      variantName: null,
      referencePriceCents: 114900,
      estimatedAt: '2026-11-27T15:00:00.000Z',
    },
    new Date('2026-11-20T12:00:00.000Z'),
  ),
  backorderAvailableNow: backorderAvailableNowReply('Collar'),
  backorderDuplicate: backorderDuplicateReply({
    folio: 'BO-000012',
    productName: 'Collar',
    variantName: null,
  }),
  backorderDuplicateNoFolio: backorderDuplicateReply(null),
  // Restock backorder S8 (T6): cancel, status and the inactive replay.
  backorderCancelQuestion: backorderCancelQuestion(BO),
  backorderCancelPrompt: backorderCancelPrompt(BO),
  backorderCancelled: backorderCancelledReply(BO),
  backorderCancelKept: backorderCancelKeptReply(BO),
  backorderCancelFailed: BACKORDER_CANCEL_FAILED_REPLY,
  backorderCancelPickPrompt: BACKORDER_CANCEL_PICK_PROMPT,
  backorderCancelPick: backorderCancelPickReply([
    BO,
    { ...BO, folio: 'BO-000013' },
  ]),
  backorderNotCancellableExpired: backorderNotCancellableReply(BO, 'EXPIRED'),
  backorderNotCancellableConfirmed: backorderNotCancellableReply(
    BO,
    'CONFIRMED',
  ),
  backorderStatusFailed: BACKORDER_STATUS_FAILED_REPLY,
  backorderStatusWaiting: backorderStatusReply(BO_WAITING, BO_NOW),
  backorderStatusWaitingPast: backorderStatusReply(
    { ...BO_WAITING, estimatedAt: '2026-11-10T15:00:00.000Z' },
    BO_NOW,
  ),
  backorderStatusReserved: backorderStatusReply(BO_RESERVED, BO_NOW),
  backorderStatusReservedNoDeadline: backorderStatusReply(
    { ...BO_RESERVED, reservedUntil: null },
    BO_NOW,
  ),
  backorderStatusList: backorderStatusListReply(
    [BO_WAITING, { ...BO_RESERVED, folio: 'BO-000013' }],
    BO_NOW,
  ),
  backorderInactiveCancelled: backorderInactiveReply({
    folio: 'BO-000012',
    status: 'CANCELLED',
  }),
  backorderInactiveExpired: backorderInactiveReply({
    folio: 'BO-000012',
    status: 'EXPIRED',
  }),
  backorderInactiveConfirmed: backorderInactiveReply({
    folio: 'BO-000012',
    status: 'CONFIRMED',
  }),
  restockUnavailable:
    '¡Gracias por la espera! 😊 Por ahora el equipo no pudo confirmar un estimado de reposición para «Collar».',
  // Fixed copy of prepareExpirationReply (unavailable branch).
  expirationUnavailable:
    'Sobre el Alimento, el equipo no pudo confirmar la fecha de caducidad. ¿Desea continuar con la compra o prefiere que le ayude con alguna otra consulta?',
};

describe('customer style over every fixed customer reply (S2)', () => {
  it.each(Object.entries(REPLIES))(
    '%s has a tú variant with no usted markers',
    (_name, reply) => {
      const styled = applyCustomerStyle(reply, tu);
      expect(styled).not.toMatch(USTED_MARKERS);
    },
  );

  it.each(Object.entries(REPLIES))(
    '%s keeps the usted variant equal to the current copy',
    (_name, reply) => {
      expect(applyCustomerStyle(reply, ustedEmoji)).toBe(reply);
    },
  );

  it.each(Object.entries(REPLIES))(
    '%s carries no emoji for a customer who uses none',
    (_name, reply) => {
      for (const register of ['usted', 'tu'] as const) {
        expect(
          applyCustomerStyle(reply, {
            register,
            emojis: false,
            tone: 'formal',
          }),
        ).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    },
  );

  it('keeps folio, amounts and CLABE intact in the tú order-created copy', () => {
    expect(
      applyCustomerStyle(
        `${REPLIES.orderCreatedPaid}\n\n${REPLIES.paymentInstructions}`,
        tu,
      ),
    ).toBe(
      [
        'Tu pedido quedó registrado con folio A-12. Total a pagar: $899.00 MXN (envío incluido).',
        '',
        'Para pagar por transferencia:',
        'Banco: Banco',
        'Beneficiario: HoundFe',
        'CLABE: 012345678901234567',
        'Cuenta: 1234567890',
        'Cuando hagas la transferencia, envía aquí la foto de tu comprobante.',
      ].join('\n'),
    );
  });

  it('pins representative tú copy', () => {
    expect(applyCustomerStyle(MINIMAL_CHECKOUT_CONFIRMED_REPLY, tu)).toBe(
      'Gracias, tus datos de entrega quedaron confirmados.',
    );
    expect(applyCustomerStyle(MINIMAL_ORDER_DECLINED_REPLY, tu)).toBe(
      'Entendido, no creé el pedido. ¿Quieres cambiar algo del pedido?',
    );
    expect(applyCustomerStyle(REPLIES.pickup, tu)).toBe(
      'Listo, recoges tu pedido en tienda, sin costo de envío.',
    );
    expect(applyCustomerStyle(BUSY_REPLY, tu)).toBe(
      'Ya estoy atendiendo tu consulta; por favor espera mi respuesta.',
    );
    expect(applyCustomerStyle(PENDING_HUMAN_REQUEST_REPLY, tu)).toBe(
      'Seguimos esperando la respuesta del equipo; te avisamos por aquí en cuanto la tengamos.',
    );
    expect(applyCustomerStyle(REPLIES.restockProposal, tu)).toBe(
      'Por ahora no tenemos «Collar» 😕. ¿Quieres que consulte si hay una fecha estimada de reposición?',
    );
  });
});

describe('restock backorder copy in tú (S1/S14)', () => {
  it('pins the confirmation, the offer and the questions', () => {
    expect(applyCustomerStyle(REPLIES.backorderScheduled, tu)).toBe(
      'Listo, quedó agendado tu pedido BO-000012: 2 × Collar a $1149.00 MXN c/u. Te aviso en cuanto llegue (aprox. el 27 de noviembre); no pagas nada hasta entonces.',
    );
    expect(applyCustomerStyle(REPLIES.backorderOfferPrompt, tu)).toBe(
      '¿Quieres que te lo apartemos?',
    );
    expect(applyCustomerStyle(REPLIES.backorderAskQuantity, tu)).toBe(
      '¿Cuántas piezas te aparto?',
    );
    expect(applyCustomerStyle(REPLIES.backorderAvailableNow, tu)).toBe(
      '¡Buenas noticias! Ya tenemos Collar disponible. ¿Cuántas piezas te agrego al carrito?',
    );
    expect(applyCustomerStyle(REPLIES.backorderDuplicate, tu)).toBe(
      'Ya tienes agendado tu pedido BO-000012 de Collar. Te aviso en cuanto llegue.',
    );
    expect(applyCustomerStyle(REPLIES.backorderRetry, tu)).toBe(
      'No pude agendar tu pedido en este momento. Intenta de nuevo en unos minutos.',
    );
    expect(applyCustomerStyle(REPLIES.backorderDecline, tu)).toBe(
      'Entendido. ¡Que estés muy bien!',
    );
  });
});

describe('restock backorder copy in tú (S8 cancel and status)', () => {
  it('pins the cancel question, replies and the status lines', () => {
    expect(applyCustomerStyle(REPLIES.backorderCancelQuestion, tu)).toBe(
      '¿Cancelo tu pedido BO-000012 de 2 × Collar?',
    );
    expect(applyCustomerStyle(REPLIES.backorderCancelled, tu)).toBe(
      'Listo, cancelé tu pedido BO-000012.',
    );
    expect(applyCustomerStyle(REPLIES.backorderCancelKept, tu)).toBe(
      'Entendido, tu pedido BO-000012 sigue agendado.',
    );
    expect(applyCustomerStyle(REPLIES.backorderCancelPick, tu)).toBe(
      'Tienes varios pedidos por reposición. ¿Cuál quieres cancelar?\n• BO-000012: 2 × Collar\n• BO-000013: 2 × Collar',
    );
    expect(applyCustomerStyle(REPLIES.backorderCancelPickPrompt, tu)).toBe(
      '¿Cuál pedido quieres cancelar?',
    );
    expect(applyCustomerStyle(REPLIES.backorderStatusWaiting, tu)).toBe(
      'Tu pedido BO-000012 sigue en espera; llega aprox. el 27 de noviembre. Te aviso en cuanto llegue.',
    );
    expect(applyCustomerStyle(REPLIES.backorderStatusReserved, tu)).toBe(
      '¡Ya llegó! Te lo tenemos apartado hasta el 21 de noviembre a las 9:00 a. m.',
    );
    expect(applyCustomerStyle(REPLIES.backorderStatusList, tu)).toBe(
      [
        'Tienes varios pedidos por reposición:',
        'Tu pedido BO-000012 sigue en espera; llega aprox. el 27 de noviembre. Te aviso en cuanto llegue.',
        'Tu pedido BO-000013 ya llegó y te lo tenemos apartado hasta el 21 de noviembre a las 9:00 a. m.',
      ].join('\n'),
    );
    expect(applyCustomerStyle(REPLIES.backorderInactiveCancelled, tu)).toBe(
      'Tu pedido BO-000012 ya estaba cancelado, así que no está agendado.',
    );
  });
});

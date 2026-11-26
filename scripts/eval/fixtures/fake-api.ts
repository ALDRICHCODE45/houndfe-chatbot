import type { ChatbotApiClient } from '../../../src/chatbot-api/domain/chatbot-api.client';
import type { BranchInfo } from '../../../src/chatbot-api/domain/dtos/branch.dto';
import type { CartItemInput } from '../../../src/chatbot-api/domain/dtos/pricing.dto';
import type {
  CheckoutContextAddress,
  CustomerCheckoutContext,
} from '../../../src/chatbot-api/domain/dtos/checkout-context.dto';
import type {
  CheckoutResponse,
  CheckoutStatus,
  CreateCheckoutInput,
} from '../../../src/chatbot-api/domain/dtos/checkout.dto';
import type {
  OrderHistoryQuery,
  OrderHistoryResponse,
} from '../../../src/chatbot-api/domain/dtos/sales.dto';
import type {
  CreateShippingQuoteInput,
  ShippingQuoteResponse,
} from '../../../src/chatbot-api/domain/dtos/shipping-quote.dto';
import {
  findProduct,
  searchFixture,
  toCatalogItem,
  toStockCheck,
  unitPrice,
} from './catalog';
import type { EvalPetSeed } from './fake-pets-client';

/** Who the WhatsApp sender is in the backend for a scenario. */
export type FixtureCustomer =
  | { kind: 'new' }
  | {
      kind: 'existing';
      firstName: string;
      zip: keyof typeof ADDRESSES;
      /** Multi-pet T7: pets staff already entered in the backend (POS). */
      pets?: readonly EvalPetSeed[];
    };

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
/** The backend Customer of every existing fixture customer (and of a
 *  customer a checkout creates). */
export const EVAL_CUSTOMER_ID = CUSTOMER_ID;
const ADDRESS_ID = 'd0000000-0000-4000-8000-000000000001';
const ADDRESS_VERSION = '2026-10-01T00:00:00.000Z';
const SALE_ID = (n: number) =>
  `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Saved addresses by ZIP: 03100 FREE, 04000 SURCHARGE, 12000 DENIED. */
export const ADDRESSES = {
  '03100': {
    street: 'Av. Coyoacán',
    exteriorNumber: '1200',
    neighborhood: 'Del Valle Centro',
    municipality: 'Benito Juárez',
  },
  '04000': {
    street: 'Calle Francisco Sosa',
    exteriorNumber: '150',
    neighborhood: 'Santa Catarina',
    municipality: 'Coyoacán',
  },
  '12000': {
    street: 'Calle Morelos',
    exteriorNumber: '8',
    neighborhood: 'Villa Milpa Alta Centro',
    municipality: 'Milpa Alta',
  },
} as const;

/**
 * The existing customer's previous order (S2 reorder): Nupec 18 kg × 1 at
 * today's price and Royal Canin Mini 2 kg × 2 at an older price ($499, today
 * $529). Historical names on purpose: the bot must show today's names.
 */
export const PREVIOUS_ORDER: OrderHistoryResponse = {
  saleId: SALE_ID(99),
  folio: 'EV-0099',
  confirmedAt: '2026-10-20T18:00:00.000Z',
  channel: 'ONLINE',
  deliveryStatus: 'DELIVERED',
  paymentStatus: 'PAID',
  totalCents: 259700,
  paidCents: 259700,
  debtCents: 0,
  items: [
    {
      productId: 'a0000000-0000-4000-8000-000000000001',
      variantId: null,
      productName: 'Croquetas Nupec Salmón 18 kg',
      variantName: null,
      quantity: 1,
      unitPriceCents: 159900,
    },
    {
      productId: 'a0000000-0000-4000-8000-000000000003',
      variantId: 'b0000000-0000-4000-8000-000000000301',
      productName: 'Croquetas Royal Canin Mini',
      variantName: '2 kg',
      quantity: 2,
      unitPriceCents: 49900,
    },
  ],
  payments: [{ method: 'TRANSFER', amountCents: 259700, reference: null }],
  shippingAddress: { street: 'Av. Coyoacán', zipCode: '03100' },
};

/**
 * Multi-pet T7 (S4, S14): with backend pets, a newer order whose lines are
 * for them: Nupec 18 kg for the first pet, Royal Canin Mini 2 kg for the
 * second (when there is one).
 */
export function petOrder(pets: readonly EvalPetSeed[]): OrderHistoryResponse {
  const pet = (seed: EvalPetSeed | undefined) =>
    seed === undefined
      ? null
      : {
          id: seed.id,
          name: seed.name,
          species: seed.species,
          status: 'ACTIVE' as const,
        };
  const items: OrderHistoryResponse['items'] = [
    {
      productId: 'a0000000-0000-4000-8000-000000000001',
      variantId: null,
      productName: 'Croquetas Nupec Salmón 18 kg',
      variantName: null,
      quantity: 1,
      unitPriceCents: 159900,
      pet: pet(pets[0]),
    },
  ];
  if (pets[1] !== undefined)
    items.push({
      productId: 'a0000000-0000-4000-8000-000000000003',
      variantId: 'b0000000-0000-4000-8000-000000000301',
      productName: 'Croquetas Royal Canin Mini',
      variantName: '2 kg',
      quantity: 1,
      unitPriceCents: 52900,
      pet: pet(pets[1]),
    });
  const total = items.reduce(
    (sum, item) => sum + item.quantity * item.unitPriceCents,
    0,
  );
  return {
    saleId: SALE_ID(98),
    folio: 'EV-0098',
    confirmedAt: '2026-11-05T18:00:00.000Z',
    channel: 'ONLINE',
    deliveryStatus: 'DELIVERED',
    paymentStatus: 'PAID',
    totalCents: total,
    paidCents: total,
    debtCents: 0,
    items,
    payments: [{ method: 'TRANSFER', amountCents: total, reference: null }],
    shippingAddress: { street: 'Av. Coyoacán', zipCode: '03100' },
  };
}

/** T2 H6: the branch the fake backend reads (`GET /chatbot-api/branch`),
 *  the same store as the pickup checkout, with its pin. */
export const EVAL_BRANCH: BranchInfo = {
  name: 'Tienda de mascotas HoundFe — Sucursal Centro',
  address: {
    addressLine1: 'Av. Insurgentes Sur 1000',
    addressLine2: null,
    neighborhood: 'Del Valle',
    municipality: 'Benito Juárez',
    state: 'Ciudad de México',
    postalCode: '03100',
    formatted:
      'Av. Insurgentes Sur 1000, Del Valle, Benito Juárez, Ciudad de México, 03100',
  },
  hours: {
    timeZone: 'America/Mexico_City',
    days: [],
    summary: 'Lunes a sábado: 09:00–19:00. Domingo: 10:00–14:00.',
  },
  location: { latitude: 19.3907, longitude: -99.1716 },
};
/** T2 H6: the same branch before staff set its coordinates (no pin). */
export const EVAL_BRANCH_WITHOUT_LOCATION: BranchInfo = {
  ...EVAL_BRANCH,
  location: null,
};

const notFound = (method: string) =>
  Promise.reject(new Error(`eval fake: ${method} is not part of the eval`));

/** One line of backend activity the transcript shows next to the turn. */
export type ApiEvent = string;

/**
 * In-memory ChatbotApiClient for the eval: catalog search, stock, pricing,
 * checkout context, order history, shipping quotes by ZIP, idempotent
 * checkout and payment details. Everything else rejects so an unexpected call is visible.
 */
export class EvalFakeApi implements ChatbotApiClient {
  readonly events: ApiEvent[] = [];
  /** Distinct idempotency keys that created a sale. */
  readonly orders = new Map<string, CheckoutResponse>();
  private readonly quotes = new Map<string, number>();
  private quoteSeq = 0;
  /** Order history (latest first); one previous order for an existing
   *  customer, preceded by an order for its pets when it has any (T7). */
  history: OrderHistoryResponse[];
  /** T2 H6: what `getBranch` answers (a scenario may pick the pinless one). */
  branch: BranchInfo = EVAL_BRANCH;

  constructor(private readonly customer: FixtureCustomer) {
    const pets = customer.kind === 'existing' ? (customer.pets ?? []) : [];
    this.history =
      customer.kind === 'existing'
        ? [
            ...(pets.length > 0 ? [petOrder(pets)] : []),
            structuredClone(PREVIOUS_ORDER),
          ]
        : [];
  }

  drainEvents(): ApiEvent[] {
    return this.events.splice(0, this.events.length);
  }

  searchCatalog(q: string, limit = 10) {
    const found = searchFixture(q, limit);
    this.events.push(`searchCatalog("${q}") → ${found.length} result(s)`);
    return Promise.resolve(found.map(toCatalogItem));
  }

  getStock(productId: string) {
    const product = findProduct(productId);
    if (product === undefined) return Promise.reject(new Error('404'));
    return Promise.resolve(toStockCheck(product));
  }

  evaluateCart(items: CartItemInput[]) {
    return Promise.resolve({
      items: items.map((item) => {
        const unit = unitPrice(item.productId, item.variantId);
        return {
          productId: item.productId,
          variantId: item.variantId ?? null,
          quantity: item.quantity,
          unitPriceCents: unit,
          originalPriceCents: unit * item.quantity,
          finalPriceCents: unit * item.quantity,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        };
      }),
      promotionEvaluationStatus: 'fully_evaluated' as const,
      customerResolution:
        this.customer.kind === 'existing'
          ? ('unique' as const)
          : ('not_found' as const),
    });
  }

  getCustomerByPhone() {
    return notFound('getCustomerByPhone');
  }

  private savedAddress(): CheckoutContextAddress | null {
    if (this.customer.kind !== 'existing') return null;
    const address = ADDRESSES[this.customer.zip];
    return {
      id: ADDRESS_ID,
      version: ADDRESS_VERSION,
      label: 'Casa',
      street: address.street,
      exteriorNumber: address.exteriorNumber,
      interiorNumber: null,
      zipCode: this.customer.zip,
      neighborhood: address.neighborhood,
      municipality: address.municipality,
      city: null,
      state: 'Ciudad de México',
      visualReferences: null,
      carrierPhone: null,
    };
  }

  getCustomerCheckoutContext(): Promise<CustomerCheckoutContext> {
    const address = this.savedAddress();
    if (this.customer.kind === 'new' || address === null) {
      this.events.push('getCustomerCheckoutContext → not_found');
      return Promise.resolve({
        status: 'not_found',
        customer: null,
        addresses: [],
        nextAfterAddressId: null,
      });
    }
    this.events.push('getCustomerCheckoutContext → unique (1 address)');
    return Promise.resolve({
      status: 'unique',
      customer: {
        customerId: CUSTOMER_ID,
        firstName: this.customer.firstName,
        lastName: null,
      },
      addresses: [address],
      nextAfterAddressId: null,
    });
  }

  createShippingQuote(
    input: CreateShippingQuoteInput,
  ): Promise<ShippingQuoteResponse> {
    const zip =
      'zipCode' in input.destination
        ? input.destination.zipCode
        : (this.savedAddress()?.zipCode ?? '');
    const eta = (days: number | null) => ({ days, reason: null });
    const deliverable = () => ({
      quoteId: `quote-${++this.quoteSeq}`,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      currency: 'MXN' as const,
    });
    let quote: ShippingQuoteResponse;
    if (zip === '03100') {
      quote = {
        ...deliverable(),
        zoneStatus: 'FREE',
        option: null,
        costCents: 0,
        creditCents: 0,
        customerChargeCents: 0,
        eta: eta(1),
      };
    } else if (zip === '04000') {
      quote = {
        ...deliverable(),
        zoneStatus: 'SURCHARGE',
        option: null,
        costCents: 6900,
        creditCents: 0,
        customerChargeCents: 6900,
        eta: eta(2),
      };
    } else if (zip === '12000') {
      quote = {
        quoteId: null,
        expiresAt: null,
        zoneStatus: 'DENIED',
        option: null,
        costCents: 0,
        creditCents: 0,
        customerChargeCents: 0,
        currency: 'MXN',
        eta: eta(null),
      };
    } else {
      // Credit rule: $120 MXN per unit priced over $500, capped at the cost.
      const credit = input.items.reduce(
        (sum, item) =>
          unitPrice(item.productId, item.variantId) > 50000
            ? sum + 12000 * item.quantity
            : sum,
        0,
      );
      const cost = 14900;
      quote = {
        ...deliverable(),
        zoneStatus: 'CARRIER_ONLY',
        option: { carrier: 'Estafeta', service: 'Terrestre', etaDays: 3 },
        costCents: cost,
        creditCents: Math.min(cost, credit),
        customerChargeCents: Math.max(0, cost - credit),
        eta: eta(3),
      };
    }
    if (quote.quoteId !== null)
      this.quotes.set(quote.quoteId, quote.customerChargeCents);
    this.events.push(
      `createShippingQuote(zip ${zip}) → ${quote.zoneStatus} charge $${(quote.customerChargeCents / 100).toFixed(2)}`,
    );
    return Promise.resolve(quote);
  }

  createCheckout(
    dto: CreateCheckoutInput,
    idempotencyKey: string,
  ): Promise<CheckoutResponse> {
    const replay = this.orders.get(idempotencyKey);
    if (replay !== undefined) {
      this.events.push(
        `createCheckout replay (same key) → ${replay.sale.folio}`,
      );
      return Promise.resolve(replay);
    }
    const n = this.orders.size + 1;
    const folio = `EV-${String(n).padStart(4, '0')}`;
    const total = dto.sale.expectedTotalCents;
    const base = {
      saleId: SALE_ID(n),
      folio,
      paymentStatus: 'CREDIT' as const,
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: total,
      discountCents: 0,
      paidCents: 0,
      debtCents: total,
      confirmedAt: new Date().toISOString(),
    };
    const customer = {
      resolution:
        dto.customer.mode === 'existing'
          ? ('existing' as const)
          : ('created' as const),
      customerId: CUSTOMER_ID,
      firstName:
        dto.customer.mode === 'createIfAbsent'
          ? dto.customer.firstName
          : this.customer.kind === 'existing'
            ? this.customer.firstName
            : 'Cliente',
      lastName: null,
    };
    const shipping = dto.sale.shipping;
    let response: CheckoutResponse;
    if (shipping !== undefined && 'mode' in shipping) {
      response = {
        status: 'created',
        customer,
        address: null,
        sale: { ...base, fulfillmentMode: 'PICKUP' },
        pickupLocation: {
          name: 'Tienda de mascotas HoundFe — Sucursal Centro',
          address: {
            addressLine1: 'Av. Insurgentes Sur 1000',
            addressLine2: null,
            neighborhood: 'Del Valle',
            municipality: 'Benito Juárez',
            state: 'Ciudad de México',
            postalCode: '03100',
            formatted:
              'Av. Insurgentes Sur 1000, Del Valle, Benito Juárez, Ciudad de México, 03100',
          },
          hours: null,
        },
      };
    } else {
      const charge =
        shipping !== undefined ? (this.quotes.get(shipping.quoteId) ?? 0) : 0;
      response = {
        status: 'created',
        customer,
        address: {
          resolution:
            dto.deliveryAddress?.mode === 'newSaved' ? 'created' : 'existing',
          id: ADDRESS_ID,
          version: ADDRESS_VERSION,
        },
        sale: {
          ...base,
          subtotalCents: Math.max(0, total - charge),
          shippingChargeCents: charge,
          fulfillmentMode: 'DELIVERY',
        },
      };
    }
    this.orders.set(idempotencyKey, response);
    this.events.push(
      `createCheckout → ORDER CREATED folio ${folio} total $${(total / 100).toFixed(2)}`,
    );
    return Promise.resolve(response);
  }

  getCheckoutStatus(idempotencyKey: string): Promise<CheckoutStatus> {
    const found = this.orders.get(idempotencyKey);
    return Promise.resolve(
      found === undefined
        ? { status: 'not_observed', checkout: null }
        : { status: 'succeeded', checkout: found },
    );
  }

  getPaymentDetails() {
    return Promise.resolve({
      id: 'pd-eval',
      bankName: 'BBVA',
      beneficiary: 'HoundFe SA de CV',
      clabe: '012180001234567891',
      accountNumber: '0123456789',
      isActive: true,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  }

  getBranch(): Promise<BranchInfo> {
    this.events.push(
      `getBranch → ${this.branch.location === null ? 'no pin' : 'with pin'}`,
    );
    return Promise.resolve(structuredClone(this.branch));
  }

  upsertCustomer() {
    return notFound('upsertCustomer');
  }
  createSale() {
    return notFound('createSale');
  }
  cancelSale() {
    return notFound('cancelSale');
  }
  uploadReceipt() {
    return notFound('uploadReceipt');
  }
  getReceiptOutcome() {
    return notFound('getReceiptOutcome');
  }
  updateDelivery() {
    return notFound('updateDelivery');
  }
  /** Contract §6: `?petId` keeps the orders with a line for that pet (all
   *  their lines); a pet with no orders (e.g. one created during the eval)
   *  answers `[]`. */
  getOrderHistory(
    phone: string,
    phoneCountryCode: string,
    options?: OrderHistoryQuery,
  ) {
    const petId = options?.petId;
    const orders =
      petId === undefined
        ? this.history
        : this.history.filter((order) =>
            order.items.some((item) => item.pet?.id === petId),
          );
    this.events.push(
      `getOrderHistory(${phoneCountryCode} ${phone}${petId === undefined ? '' : ` petId=${petId}`}) → ${orders.length} order(s)`,
    );
    return Promise.resolve(structuredClone(orders));
  }
  submitRestockIntake() {
    return notFound('submitRestockIntake');
  }
  submitExpirationIntake() {
    return notFound('submitExpirationIntake');
  }
  getRestockDecision() {
    return notFound('getRestockDecision');
  }
  getExpirationDecision() {
    return notFound('getExpirationDecision');
  }
  recordRestockApplicationOutcome() {
    return notFound('recordRestockApplicationOutcome');
  }
  submitDeliveryZoneIntake() {
    return notFound('submitDeliveryZoneIntake');
  }
  getDeliveryZoneRequester() {
    return notFound('getDeliveryZoneRequester');
  }
}

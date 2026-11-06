/** Live contract smoke test of the REAL ChatbotApiHttpClient against a dev
 * backend (docs/e2e-contract-smoke.md). WRITES DEV DATA: a customer, a pickup
 * sale (decrements stock) and a PENDING receipt. Never prints the service key,
 * request headers or personal values: only outcomes, ids and key names. */
import { randomUUID } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ChatbotApiHttpClient } from '../../src/chatbot-api/infrastructure/chatbot-api-http.client';
import { ChatbotApiError } from '../../src/chatbot-api/domain/errors';
import type {
  CatalogItemResponse,
  StockCheckResponse,
} from '../../src/chatbot-api/domain/dtos/catalog.dto';
import type { CartEvaluationResult } from '../../src/chatbot-api/domain/dtos/pricing.dto';

const REQUIRED_ENV = [
  'CHATBOT_API_BASE_URL',
  'SERVICE_KEY',
  'CHATBOT_API_BRANCH_ID',
  'CHATBOT_API_CASHIER_USER_ID',
] as const;

/** A valid 1x1 RGBA PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

class StepFailure extends Error {}

function line(step: string, outcome: string, fields: Record<string, unknown>) {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  process.stdout.write(
    `[${step}] ${outcome}${rendered ? ` ${rendered}` : ''}\n`,
  );
}

type KeyTree = string | KeyTree[] | { [key: string]: KeyTree };

/** Key tree of a body: names and JSON types only, never values. */
function keyTree(value: unknown, depth = 0): KeyTree {
  if (Array.isArray(value))
    return value.length === 0 ? '[]' : [keyTree(value[0], depth + 1)];
  if (typeof value === 'object' && value !== null) {
    if (depth > 4) return '{…}';
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, keyTree(v, depth + 1)]),
    );
  }
  return value === null ? 'null' : typeof value;
}

function fail(step: string, error: unknown): never {
  if (error instanceof ChatbotApiError) {
    const parseFailure = /response was invalid/.test(error.message);
    line(step, parseFailure ? 'CONTRACT_MISMATCH' : 'error', {
      status: error.statusCode,
      errorCode: error.errorCode,
      error: error.name,
      message: error.message,
      ...(parseFailure ? { bodyKeys: keyTree(error.responseBody) } : {}),
    });
  } else if (error instanceof StepFailure) {
    line(step, 'FAILED', { reason: error.message });
  } else {
    // Never print raw errors: an Axios error carries the request headers.
    line(step, 'error', {
      error: error instanceof Error ? error.name : typeof error,
    });
  }
  throw new StepFailure(step);
}

/* ---- Structural checks for the three DTOs the client does not parse ---- */

type Spec =
  | 'string'
  | 'number'
  | 'int'
  | 'boolean'
  | 'null'
  | { nullable: Spec }
  | { enum: readonly unknown[] }
  | { array: Spec }
  | { object: Record<string, Spec>; optional?: readonly string[] };

const n = (spec: Spec): Spec => ({ nullable: spec });
const stock: Spec = {
  object: {
    status: {
      enum: ['available', 'low_stock', 'out_of_stock', 'not_managed'],
    },
    quantity: n('int'),
  },
};
const catalogItem: Spec = {
  object: {
    productId: 'string',
    name: 'string',
    brand: n('string'),
    imageUrl: n('string'),
    description: n('string'),
    price: {
      object: {
        priceCents: n('int'),
        fromPriceCents: n('int'),
        promoPriceCents: n('int'),
        promotionEvaluationStatus: { enum: ['needs_human_review'] },
      },
    },
    stock,
    packageInfo: { object: { weightGrams: 'null', dimensions: 'null' } },
    variants: {
      array: {
        object: {
          variantId: 'string',
          name: 'string',
          option: n('string'),
          value: n('string'),
          priceCents: n('int'),
          stock,
        },
      },
    },
  },
};
const stockCheck: Spec = {
  object: {
    productId: 'string',
    name: 'string',
    stock,
    variants: {
      array: {
        object: {
          variantId: 'string',
          name: 'string',
          option: n('string'),
          value: n('string'),
          stock,
        },
      },
    },
  },
};
const cartEvaluation: Spec = {
  object: {
    items: {
      array: {
        object: {
          productId: 'string',
          variantId: n('string'),
          quantity: 'int',
          unitPriceCents: 'int',
          originalPriceCents: 'int',
          finalPriceCents: 'int',
          appliedPromotionTitle: n('string'),
          discountAmountCents: 'int',
        },
      },
    },
    promotionEvaluationStatus: {
      enum: ['fully_evaluated', 'needs_human_review'],
    },
    customerResolution: {
      enum: ['unique', 'not_found', 'ambiguous', 'not_provided'],
    },
  },
  optional: ['customerResolution'],
};

/** Returns problems as `path: description` with key names only. */
function check(value: unknown, spec: Spec, path = '$'): string[] {
  if (typeof spec === 'object' && 'nullable' in spec)
    return value === null ? [] : check(value, spec.nullable, path);
  if (spec === 'null') return value === null ? [] : [`${path}: expected null`];
  if (spec === 'string')
    return typeof value === 'string' ? [] : [`${path}: expected string`];
  if (spec === 'boolean')
    return typeof value === 'boolean' ? [] : [`${path}: expected boolean`];
  if (spec === 'number')
    return typeof value === 'number' ? [] : [`${path}: expected number`];
  if (spec === 'int')
    return Number.isSafeInteger(value) ? [] : [`${path}: expected integer`];
  if ('enum' in spec)
    return spec.enum.includes(value)
      ? []
      : [`${path}: value outside enum (${typeof value})`];
  if ('array' in spec) {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    return value.flatMap((item, i) => check(item, spec.array, `${path}[${i}]`));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return [`${path}: expected object`];
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(spec.object)) {
    if (!(key in record)) {
      if (!spec.optional?.includes(key))
        problems.push(`${path}.${key}: missing key`);
      continue;
    }
    problems.push(...check(record[key], spec.object[key], `${path}.${key}`));
  }
  for (const key of Object.keys(record))
    if (!(key in spec.object)) problems.push(`${path}.${key}: unexpected key`);
  return problems;
}

function assertShape(step: string, value: unknown, spec: Spec): void {
  const problems = check(value, spec);
  if (problems.length > 0) {
    line(step, 'CONTRACT_MISMATCH', { problems });
    throw new StepFailure(step);
  }
}

function sellable(s: { status: string; quantity: number | null }): boolean {
  return (
    ['available', 'low_stock'].includes(s.status) &&
    Number.isSafeInteger(s.quantity) &&
    (s.quantity as number) >= 1
  );
}

async function main(): Promise<void> {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    process.stderr.write(`missing env: ${missing.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }
  const cashierUserId = process.env.CHATBOT_API_CASHIER_USER_ID as string;
  // Same config shape the Nest module reads (src/config/configuration.ts).
  const config = new ConfigService({
    chatbotApi: {
      baseUrl: process.env.CHATBOT_API_BASE_URL,
      serviceKey: process.env.SERVICE_KEY,
      branchId: process.env.CHATBOT_API_BRANCH_ID,
      cashierUserId,
    },
  });
  // HttpModule's default provider is the global axios instance.
  const client = new ChatbotApiHttpClient(new HttpService(axios), config);

  const runId = Date.now();
  const phoneCountryCode = '52';
  const suffix = String(Math.floor(runId / 60_000) % 10_000).padStart(4, '0');
  const phone = `550000${suffix}`;
  line('setup', 'ok', {
    runId,
    phone: `${phoneCountryCode} 55 0000 ${suffix}`,
  });

  // 1. Catalog search.
  let product: CatalogItemResponse | undefined;
  let variant: CatalogItemResponse['variants'][number] | undefined;
  for (const q of ['croqueta', 'croquetas', 'alimento', 'perro', 'a']) {
    let items: CatalogItemResponse[];
    try {
      items = await client.searchCatalog(q, 20);
    } catch (error) {
      fail('1.searchCatalog', error);
    }
    if (!Array.isArray(items))
      fail('1.searchCatalog', new StepFailure('body is not an array'));
    items.forEach((item, i) =>
      assertShape(`1.searchCatalog[${i}]`, item, catalogItem),
    );
    for (const item of items) {
      if (item.variants.length > 0) {
        const v = item.variants.find(
          (candidate) =>
            sellable(candidate.stock) && candidate.priceCents !== null,
        );
        if (v) {
          product = item;
          variant = v;
          break;
        }
      } else if (sellable(item.stock) && item.price.priceCents !== null) {
        product = item;
        break;
      }
    }
    line('1.searchCatalog', 'ok', {
      q,
      results: items.length,
      picked: product?.productId ?? null,
    });
    if (product) break;
  }
  if (!product)
    fail(
      '1.searchCatalog',
      new StepFailure(
        'BACKEND_DATA: no product with sellable stock >= 1 and a price',
      ),
    );
  const productId = product.productId;
  const variantId = variant?.variantId;
  const catalogPrice = (
    variant ? variant.priceCents : product.price.priceCents
  ) as number;
  line('1.pick', 'ok', {
    productId,
    variantId: variantId ?? null,
    name: product.name,
    variantName: variant?.name ?? null,
    priceCents: catalogPrice,
    stock: (variant ?? product).stock,
  });

  // 2. Stock.
  let stockResult: StockCheckResponse;
  try {
    stockResult = await client.getStock(productId);
  } catch (error) {
    fail('2.getStock', error);
  }
  assertShape('2.getStock', stockResult, stockCheck);
  const stockLine = variantId
    ? stockResult.variants.find((v) => v.variantId === variantId)?.stock
    : stockResult.stock;
  if (!stockLine || !sellable(stockLine))
    fail(
      '2.getStock',
      new StepFailure('picked line is not sellable in the stock read'),
    );
  line('2.getStock', 'ok', {
    productId: stockResult.productId,
    stock: stockLine,
    variants: stockResult.variants.length,
  });

  // 3. Cart evaluation + the line invariants minimal-cart.service enforces.
  const cartItem = {
    productId,
    ...(variantId ? { variantId } : {}),
    quantity: 1,
    unitPriceCents: catalogPrice,
  };
  let evaluation: CartEvaluationResult;
  try {
    evaluation = await client.evaluateCart([cartItem], {
      phoneCountryCode,
      phone,
    });
  } catch (error) {
    fail('3.evaluateCart', error);
  }
  assertShape('3.evaluateCart', evaluation, cartEvaluation);
  const evaluated = evaluation.items[0];
  const invariants: string[] = [];
  if (evaluation.items.length !== 1) invariants.push('items.length !== 1');
  if (evaluated.productId !== productId) invariants.push('productId differs');
  if ((evaluated.variantId ?? undefined) !== variantId)
    invariants.push('variantId differs');
  if (evaluated.quantity !== 1) invariants.push('quantity differs');
  if (evaluated.originalPriceCents !== evaluated.unitPriceCents * 1)
    invariants.push('originalPriceCents !== unitPriceCents * quantity');
  if (
    evaluated.finalPriceCents + evaluated.discountAmountCents !==
    evaluated.originalPriceCents
  )
    invariants.push(
      'finalPriceCents + discountAmountCents !== originalPriceCents',
    );
  if (
    [
      evaluated.unitPriceCents,
      evaluated.finalPriceCents,
      evaluated.discountAmountCents,
    ].some((v) => v < 0)
  )
    invariants.push('negative money');
  if (invariants.length > 0) {
    line('3.evaluateCart', 'CONTRACT_MISMATCH', { invariants });
    throw new StepFailure('3.evaluateCart');
  }
  const merchandiseTotal = evaluation.items.reduce(
    (sum, i) => sum + i.finalPriceCents,
    0,
  );
  line('3.evaluateCart', 'ok', {
    unitPriceCents: evaluated.unitPriceCents,
    originalPriceCents: evaluated.originalPriceCents,
    finalPriceCents: evaluated.finalPriceCents,
    discountAmountCents: evaluated.discountAmountCents,
    appliedPromotionTitle: evaluated.appliedPromotionTitle,
    promotionEvaluationStatus: evaluation.promotionEvaluationStatus,
    customerResolution: evaluation.customerResolution ?? '(omitted)',
    merchandiseTotal,
  });

  // 4. Checkout context lookup (strict parser inside the client).
  try {
    const context = await client.getCustomerCheckoutContext(
      phoneCountryCode,
      phone,
    );
    line(
      '4.getCustomerCheckoutContext',
      context.status === 'not_found' ? 'ok' : 'UNEXPECTED',
      {
        status: context.status,
        addresses: context.addresses.length,
      },
    );
    if (context.status !== 'not_found')
      throw new StepFailure(
        'expected not_found for a fresh phone (rerun in another minute)',
      );
  } catch (error) {
    fail('4.getCustomerCheckoutContext', error);
  }

  // 5. Shipping quote for a loose destination; failures here are reported
  // but do not stop the run (checkout below is pickup).
  const destination = {
    zipCode: '64000',
    state: 'Nuevo León',
    municipality: 'Monterrey',
    neighborhood: 'Centro',
  };
  try {
    const quote = await client.createShippingQuote({
      items: [{ productId, ...(variantId ? { variantId } : {}), quantity: 1 }],
      phoneCountryCode,
      phone,
      destination,
    });
    line('5.createShippingQuote', 'ok', {
      zoneStatus: quote.zoneStatus,
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt,
      costCents: quote.costCents,
      creditCents: quote.creditCents,
      customerChargeCents: quote.customerChargeCents,
      option: quote.option,
      eta: quote.eta,
    });
    if (quote.zoneStatus === 'PENDING') {
      const sourceRequestId = randomUUID();
      const requester = await client.submitDeliveryZoneIntake({
        sourceRequestId,
        type: 'DELIVERY_ZONE',
        ...destination,
        phoneCountryCode,
        phone,
        conversationRef: `e2e:contract-smoke-${runId}`,
        lastCustomerMessageAt: new Date().toISOString(),
      });
      line('5.submitDeliveryZoneIntake', 'ok', {
        requesterId: requester.id,
        status: requester.status,
        version: requester.version,
        decisionId: requester.decisionId,
        resolution: requester.resolution,
      });
      const polled = await client.getDeliveryZoneRequester(requester.id);
      line('5.getDeliveryZoneRequester', 'ok', {
        status: polled.status,
        version: polled.version,
        resolution: polled.resolution,
      });
    }
  } catch (error) {
    if (
      error instanceof ChatbotApiError &&
      !/response was invalid/.test(error.message) &&
      error.statusCode !== null &&
      [404, 409, 422, 503].includes(error.statusCode)
    ) {
      line('5.shipping', 'error (non-fatal, backend data/config)', {
        status: error.statusCode,
        errorCode: error.errorCode,
      });
    } else {
      fail('5.shipping', error);
    }
  }

  // 6. Pickup checkout + status replay.
  const checkoutKey = `e2e-checkout-${runId}`;
  let saleId: string;
  try {
    const checkout = await client.createCheckout(
      {
        phoneCountryCode,
        phone,
        customer: { mode: 'createIfAbsent', firstName: 'E2E Prueba' },
        sale: {
          cashierUserId,
          items: [
            {
              productId,
              variantId: variantId ?? null,
              productName: product.name,
              variantName: variant?.name ?? null,
              quantity: 1,
              unitPriceCents: evaluated.unitPriceCents,
            },
          ],
          expectedTotalCents: merchandiseTotal,
          shipping: { mode: 'pickup' },
        },
      },
      checkoutKey,
    );
    saleId = checkout.sale.saleId;
    const pickup =
      'pickupLocation' in checkout ? checkout.pickupLocation : null;
    line('6.createCheckout', 'ok', {
      saleId,
      folio: checkout.sale.folio,
      totalCents: checkout.sale.totalCents,
      debtCents: checkout.sale.debtCents,
      paymentStatus: checkout.sale.paymentStatus,
      fulfillmentMode: checkout.sale.fulfillmentMode,
      customerResolution: checkout.customer.resolution,
      'pickupLocation.name': pickup?.name ?? null,
      'pickupLocation.address.formatted': pickup?.address?.formatted ?? null,
      'pickupLocation.hours.summary': pickup?.hours?.summary ?? null,
    });
    if (checkout.sale.fulfillmentMode !== 'PICKUP')
      throw new StepFailure('expected fulfillmentMode PICKUP');
  } catch (error) {
    fail('6.createCheckout', error);
  }
  try {
    const status = await client.getCheckoutStatus(checkoutKey);
    const replayedId = status.checkout?.sale.saleId ?? null;
    line('6.getCheckoutStatus', replayedId === saleId ? 'ok' : 'UNEXPECTED', {
      status: status.status,
      saleId: replayedId,
      sameSale: replayedId === saleId,
    });
    if (status.status !== 'succeeded' || replayedId !== saleId)
      throw new StepFailure(
        'status must replay the same sale with a strict body',
      );
  } catch (error) {
    fail('6.getCheckoutStatus', error);
  }

  // 7. Receipt upload + idempotent replay.
  const mediaKey = `e2e-media-${runId}`;
  const file = {
    bytes: PNG_1X1,
    mimeType: 'image/png' as const,
    filename: 'e2e.png',
  };
  let receiptId: string;
  try {
    const first = await client.uploadReceipt(saleId, file, {}, mediaKey);
    receiptId = first.receiptId;
    line('7.uploadReceipt', 'ok', {
      receiptId,
      status: first.status,
      previewStatus: first.previewStatus,
      mimeType: first.mimeType,
      sizeBytes: first.sizeBytes,
      extraKeys: Object.keys(first).filter(
        (k) =>
          ![
            'receiptId',
            'status',
            'mimeType',
            'sizeBytes',
            'sha256',
            'previewStatus',
          ].includes(k),
      ),
    });
    const replay = await client.uploadReceipt(saleId, file, {}, mediaKey);
    line(
      '7.uploadReceipt(replay)',
      replay.receiptId === receiptId ? 'ok' : 'UNEXPECTED',
      {
        receiptId: replay.receiptId,
        sameReceipt: replay.receiptId === receiptId,
      },
    );
    if (replay.receiptId !== receiptId)
      throw new StepFailure(
        'replay with the same key returned a different receipt',
      );
  } catch (error) {
    fail('7.uploadReceipt', error);
  }

  // 8. Receipt outcome.
  try {
    const outcome = await client.getReceiptOutcome(receiptId);
    line(
      '8.getReceiptOutcome',
      outcome.status === 'PENDING' ? 'ok' : 'UNEXPECTED',
      {
        status: outcome.status,
        customerReason: outcome.customerReason,
        'sale.debtCents': outcome.sale.debtCents,
        'sale.paymentStatus': outcome.sale.paymentStatus,
      },
    );
    if (outcome.status !== 'PENDING') throw new StepFailure('expected PENDING');
  } catch (error) {
    fail('8.getReceiptOutcome', error);
  }

  line('done', 'ok', { saleId, receiptId });
}

main().catch((error: unknown) => {
  if (!(error instanceof StepFailure))
    process.stderr.write(
      `unexpected runtime error: ${error instanceof Error ? error.name : typeof error}\n`,
    );
  process.exitCode = 1;
});

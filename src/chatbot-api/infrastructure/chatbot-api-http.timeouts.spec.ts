import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { throwError } from 'rxjs';
import { UpstreamError } from '../domain/errors';
import { RECEIPT_UPLOAD_TIMEOUT_MS } from '../domain/dtos/receipt-upload.dto';
import {
  CHATBOT_API_TIMEOUTS_MS,
  ChatbotApiHttpClient,
} from './chatbot-api-http.client';

const id = '11111111-1111-4111-8111-111111111111';
// The error axios raises when `timeout` elapses: a code and no response.
const axiosTimeout = () =>
  throwError(() =>
    Object.assign(new Error('timeout of 10000ms exceeded'), {
      code: 'ECONNABORTED',
    }),
  );

const checkoutInput = {
  phoneCountryCode: '52',
  phone: '5512345678',
  customer: { mode: 'existing' as const, customerId: id },
  deliveryAddress: {
    mode: 'existing' as const,
    addressId: id,
    expectedVersion: '2026-06-22T00:00:00.000Z',
  },
  sale: {
    cashierUserId: id,
    items: [
      { productId: id, productName: 'Food', quantity: 1, unitPriceCents: 1 },
    ],
    expectedTotalCents: 1,
    shipping: { quoteId: 'quote-1' },
  },
};

describe('chatbot-api per-request timeouts', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let sleep: jest.Mock;
  let client: ChatbotApiHttpClient;
  beforeEach(() => {
    const http = new HttpService();
    request = jest.spyOn(http, 'request').mockImplementation(axiosTimeout);
    sleep = jest.fn().mockResolvedValue(undefined);
    client = new ChatbotApiHttpClient(
      http,
      new ConfigService({
        chatbotApi: {
          baseUrl: 'https://example.invalid',
          serviceKey: 'svc_test',
          branchId: 'branch',
        },
      }),
      sleep,
    );
  });

  const sentTimeouts = () => request.mock.calls.map(([cfg]) => cfg.timeout);

  it('keeps every value bounded and the slow routes above the backend deadlines', () => {
    expect(CHATBOT_API_TIMEOUTS_MS).toEqual({
      default: 10_000,
      checkout: 30_000,
      shippingQuote: 45_000,
      receiptUpload: RECEIPT_UPLOAD_TIMEOUT_MS,
    });
    expect(RECEIPT_UPLOAD_TIMEOUT_MS).toBe(90_000);
  });

  const reads: Array<[string, (c: ChatbotApiHttpClient) => Promise<unknown>]> =
    [
      ['searchCatalog', (c) => c.searchCatalog('croquetas')],
      ['getStock', (c) => c.getStock(id)],
      ['getCustomerByPhone', (c) => c.getCustomerByPhone('52', '5512345678')],
      [
        'getCustomerCheckoutContext',
        (c) => c.getCustomerCheckoutContext('52', '5512345678'),
      ],
      ['getCheckoutStatus', (c) => c.getCheckoutStatus('checkout-key')],
      ['getReceiptOutcome', (c) => c.getReceiptOutcome(id)],
      ['getOrderHistory', (c) => c.getOrderHistory('5512345678', '52')],
      ['getPaymentDetails', (c) => c.getPaymentDetails()],
      ['getRestockDecision', (c) => c.getRestockDecision(id)],
      ['getExpirationDecision', (c) => c.getExpirationDecision(id)],
      ['getDeliveryZoneRequester', (c) => c.getDeliveryZoneRequester(id)],
    ];

  it.each(reads)(
    '%s retries a timed-out GET three times, each bounded by the default timeout',
    async (_name, call) => {
      const error: unknown = await call(client).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).statusCode).toBeNull();
      expect(sentTimeouts()).toEqual([
        CHATBOT_API_TIMEOUTS_MS.default,
        CHATBOT_API_TIMEOUTS_MS.default,
        CHATBOT_API_TIMEOUTS_MS.default,
      ]);
      expect(sleep).toHaveBeenCalledTimes(2);
    },
  );

  const writes: Array<
    [string, number, (c: ChatbotApiHttpClient) => Promise<unknown>]
  > = [
    [
      'evaluateCart',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) =>
        c.evaluateCart([{ productId: id, quantity: 1, unitPriceCents: 100 }]),
    ],
    [
      'upsertCustomer',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) =>
        c.upsertCustomer({
          firstName: 'Ana',
          phoneCountryCode: '52',
          phone: '5512345678',
          address: { street: 'Centro' },
        }),
    ],
    [
      'updateDelivery',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) => c.updateDelivery(id, { carrierName: 'DHL' }),
    ],
    [
      'cancelSale',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) =>
        c.cancelSale(id, { reason: 'CUSTOMER_REQUEST', cashierUserId: id }),
    ],
    [
      'recordRestockApplicationOutcome',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) =>
        c.recordRestockApplicationOutcome(id, {
          attemptId: '88888888-8888-4888-8888-888888888888',
          expectedResolutionVersion: 2,
          outcome: 'STALE',
        }),
    ],
    [
      'submitRestockIntake',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) =>
        c.submitRestockIntake({
          sourceRequestId: id,
          type: 'RESTOCK',
          productId: '22222222-2222-4222-8222-222222222222',
          productName: 'Croquetas Premium',
          variantId: null,
          sku: null,
          requestedQuantity: 2,
          observedStockAtRequest: 0,
          stockObservedAt: '2026-08-25T12:00:00.000Z',
          supersedesDecisionId: null,
        }),
    ],
    [
      'submitExpirationIntake',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) =>
        c.submitExpirationIntake({
          sourceRequestId: id,
          type: 'EXPIRATION',
          productId: '22222222-2222-4222-8222-222222222222',
          variantId: null,
        }),
    ],
    [
      'submitDeliveryZoneIntake',
      CHATBOT_API_TIMEOUTS_MS.default,
      (c) =>
        c.submitDeliveryZoneIntake({
          sourceRequestId: '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b',
          type: 'DELIVERY_ZONE',
          zipCode: '06700',
          state: 'Ciudad de México',
          municipality: 'Cuauhtémoc',
          neighborhood: 'Roma Norte',
          phoneCountryCode: '52',
          phone: '5512345678',
          conversationRef: 'wa:5215512345678',
          lastCustomerMessageAt: '2026-11-05T10:00:00.000Z',
        }),
    ],
    [
      'createShippingQuote',
      CHATBOT_API_TIMEOUTS_MS.shippingQuote,
      (c) =>
        c.createShippingQuote({
          items: [{ productId: id, quantity: 2 }],
          phoneCountryCode: '52',
          phone: '5512345678',
          destination: { shippingAddressId: id },
        }),
    ],
    [
      'createCheckout',
      CHATBOT_API_TIMEOUTS_MS.checkout,
      (c) => c.createCheckout(checkoutInput, 'checkout-key'),
    ],
    [
      'createSale',
      CHATBOT_API_TIMEOUTS_MS.checkout,
      (c) =>
        c.createSale(
          {
            cashierUserId: id,
            customerId: id,
            items: [
              {
                productId: id,
                productName: 'Food',
                quantity: 1,
                unitPriceCents: 100,
              },
            ],
          },
          'sale-key',
        ),
    ],
    [
      'uploadReceipt',
      CHATBOT_API_TIMEOUTS_MS.receiptUpload,
      (c) =>
        c.uploadReceipt(
          id,
          {
            bytes: Buffer.from('%PDF-1.7 receipt'),
            mimeType: 'application/pdf',
            filename: 'receipt.pdf',
          },
          { declared: { amountCents: 100 } },
          'wamid-media-1',
        ),
    ],
  ];

  it.each(writes)(
    '%s sends one bounded attempt (%i ms) and never retries a timeout',
    async (_name, timeout, call) => {
      const error: unknown = await call(client).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect(sentTimeouts()).toEqual([timeout]);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('a timed-out checkout POST stays an unknown outcome (no status) that recovery reads back', async () => {
    const error: unknown = await client
      .createCheckout(checkoutInput, 'checkout-key')
      .catch((e: unknown) => e);
    // statusCode null is what the order service keeps the key on.
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ statusCode: null, errorCode: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: '/chatbot-api/checkouts',
      headers: { 'X-Idempotency-Key': 'checkout-key' },
    });
  });
});

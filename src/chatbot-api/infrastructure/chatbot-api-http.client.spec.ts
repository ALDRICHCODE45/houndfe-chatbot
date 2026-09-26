import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import {
  AuthError,
  BranchMismatchError,
  ChatbotApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';
import { CancelSaleInputSchema } from '../domain/dtos/sales.dto';
import type { BotSaleShippingInput } from '../domain/dtos/sales.dto';
import type {
  RestockApplicationOutcomeRequest,
  RestockIntakeInput,
} from '../domain/dtos/human-decisions.dto';

// Complete, type-safe `AxiosResponse` fixture. The client consumes
// `httpService.request<T>()`, which resolves to `AxiosResponse<T>`, so a bare
// `{ data }` object is not assignable. The full shape (including the required
// `AxiosHeaders` config) keeps the response stream typed without erasure.
function axiosResponse<T>(data: T, status = 200): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

describe('ChatbotApiHttpClient', () => {
  // The client's constructor requires a full `HttpService`, so a partial Jest
  // mock cannot be passed without an unsafe cast. We build a real `HttpService`,
  // install the `request` spy before the client is constructed so no test can
  // reach the network, and pass the real service to the client while keeping a
  // typed handle to that same spy as `httpService`.
  let httpService: { request: jest.SpiedFunction<HttpService['request']> };
  let configService: ConfigService;
  let sleep: jest.Mock<Promise<void>, [number]>;
  let client: ChatbotApiHttpClient;

  beforeEach(() => {
    const service = new HttpService();

    httpService = {
      request: jest
        .spyOn(service, 'request')
        .mockImplementation(() =>
          throwError(() => new Error('unexpected network request')),
        ),
    };

    // In-memory `ConfigService`: `chatbotApi.*` and
    // `receiptMedia.attachTimeoutMs` resolve through the internal config via
    // dot-notation, matching the production runtime contract instead of a
    // partial mock of the overloaded `getOrThrow`.
    configService = new ConfigService({
      chatbotApi: {
        baseUrl: 'https://backend.example.com',
        serviceKey: 'svc_test_key',
        branchId: 'branch-123',
      },
      receiptMedia: { attachTimeoutMs: 15000 },
    });

    sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);

    client = new ChatbotApiHttpClient(service, configService, sleep);
  });

  it('sends Bearer and X-Branch-Id headers on read requests', async () => {
    httpService.request.mockReturnValue(of(axiosResponse([])));

    await expect(client.searchCatalog('croquetas', 5)).resolves.toEqual([]);

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://backend.example.com',
        method: 'GET',
        url: '/chatbot-api/catalog/search',
        params: {
          q: 'croquetas',
          limit: 5,
        },
        headers: {
          Authorization: 'Bearer svc_test_key',
          'X-Branch-Id': 'branch-123',
        },
      }),
    );
  });

  it('rejects a different branch context before sending the request', async () => {
    await expect(
      (
        client as unknown as {
          request: (config: unknown, options?: unknown) => Promise<unknown>;
        }
      ).request(
        {
          method: 'GET',
          url: '/chatbot-api/catalog/search',
        },
        {
          branchId: 'branch-999',
        },
      ),
    ).rejects.toBeInstanceOf(BranchMismatchError);

    expect(httpService.request).not.toHaveBeenCalled();
  });

  it('retries transient GET failures with exponential backoff and succeeds on a later attempt', async () => {
    httpService.request
      .mockReturnValueOnce(
        throwError(() => ({
          response: {
            status: 503,
            data: { message: 'temporary outage' },
          },
        })),
      )
      .mockReturnValueOnce(
        throwError(() => ({
          code: 'ECONNRESET',
          message: 'socket hang up',
        })),
      )
      .mockReturnValueOnce(
        of(
          axiosResponse({
            found: true,
            customer: {
              customerId: 'customer-1',
              firstName: 'Aldrich',
              lastName: null,
              phoneCountryCode: '52',
              phone: '5550001111',
              preferredPaymentMethod: null,
              address: null,
            },
          }),
        ),
      );

    await expect(
      client.getCustomerByPhone('52', '5550001111'),
    ).resolves.toEqual({
      found: true,
      customer: {
        customerId: 'customer-1',
        firstName: 'Aldrich',
        lastName: null,
        phoneCountryCode: '52',
        phone: '5550001111',
        preferredPaymentMethod: null,
        address: null,
      },
    });

    expect(httpService.request).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it('does not blindly retry POST requests on upstream 5xx errors', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 503,
          data: { message: 'temporary outage' },
        },
      })),
    );

    await expect(
      client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          items: [
            {
              productId: 'product-1',
              productName: 'Croquetas',
              quantity: 1,
              unitPriceCents: 10000,
            },
          ],
        },
        'idem-1',
      ),
    ).rejects.toBeInstanceOf(UpstreamError);

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('surfaces 429 responses as RateLimitError with Retry-After and does not retry', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 429,
          headers: {
            'retry-after': '7',
          },
          data: { message: 'slow down' },
        },
      })),
    );

    await expect(
      client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          items: [
            {
              productId: 'product-1',
              productName: 'Croquetas',
              quantity: 1,
              unitPriceCents: 10000,
            },
          ],
        },
        'idem-2',
      ),
    ).rejects.toEqual(expect.objectContaining({ retryAfterSeconds: 7 }));

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [401, AuthError],
    [403, ForbiddenError],
    [404, NotFoundError],
  ])('maps HTTP %i to %p', async (statusCode, ErrorType) => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: statusCode,
          data: { message: `status ${statusCode}` },
        },
      })),
    );

    await expect(client.getStock('product-123')).rejects.toBeInstanceOf(
      ErrorType,
    );
    expect(httpService.request).toHaveBeenCalledTimes(1);
  });

  it('sets X-Idempotency-Key when creating a sale', async () => {
    httpService.request.mockReturnValue(
      of(
        axiosResponse({
          saleId: 'sale-1',
          folio: 'F-001',
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 10000,
          paidCents: 0,
          debtCents: 10000,
          confirmedAt: null,
        }),
      ),
    );

    await client.createSale(
      {
        cashierUserId: 'cashier-1',
        customerId: 'customer-1',
        items: [
          {
            productId: 'product-1',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 10000,
          },
        ],
      },
      'idem-3',
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/chatbot-api/sales',
        headers: expect.objectContaining({
          'X-Idempotency-Key': 'idem-3',
        }) as Record<string, string>,
      }),
    );
  });

  it('parses Retry-After into a typed RateLimitError instance', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 429,
          headers: {
            'retry-after': '12',
          },
          data: { message: 'later' },
        },
      })),
    );

    try {
      await client.searchCatalog('croquetas');
      fail('Expected RateLimitError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBe(12);
    }
  });

  it('percent-encodes the phone path segment in getOrderHistory', async () => {
    httpService.request.mockReturnValue(of(axiosResponse([])));

    await client.getOrderHistory('+5215550001111', '52');

    const requestConfig = httpService.request.mock.calls[0]?.[0];
    const url = requestConfig?.url;

    expect(url).toContain('%2B5215550001111');
    expect(url).not.toContain('+5215550001111');
  });

  it('percent-encodes a phone containing a slash to block path traversal', async () => {
    httpService.request.mockReturnValue(of(axiosResponse([])));

    await client.getOrderHistory('/555/0001111', '52');

    const requestConfig = httpService.request.mock.calls[0]?.[0];
    const url = requestConfig?.url;

    expect(url).toContain('%2F555%2F0001111');
    expect(url).not.toContain('/555/0001111');
  });

  it('percent-encodes productId, saleId, and order-history phone segments', async () => {
    httpService.request.mockReturnValue(of(axiosResponse({})));

    await client.getStock('prod+with/slash');
    await client
      .attachReceipt('sale+id/1', {
        mediaUrl: 'https://example.com/r.jpg',
        declaredAmountCents: 1000,
      })
      .catch(() => undefined);
    await client
      .updateDelivery('sale+id/2', {
        carrierName: 'DHL',
      })
      .catch(() => undefined);
    await client.getOrderHistory('+52/15550001111', '52');

    const urls = httpService.request.mock.calls.map(
      ([cfg]) => (cfg as { url: string }).url,
    );

    expect(urls[0]).toBe('/chatbot-api/catalog/prod%2Bwith%2Fslash/stock');
    expect(urls[1]).toBe('/chatbot-api/sales/sale%2Bid%2F1/receipts');
    expect(urls[2]).toBe('/chatbot-api/sales/sale%2Bid%2F2/delivery');
    expect(urls[3]).toBe(
      '/chatbot-api/customers/by-phone/%2B52%2F15550001111/orders',
    );
  });

  it('rejects with UpstreamError after 3 attempts and 2 backoff sleeps when GET keeps returning 503', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 503,
          data: { message: 'still down' },
        },
      })),
    );

    await expect(client.searchCatalog('croquetas')).rejects.toBeInstanceOf(
      UpstreamError,
    );

    expect(httpService.request).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it('returns RateLimitError with retryAfterSeconds=null when Retry-After is an HTTP-date', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 429,
          headers: {
            'retry-after': 'Wed, 21 Oct 2025 07:28:00 GMT',
          },
          data: { message: 'slow down' },
        },
      })),
    );

    try {
      await client.searchCatalog('croquetas');
      fail('Expected RateLimitError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBeNull();
    }
  });

  it('clamps parseRetryAfter to 0 when the header value is negative', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 429,
          headers: {
            'retry-after': '-5',
          },
          data: { message: 'invalid' },
        },
      })),
    );

    try {
      await client.searchCatalog('croquetas');
      fail('Expected RateLimitError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBe(0);
    }
  });

  // ─── Q3 errorCode passthrough + expectedTotalCents wire / discountCents / getPaymentDetails

  it('surfaces errorCode=PROMO_RE_QUOTE on the thrown ChatbotApiError with statusCode 409 and the three numeric payload fields', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 409,
          data: {
            statusCode: 409,
            error: 'PROMO_RE_QUOTE',
            message: 'Price changed',
            recomputedTotalCents: 900,
            expectedTotalCents: 1000,
            discountCents: 100,
          },
        },
      })),
    );

    try {
      await client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          items: [
            {
              productId: 'product-1',
              productName: 'Croquetas',
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
          expectedTotalCents: 1000,
        },
        'idem-pr',
      );
      fail('Expected ChatbotApiError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as ChatbotApiError).statusCode).toBe(409);
      expect((error as ChatbotApiError).errorCode).toBe('PROMO_RE_QUOTE');
      expect((error as ChatbotApiError).responseBody).toEqual({
        statusCode: 409,
        error: 'PROMO_RE_QUOTE',
        message: 'Price changed',
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      });
    }
  });

  it('sets errorCode=null when the 422 body has no error field (legacy backend)', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 422,
          data: { statusCode: 422, message: 'Validation failed' },
        },
      })),
    );

    try {
      await client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          items: [
            {
              productId: 'product-1',
              productName: 'Croquetas',
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
        },
        'idem-422',
      );
      fail('Expected ChatbotApiError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as ChatbotApiError).statusCode).toBe(422);
      expect((error as ChatbotApiError).errorCode).toBeNull();
    }
  });

  it('populates errorCode on every status-mapped error subclass when the body carries it', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: 'AUTH_REQUIRED' }, 'AUTH_REQUIRED'],
      [403, { error: 'FORBIDDEN' }, 'FORBIDDEN'],
      [404, { error: 'NO_ACTIVE_PAYMENT_DETAIL' }, 'NO_ACTIVE_PAYMENT_DETAIL'],
      [429, { error: 'RATE_LIMIT' }, 'RATE_LIMIT'],
      [503, { error: 'BOOM' }, 'BOOM'],
    ];
    for (const [status, body, code] of cases) {
      httpService.request.mockReturnValue(
        throwError(() => ({ response: { status, data: body } })),
      );
      try {
        await client.getStock('product-x');
        fail(`Expected error for status ${status}`);
      } catch (error) {
        expect((error as ChatbotApiError).errorCode).toBe(code);
      }
    }
  });

  it('transport-level failure yields an UpstreamError without errorCode on it', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({ code: 'ECONNRESET', message: 'socket hang up' })),
    );
    try {
      await client.getStock('product-1');
      fail('Expected UpstreamError');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as ChatbotApiError).statusCode).toBeNull();
      expect((error as ChatbotApiError).errorCode).toBeNull();
    }
  });

  it('forwards expectedTotalCents when present in the createSale DTO', async () => {
    httpService.request.mockReturnValue(
      of(
        axiosResponse({
          saleId: 'sale-1',
          folio: null,
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 1000,
          paidCents: 0,
          debtCents: 1000,
          confirmedAt: null,
          discountCents: 0,
        }),
      ),
    );
    await client.createSale(
      {
        cashierUserId: 'cashier-1',
        customerId: 'customer-1',
        expectedTotalCents: 1500,
        items: [
          {
            productId: 'product-1',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 1500,
          },
        ],
      },
      'idem-fwd',
    );
    const cfg = httpService.request.mock.calls[0]?.[0] as { data: unknown };
    expect(cfg.data).toMatchObject({ expectedTotalCents: 1500 });
  });

  it('omits expectedTotalCents entirely when absent or null in the DTO (no key, no 0, no null)', async () => {
    httpService.request.mockReturnValue(
      of(
        axiosResponse({
          saleId: 'sale-1',
          folio: null,
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 1000,
          paidCents: 0,
          debtCents: 1000,
          confirmedAt: null,
          discountCents: 0,
        }),
      ),
    );
    await client.createSale(
      {
        cashierUserId: 'cashier-1',
        customerId: 'customer-1',
        expectedTotalCents: null,
        items: [
          {
            productId: 'product-1',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      },
      'idem-null',
    );
    const cfg = httpService.request.mock.calls[0]?.[0] as { data: unknown };
    const serialized = JSON.stringify(cfg.data);
    expect(serialized).not.toContain('expectedTotalCents');
  });

  it('rejects negative expectedTotalCents via Zod before any HTTP call is made', async () => {
    let rejected = false;
    try {
      await client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          expectedTotalCents: -10,
          items: [
            {
              productId: 'product-1',
              productName: 'Croquetas',
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
        },
        'idem-neg',
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(httpService.request).not.toHaveBeenCalled();
  });

  // ─── SQ-5E3 — approved shipping request/response contract

  const shippingItem = {
    productId: 'product-1',
    productName: 'Croquetas',
    quantity: 1,
    unitPriceCents: 10000,
  };

  function saleBody(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      saleId: 'sale-1',
      folio: null,
      paymentStatus: 'CREDIT',
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: 12500,
      paidCents: 0,
      debtCents: 12500,
      confirmedAt: null,
      discountCents: 0,
      ...extra,
    };
  }

  it('forwards the approved shipping object with quoteId and the freight-inclusive expectedTotalCents', async () => {
    httpService.request.mockReturnValue(of(axiosResponse(saleBody())));

    await client.createSale(
      {
        cashierUserId: 'cashier-1',
        customerId: 'customer-1',
        shippingAddressId: 'address-1',
        expectedTotalCents: 12500,
        shipping: {
          chargeCents: 2500,
          approvalId: 'handoff-123',
          quoteId: 'quote-9',
        },
        items: [shippingItem],
      },
      'idem-ship-1',
    );

    const cfg = httpService.request.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(cfg.data.shipping).toEqual({
      chargeCents: 2500,
      approvalId: 'handoff-123',
      quoteId: 'quote-9',
    });
    expect(cfg.data.expectedTotalCents).toBe(12500);
  });

  it.each([null, undefined])(
    'omits the optional shipping.quoteId when it is %p',
    async (quoteId) => {
      httpService.request.mockReturnValue(of(axiosResponse(saleBody())));

      await client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          shippingAddressId: 'address-1',
          expectedTotalCents: 12500,
          shipping: { chargeCents: 2500, approvalId: 'handoff-123', quoteId },
          items: [shippingItem],
        },
        'idem-ship-2',
      );

      const cfg = httpService.request.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(cfg.data.shipping).toEqual({
        chargeCents: 2500,
        approvalId: 'handoff-123',
      });
      expect(JSON.stringify(cfg.data)).not.toContain('quoteId');
    },
  );

  it.each([null, undefined])(
    'omits the shipping key entirely when it is %p',
    async (shipping) => {
      httpService.request.mockReturnValue(of(axiosResponse(saleBody())));

      await client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          shipping,
          items: [shippingItem],
        },
        'idem-ship-3',
      );

      const cfg = httpService.request.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(cfg.data).not.toHaveProperty('shipping');
    },
  );

  it.each([undefined, null, 0, -1, 2 ** 53])(
    'rejects shipping with a missing, non-positive, or unsafe expectedTotalCents (%p) before HTTP',
    async (expectedTotalCents) => {
      let rejected = false;
      try {
        await client.createSale(
          {
            cashierUserId: 'cashier-1',
            customerId: 'customer-1',
            shippingAddressId: 'address-1',
            expectedTotalCents,
            shipping: { chargeCents: 2500, approvalId: 'handoff-123' },
            items: [shippingItem],
          },
          'idem-ship-4',
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(httpService.request).not.toHaveBeenCalled();
    },
  );

  it('still forwards expectedTotalCents=0 without shipping (legacy path unchanged)', async () => {
    httpService.request.mockReturnValue(of(axiosResponse(saleBody())));

    await client.createSale(
      {
        cashierUserId: 'cashier-1',
        customerId: 'customer-1',
        expectedTotalCents: 0,
        items: [shippingItem],
      },
      'idem-ship-5',
    );

    const cfg = httpService.request.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(cfg.data.expectedTotalCents).toBe(0);
    expect(cfg.data).not.toHaveProperty('shipping');
  });

  it.each<[string, BotSaleShippingInput]>([
    ['chargeCents 0', { chargeCents: 0, approvalId: 'handoff-1' }],
    [
      'chargeCents int32 overflow',
      { chargeCents: 2_147_483_648, approvalId: 'handoff-1' },
    ],
    ['empty approvalId', { chargeCents: 1, approvalId: '' }],
    ['whitespace-only approvalId', { chargeCents: 1, approvalId: '   ' }],
    [
      'approvalId over 200 chars',
      { chargeCents: 1, approvalId: 'a'.repeat(201) },
    ],
    [
      'whitespace-only quoteId',
      { chargeCents: 1, approvalId: 'handoff-1', quoteId: ' ' },
    ],
  ])(
    'rejects invalid shipping (%s) before any HTTP call',
    async (_label, shipping) => {
      let rejected = false;
      try {
        await client.createSale(
          {
            cashierUserId: 'cashier-1',
            customerId: 'customer-1',
            shippingAddressId: 'address-1',
            expectedTotalCents: 12500,
            shipping,
            items: [shippingItem],
          },
          'idem-ship-6',
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(httpService.request).not.toHaveBeenCalled();
    },
  );

  it('forwards optional response subtotalCents and shippingChargeCents verbatim when present', async () => {
    httpService.request.mockReturnValue(
      of(
        axiosResponse(
          saleBody({ subtotalCents: 10000, shippingChargeCents: 2500 }),
        ),
      ),
    );

    const resolved = await client.createSale(
      {
        cashierUserId: 'cashier-1',
        customerId: 'customer-1',
        shippingAddressId: 'address-1',
        expectedTotalCents: 12500,
        shipping: { chargeCents: 2500, approvalId: 'handoff-123' },
        items: [shippingItem],
      },
      'idem-ship-7',
    );

    expect(resolved.subtotalCents).toBe(10000);
    expect(resolved.shippingChargeCents).toBe(2500);
  });

  it('does not fabricate subtotalCents or shippingChargeCents on an address-only response', async () => {
    httpService.request.mockReturnValue(of(axiosResponse(saleBody())));

    const resolved = await client.createSale(
      {
        cashierUserId: 'cashier-1',
        customerId: 'customer-1',
        items: [shippingItem],
      },
      'idem-ship-8',
    );

    expect(resolved).not.toHaveProperty('subtotalCents');
    expect(resolved).not.toHaveProperty('shippingChargeCents');
  });

  it.each<[number, string]>([
    [422, 'SHIPPING_CHARGE_EXCEEDS_MAX'],
    [422, 'SHIPPING_EXPECTED_TOTAL_REQUIRED'],
    [409, 'SHIPPING_APPROVAL_ALREADY_USED'],
  ])(
    'surfaces backend shipping errorCode %s on HTTP %i',
    async (status, errorCode) => {
      httpService.request.mockReturnValue(
        throwError(() => ({
          response: {
            status,
            data: {
              statusCode: status,
              error: errorCode,
              message: 'shipping',
            },
          },
        })),
      );

      try {
        await client.createSale(
          {
            cashierUserId: 'cashier-1',
            customerId: 'customer-1',
            shippingAddressId: 'address-1',
            expectedTotalCents: 12500,
            shipping: { chargeCents: 2500, approvalId: 'handoff-123' },
            items: [shippingItem],
          },
          'idem-ship-9',
        );
        fail('Expected ChatbotApiError');
      } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as ChatbotApiError).statusCode).toBe(status);
        expect((error as ChatbotApiError).errorCode).toBe(errorCode);
      }
    },
  );

  it('resolves BotSaleResponse.discountCents from the body (100) and defaults to 0 when the body omits it', async () => {
    httpService.request.mockReturnValueOnce(
      of(
        axiosResponse({
          saleId: 'sale-1',
          folio: null,
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 900,
          paidCents: 0,
          debtCents: 900,
          confirmedAt: null,
          discountCents: 100,
        }),
      ),
    );
    await expect(
      client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          items: [
            {
              productId: 'product-1',
              productName: 'Croquetas',
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
        },
        'idem-d100',
      ),
    ).resolves.toEqual(expect.objectContaining({ discountCents: 100 }));

    httpService.request.mockReturnValueOnce(
      of(
        axiosResponse({
          saleId: 'sale-2',
          folio: null,
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 1000,
          paidCents: 0,
          debtCents: 1000,
          confirmedAt: null,
          // no discountCents in the body
        }),
      ),
    );
    await expect(
      client.createSale(
        {
          cashierUserId: 'cashier-1',
          customerId: 'customer-1',
          items: [
            {
              productId: 'product-1',
              productName: 'Croquetas',
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
        },
        'idem-d0',
      ),
    ).resolves.toEqual(expect.objectContaining({ discountCents: 0 }));
  });

  it('getPaymentDetails issues GET /chatbot-api/payment-details with no params and no body, returns the PaymentDetail projection', async () => {
    httpService.request.mockReturnValue(
      of(
        axiosResponse({
          id: 'p-1',
          bankName: 'AFIRME',
          beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
          isActive: true,
          updatedAt: '2026-08-24T12:00:00.000Z',
        }),
      ),
    );
    await expect(client.getPaymentDetails()).resolves.toEqual({
      id: 'p-1',
      bankName: 'AFIRME',
      beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV',
      clabe: '012345678901234567',
      accountNumber: '1234567890',
      isActive: true,
      updatedAt: '2026-08-24T12:00:00.000Z',
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/chatbot-api/payment-details',
        headers: {
          Authorization: 'Bearer svc_test_key',
          'X-Branch-Id': 'branch-123',
        },
      }),
    );
    const callArgs = httpService.request.mock.calls[0]?.[0] as {
      data?: unknown;
      params?: unknown;
    };
    // The GET sends no params and no body (axios strips undefined).
    expect(callArgs.data).toBeUndefined();
    expect(callArgs.params).toBeUndefined();
  });

  it('getPaymentDetails surfaces 404 NO_ACTIVE_PAYMENT_DETAIL as ChatbotApiError(errorCode)', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 404,
          data: {
            statusCode: 404,
            error: 'NO_ACTIVE_PAYMENT_DETAIL',
            message: 'No active payment detail configured',
          },
        },
      })),
    );
    try {
      await client.getPaymentDetails();
      fail('Expected ChatbotApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as ChatbotApiError).statusCode).toBe(404);
      expect((error as ChatbotApiError).errorCode).toBe(
        'NO_ACTIVE_PAYMENT_DETAIL',
      );
    }
  });

  it('getPaymentDetails maps 401 to AuthError with errorCode=null', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: { status: 401, data: { message: 'no auth' } },
      })),
    );
    try {
      await client.getPaymentDetails();
      fail('Expected AuthError');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as ChatbotApiError).errorCode).toBeNull();
    }
  });

  it('getPaymentDetails maps 503 to UpstreamError with errorCode from the body when present', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: { status: 503, data: { error: 'BOOM' } },
      })),
    );
    try {
      await client.getPaymentDetails();
      fail('Expected UpstreamError');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as ChatbotApiError).errorCode).toBe('BOOM');
    }
  });

  // ─── cancelSale (POST /chatbot-api/sales/:saleId/cancel) — design §b

  it('cancelSale POSTs to /chatbot-api/sales/:saleId/cancel with the DTO body and NO X-Idempotency-Key header', async () => {
    const body = {
      saleId: 'sale-1',
      status: 'CANCELED',
      refundedCents: 0,
      restockedItems: [{ productId: 'p-1', variantId: null, quantity: 2 }],
      canceledAt: '2026-08-25T12:00:00.000Z',
    };
    httpService.request.mockReturnValue(of(axiosResponse(body)));

    await expect(
      client.cancelSale('sale-1', {
        reason: 'CUSTOMER_REQUEST',
        cashierUserId: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toEqual(body);

    expect(httpService.request).toHaveBeenCalledTimes(1);
    const cfg = httpService.request.mock.calls[0][0] as {
      method: string;
      url: string;
      data: unknown;
      headers: Record<string, string>;
    };
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toBe('/chatbot-api/sales/sale-1/cancel');
    expect(cfg.data).toEqual({
      reason: 'CUSTOMER_REQUEST',
      cashierUserId: '00000000-0000-4000-8000-000000000001',
    });
    // NO X-Idempotency-Key header (ADR-16: backend-derived idempotency).
    expect(cfg.headers['X-Idempotency-Key']).toBeUndefined();
    // Standard auth + branch headers MUST still be applied.
    expect(cfg.headers['Authorization']).toBe('Bearer svc_test_key');
    expect(cfg.headers['X-Branch-Id']).toBe('branch-123');
  });

  it('cancelSale percent-encodes the saleId path segment', async () => {
    httpService.request.mockReturnValue(
      of(
        axiosResponse({
          saleId: 'sale+id/1',
          status: 'CANCELED',
          refundedCents: 0,
          restockedItems: [],
          canceledAt: '2026-08-25T12:00:00.000Z',
        }),
      ),
    );
    await client.cancelSale('sale+id/1', {
      reason: 'CUSTOMER_REQUEST',
      cashierUserId: 'cashier-1',
    });
    const url = (httpService.request.mock.calls[0]?.[0] as { url: string }).url;
    expect(url).toBe('/chatbot-api/sales/sale%2Bid%2F1/cancel');
  });

  it('cancelSale resolves 200 with the CancelSaleResult projection — NOT BotSaleResponse fields', async () => {
    const projection = {
      saleId: 'sale-1',
      status: 'CANCELED',
      refundedCents: 0,
      restockedItems: [{ productId: 'p-1', variantId: null, quantity: 2 }],
      canceledAt: '2026-08-25T12:00:00.000Z',
    };
    httpService.request.mockReturnValue(of(axiosResponse(projection)));
    const resolved = await client.cancelSale('sale-1', {
      reason: 'CUSTOMER_REQUEST',
      cashierUserId: 'cashier-1',
    });
    expect(resolved).toEqual(projection);
    expect(
      (resolved as unknown as Record<string, unknown>)['deliveryStatus'],
    ).toBeUndefined();
    expect(
      (resolved as unknown as Record<string, unknown>)['totalCents'],
    ).toBeUndefined();
    expect(
      (resolved as unknown as Record<string, unknown>)['subtotalCents'],
    ).toBeUndefined();
  });

  it('cancelSale 409 SALE_NOT_CANCELLABLE surfaces ChatbotApiError with verbatim errorCode', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 409,
          data: {
            statusCode: 409,
            error: 'SALE_NOT_CANCELLABLE',
            message: 'Sale is not cancellable',
          },
        },
      })),
    );
    try {
      await client.cancelSale('sale-1', {
        reason: 'CUSTOMER_REQUEST',
        cashierUserId: 'cashier-1',
      });
      fail('Expected ChatbotApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as ChatbotApiError).statusCode).toBe(409);
      expect((error as ChatbotApiError).errorCode).toBe('SALE_NOT_CANCELLABLE');
    }
  });

  it('cancelSale 409 SALE_DELIVERED_CANNOT_CANCEL surfaces ChatbotApiError with verbatim errorCode', async () => {
    httpService.request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 409,
          data: {
            statusCode: 409,
            error: 'SALE_DELIVERED_CANNOT_CANCEL',
            message: 'Sale already delivered',
          },
        },
      })),
    );
    try {
      await client.cancelSale('sale-1', {
        reason: 'CUSTOMER_REQUEST',
        cashierUserId: 'cashier-1',
      });
      fail('Expected ChatbotApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as ChatbotApiError).statusCode).toBe(409);
      expect((error as ChatbotApiError).errorCode).toBe(
        'SALE_DELIVERED_CANNOT_CANCEL',
      );
    }
  });

  it('cancelSale 200 with status: CANCELED for an already-canceled sale resolves as success (replay)', async () => {
    const replay = {
      saleId: 'sale-1',
      status: 'CANCELED',
      refundedCents: 0,
      restockedItems: [],
      canceledAt: '2026-08-24T10:00:00.000Z',
    };
    httpService.request.mockReturnValue(of(axiosResponse(replay)));
    const resolved = await client.cancelSale('sale-1', {
      reason: 'CUSTOMER_REQUEST',
      cashierUserId: 'cashier-1',
    });
    expect(resolved).toEqual(replay);
  });

  // ─── attachReceipt abortable attachment-only HTTP transport (WU11B)

  describe('attachReceipt (WU11B)', () => {
    const attachDto = {
      mediaUrl: 'https://example.com/r.jpg',
      declaredAmountCents: 1000,
    };
    const validBody = { receiptId: 'receipt-1', status: 'PENDING' };

    function mockFulfilled(status: number, data: unknown): void {
      httpService.request.mockReturnValue(of(axiosResponse(data, status)));
    }

    it('resolves a valid 201 PENDING body', async () => {
      mockFulfilled(201, validBody);

      await expect(client.attachReceipt('sale-1', attachDto)).resolves.toEqual(
        validBody,
      );
    });

    it('sends exactly one POST with the configured timeout, the same caller AbortSignal, and auth/branch headers', async () => {
      mockFulfilled(201, validBody);
      const controller = new AbortController();

      await client.attachReceipt('sale-1', attachDto, {
        signal: controller.signal,
      });

      expect(httpService.request).toHaveBeenCalledTimes(1);
      const cfg = httpService.request.mock.calls[0][0] as {
        method: string;
        url: string;
        data: unknown;
        timeout: number;
        signal: AbortSignal;
        headers: Record<string, string>;
      };
      expect(cfg.method).toBe('POST');
      expect(cfg.url).toBe('/chatbot-api/sales/sale-1/receipts');
      expect(cfg.data).toEqual(attachDto);
      expect(cfg.timeout).toBe(15000);
      expect(cfg.signal).toBe(controller.signal);
      expect(cfg.headers['Authorization']).toBe('Bearer svc_test_key');
      expect(cfg.headers['X-Branch-Id']).toBe('branch-123');
    });

    it('stays compatible when called without options: no signal is forwarded and the request still succeeds', async () => {
      mockFulfilled(201, validBody);

      await expect(client.attachReceipt('sale-1', attachDto)).resolves.toEqual(
        validBody,
      );

      const cfg = httpService.request.mock.calls[0][0] as {
        timeout: number;
        signal?: AbortSignal;
      };
      expect(cfg.signal).toBeUndefined();
      expect(cfg.timeout).toBe(15000);
    });

    it.each([200, 202])(
      'rejects a fulfilled HTTP %i response with UpstreamError carrying the observed status and body',
      async (status) => {
        mockFulfilled(status, validBody);

        try {
          await client.attachReceipt('sale-1', attachDto);
          fail('Expected UpstreamError');
        } catch (error) {
          expect(error).toBeInstanceOf(UpstreamError);
          expect((error as ChatbotApiError).statusCode).toBe(status);
          expect((error as ChatbotApiError).responseBody).toEqual(validBody);
        }
      },
    );

    it.each([
      ['missing receiptId', { status: 'PENDING' }],
      ['non-string receiptId', { receiptId: 123, status: 'PENDING' }],
      ['non-PENDING status', { receiptId: 'r-1', status: 'CONFIRMED' }],
      ['null body', null],
      ['array body', [validBody]],
    ])(
      'rejects malformed 201 body (%s) with UpstreamError evidence',
      async (_label, body) => {
        mockFulfilled(201, body);

        try {
          await client.attachReceipt('sale-1', attachDto);
          fail('Expected UpstreamError');
        } catch (error) {
          expect(error).toBeInstanceOf(UpstreamError);
          expect((error as ChatbotApiError).statusCode).toBe(201);
          expect((error as ChatbotApiError).responseBody).toEqual(body);
        }
      },
    );

    it('preserves the errorCode evidence from the body on a fulfilled invalid response', async () => {
      const body = { error: 'ATTACH_REJECTED', receiptId: 5 };
      mockFulfilled(201, body);

      try {
        await client.attachReceipt('sale-1', attachDto);
        fail('Expected UpstreamError');
      } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as ChatbotApiError).errorCode).toBe('ATTACH_REJECTED');
      }
    });

    it('maps a 5xx rejection through the existing error mapping with exactly one request and no sleep', async () => {
      httpService.request.mockReturnValue(
        throwError(() => ({
          response: { status: 503, data: { error: 'BOOM' } },
        })),
      );

      try {
        await client.attachReceipt('sale-1', attachDto);
        fail('Expected UpstreamError');
      } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as ChatbotApiError).statusCode).toBe(503);
        expect((error as ChatbotApiError).errorCode).toBe('BOOM');
      }
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('maps an abort/transport rejection through the existing error mapping with exactly one request and no sleep', async () => {
      httpService.request.mockReturnValue(
        throwError(() => ({ code: 'ERR_CANCELED', message: 'canceled' })),
      );

      try {
        await client.attachReceipt('sale-1', attachDto);
        fail('Expected UpstreamError');
      } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as ChatbotApiError).statusCode).toBeNull();
      }
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  // ─── submitRestockIntake (POST /chatbot-api/human-decisions) — HD-R2b2

  describe('submitRestockIntake (HD-R2b2)', () => {
    const intake: RestockIntakeInput = {
      sourceRequestId: '11111111-1111-4111-8111-111111111111',
      type: 'RESTOCK',
      productId: '22222222-2222-4222-8222-222222222222',
      productName: 'Croquetas Premium',
      variantId: '33333333-3333-4333-8333-333333333333',
      sku: 'SKU-1',
      requestedQuantity: 2,
      observedStockAtRequest: 0,
      stockObservedAt: '2026-08-25T12:00:00.000Z',
      supersedesDecisionId: null,
    };

    const historicalReceipt = (overrides: Record<string, unknown> = {}) => ({
      id: '44444444-4444-4444-8444-444444444444',
      sourceRequestId: intake.sourceRequestId,
      type: 'RESTOCK',
      status: 'PENDING',
      version: 1,
      createdAt: '2026-08-25T12:00:01.000Z',
      snapshot: {
        branchId: '55555555-5555-4555-8555-555555555555',
        branchName: 'Sucursal Centro',
        productId: intake.productId,
        productName: intake.productName,
        variantId: intake.variantId,
        sku: intake.sku,
        requestedQuantity: intake.requestedQuantity,
        observedStockAtRequest: intake.observedStockAtRequest,
        stockObservedAt: intake.stockObservedAt,
      },
      supersedesDecisionId: null,
      resolution: null,
      applyBefore: null,
      ...overrides,
    });

    type RequestCfg = {
      method: string;
      url: string;
      data: Record<string, unknown>;
      headers: Record<string, string>;
    };
    const sentConfig = () => httpService.request.mock.calls[0][0] as RequestCfg;
    const rejectIntake = () =>
      client.submitRestockIntake(intake).then(
        () => {
          throw new Error('expected rejection');
        },
        (error: ChatbotApiError) => error,
      );

    it('POSTs the exact 10-key body, idempotency key and auth headers, and replays 200 as historical PENDING', async () => {
      const receipt = historicalReceipt();
      httpService.request
        .mockReturnValueOnce(of(axiosResponse(receipt, 201)))
        .mockReturnValueOnce(of(axiosResponse(receipt, 200)));

      await expect(client.submitRestockIntake(intake)).resolves.toEqual(
        receipt,
      );

      const cfg = sentConfig();
      expect(cfg.method).toBe('POST');
      expect(cfg.url).toBe('/chatbot-api/human-decisions');
      expect(cfg.data).toEqual(intake);
      expect(Object.keys(cfg.data).sort()).toEqual(Object.keys(intake).sort());
      expect(cfg.headers['X-Idempotency-Key']).toBe(intake.sourceRequestId);
      expect(cfg.headers['Authorization']).toBe('Bearer svc_test_key');
      expect(cfg.headers['X-Branch-Id']).toBe('branch-123');

      const replayed = await client.submitRestockIntake(intake);
      expect(replayed).toEqual(receipt);
      expect(replayed.status).toBe('PENDING');
      expect(replayed.version).toBe(1);
      expect(replayed.resolution).toBeNull();
      expect(replayed.applyBefore).toBeNull();
      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('sends omitted optionals as explicit null and no extra authority keys', async () => {
      httpService.request.mockReturnValue(
        of(
          axiosResponse(
            historicalReceipt({
              snapshot: {
                ...historicalReceipt().snapshot,
                variantId: null,
                sku: null,
                requestedQuantity: null,
                observedStockAtRequest: null,
                stockObservedAt: null,
              },
            }),
            201,
          ),
        ),
      );

      await client.submitRestockIntake({
        sourceRequestId: intake.sourceRequestId,
        type: 'RESTOCK',
        productId: intake.productId,
        productName: intake.productName,
      } as unknown as RestockIntakeInput);

      expect(sentConfig().data).toEqual({
        ...intake,
        variantId: null,
        sku: null,
        requestedQuantity: null,
        observedStockAtRequest: null,
        stockObservedAt: null,
      });
    });

    it('rejects a fulfilled 202 and malformed 201 receipts with UpstreamError evidence', async () => {
      const rejected: Array<[unknown, number]> = [
        [historicalReceipt(), 202],
        [historicalReceipt({ status: 'RESOLVED' }), 201],
        [historicalReceipt({ version: 2 }), 201],
        [historicalReceipt({ resolution: { action: 'X' } }), 201],
        [
          historicalReceipt({
            snapshot: { ...historicalReceipt().snapshot, productName: 'Otra' },
          }),
          201,
        ],
      ];

      for (const [body, status] of rejected) {
        httpService.request.mockReturnValueOnce(
          of(axiosResponse(body, status)),
        );
        const error = await rejectIntake();
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.statusCode).toBe(status);
        expect(error.responseBody).toEqual(body);
      }

      expect(httpService.request).toHaveBeenCalledTimes(rejected.length);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('rejects invalid local intakes before any HTTP request', async () => {
      const invalid = [
        { ...intake, productName: '   ' },
        { ...intake, source: 'houndfe-chatbot' },
        { ...intake, sourceRequestId: 'not-a-uuid' },
      ];

      for (const dto of invalid) {
        await expect(client.submitRestockIntake(dto)).rejects.toBeInstanceOf(
          ChatbotApiError,
        );
      }

      expect(httpService.request).not.toHaveBeenCalled();
    });

    it.each([
      [401, 'UNAUTHORIZED', AuthError],
      [403, 'FORBIDDEN', ForbiddenError],
      [404, 'NOT_FOUND', NotFoundError],
    ])(
      'maps a %i scoped code envelope to %p with errorCode passthrough',
      async (status, code, ErrorType) => {
        httpService.request.mockReturnValue(
          throwError(() => ({
            response: {
              status,
              data: { statusCode: status, code, message: 'nope' },
            },
          })),
        );

        const error = await rejectIntake();
        expect(error).toBeInstanceOf(ErrorType);
        expect(error.statusCode).toBe(status);
        expect(error.errorCode).toBe(code);
        expect(httpService.request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      },
    );

    it('maps 429 to RateLimitError with Retry-After and the backend code in one request', async () => {
      httpService.request.mockReturnValue(
        throwError(() => ({
          response: {
            status: 429,
            headers: { 'retry-after': '9' },
            data: {
              statusCode: 429,
              code: 'RATE_LIMITED',
              message: 'slow down',
            },
          },
        })),
      );

      const error = await rejectIntake();
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBe(9);
      expect(error.errorCode).toBe('RATE_LIMITED');

      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('maps a 5xx code envelope and a network failure to UpstreamError with one request and no sleep', async () => {
      httpService.request
        .mockReturnValueOnce(
          throwError(() => ({
            response: {
              status: 503,
              data: { statusCode: 503, code: 'UPSTREAM_DOWN', message: 'x' },
            },
          })),
        )
        .mockReturnValueOnce(
          throwError(() => ({ code: 'ECONNRESET', message: 'socket down' })),
        );

      const server = await rejectIntake();
      expect(server).toBeInstanceOf(UpstreamError);
      expect(server.statusCode).toBe(503);
      expect(server.errorCode).toBe('UPSTREAM_DOWN');

      const network = await rejectIntake();
      expect(network).toBeInstanceOf(UpstreamError);
      expect(network.statusCode).toBeNull();
      expect(network.errorCode).toBeNull();

      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('surfaces a 409 scoped code envelope and preserves legacy error precedence', async () => {
      const conflict = {
        statusCode: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'conflict',
      };
      httpService.request.mockReturnValueOnce(
        throwError(() => ({ response: { status: 409, data: conflict } })),
      );
      const error = await rejectIntake();
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.responseBody).toEqual(conflict);

      const legacy: Array<[unknown, string]> = [
        [{ error: 'SALE_NOT_CANCELLABLE' }, 'SALE_NOT_CANCELLABLE'],
        [{ error: 'OLD_CODE', code: 'NEW_CODE' }, 'OLD_CODE'],
        [{ code: 'ONLY_CODE' }, 'ONLY_CODE'],
      ];
      for (const [body, expected] of legacy) {
        httpService.request.mockReturnValueOnce(
          throwError(() => ({ response: { status: 409, data: body } })),
        );
        await expect(rejectIntake()).resolves.toMatchObject({
          errorCode: expected,
        });
      }
    });
  });

  // ─── getRestockDecision (GET /chatbot-api/human-decisions/:id) — T4b1

  describe('getRestockDecision (T4b1)', () => {
    const decisionId = '77777777-7777-4777-8777-777777777777';

    const currentDecision = (overrides: Record<string, unknown> = {}) => ({
      id: decisionId,
      sourceRequestId: '11111111-1111-4111-8111-111111111111',
      type: 'RESTOCK',
      status: 'PENDING',
      version: 1,
      createdAt: '2026-08-25T12:00:01.000Z',
      snapshot: {
        branchId: '55555555-5555-4555-8555-555555555555',
        branchName: 'Sucursal Centro',
        productId: '22222222-2222-4222-8222-222222222222',
        productName: 'Croquetas Premium',
        variantId: null,
        sku: 'SKU-1',
        requestedQuantity: 2,
        observedStockAtRequest: 0,
        stockObservedAt: '2026-08-25T12:00:00.000Z',
      },
      supersedesDecisionId: null,
      resolution: null,
      applyBefore: null,
      ...overrides,
    });

    const resolvedDecision = () => ({
      ...currentDecision(),
      status: 'RESOLVED',
      version: 2,
      resolution: {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
        resolvedAt: '2026-08-25T13:00:00.000Z',
      },
      applyBefore: '2026-08-25T14:00:00.000Z',
    });

    const poll = () =>
      client.getRestockDecision(decisionId).then(
        () => {
          throw new Error('expected rejection');
        },
        (error: ChatbotApiError) => error,
      );

    it('GETs the encoded decision URL with auth headers and parses PENDING and RESOLVED current states', async () => {
      httpService.request
        .mockReturnValueOnce(of(axiosResponse(currentDecision())))
        .mockReturnValueOnce(of(axiosResponse(resolvedDecision())));

      const pending = await client.getRestockDecision(decisionId);
      expect(pending.status).toBe('PENDING');
      expect(pending.resolution).toBeNull();
      expect(pending.applyBefore).toBeNull();

      const resolved = await client.getRestockDecision(decisionId);
      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.resolution).toEqual({
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
        resolvedAt: '2026-08-25T13:00:00.000Z',
      });

      const cfg = httpService.request.mock.calls[0][0] as {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      expect(cfg.method).toBe('GET');
      expect(cfg.url).toBe(`/chatbot-api/human-decisions/${decisionId}`);
      expect(cfg.headers['Authorization']).toBe('Bearer svc_test_key');
      expect(cfg.headers['X-Branch-Id']).toBe('branch-123');
      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID decision id before any HTTP request', async () => {
      await expect(
        client.getRestockDecision('not-a-uuid'),
      ).rejects.toBeInstanceOf(ChatbotApiError);
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('rejects malformed, extra-key and wrong-id current bodies as UpstreamError with body evidence', async () => {
      const bodies: unknown[] = [
        currentDecision({ extra: true }),
        currentDecision({ status: 'RESOLVED', version: 2 }),
        currentDecision({ id: '99999999-9999-4999-8999-999999999999' }),
        {
          ...currentDecision(),
          snapshot: { ...currentDecision().snapshot, productName: '   ' },
        },
      ];

      for (const body of bodies) {
        httpService.request.mockReturnValueOnce(of(axiosResponse(body)));
        const error = await poll();
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.statusCode).toBe(200);
        expect(error.responseBody).toEqual(body);
      }

      expect(httpService.request).toHaveBeenCalledTimes(bodies.length);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('never interprets an immutable POST-only receipt replay as current RESOLVED state', async () => {
      const receipt = currentDecision();
      httpService.request.mockReturnValue(of(axiosResponse(receipt)));

      const decision = await client.getRestockDecision(decisionId);
      expect(decision.status).toBe('PENDING');
      expect(decision.version).toBe(1);
      expect(decision.resolution).toBeNull();
      expect(decision.applyBefore).toBeNull();
    });

    it('rejects a fulfilled unexpected 201 status with UpstreamError evidence', async () => {
      const body = currentDecision();
      httpService.request.mockReturnValueOnce(of(axiosResponse(body, 201)));

      const error = await poll();
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.statusCode).toBe(201);
      expect(error.responseBody).toEqual(body);
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('retries network/5xx failures with bounded backoff and returns the later success', async () => {
      httpService.request
        .mockReturnValueOnce(
          throwError(() => ({
            response: {
              status: 503,
              data: { statusCode: 503, code: 'UPSTREAM_DOWN', message: 'x' },
            },
          })),
        )
        .mockReturnValueOnce(
          throwError(() => ({ code: 'ECONNRESET', message: 'socket down' })),
        )
        .mockReturnValueOnce(of(axiosResponse(currentDecision())));

      await expect(
        client.getRestockDecision(decisionId),
      ).resolves.toMatchObject({ status: 'PENDING' });

      expect(httpService.request).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenNthCalledWith(1, 100);
      expect(sleep).toHaveBeenNthCalledWith(2, 200);
    });

    it('exhausts the bounded 3-attempt retry on persistent 5xx and maps the final error', async () => {
      httpService.request.mockReturnValue(
        throwError(() => ({
          response: {
            status: 503,
            data: { statusCode: 503, code: 'UPSTREAM_DOWN', message: 'x' },
          },
        })),
      );

      const error = await poll();
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.statusCode).toBe(503);
      expect(error.errorCode).toBe('UPSTREAM_DOWN');
      expect(httpService.request).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 4xx, mapping it in a single request', async () => {
      httpService.request.mockReturnValue(
        throwError(() => ({
          response: {
            status: 409,
            data: {
              statusCode: 409,
              code: 'VERSION_CONFLICT',
              message: 'x',
            },
          },
        })),
      );

      const error = await poll();
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe('VERSION_CONFLICT');
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it.each([
      [401, 'UNAUTHORIZED', AuthError],
      [403, 'FORBIDDEN', ForbiddenError],
      [404, 'NOT_FOUND', NotFoundError],
    ])(
      'maps a %i scoped code envelope to %p without retry',
      async (status, code, ErrorType) => {
        httpService.request.mockReturnValue(
          throwError(() => ({
            response: {
              status,
              data: { statusCode: status, code, message: 'nope' },
            },
          })),
        );

        const error = await poll();
        expect(error).toBeInstanceOf(ErrorType);
        expect(error.statusCode).toBe(status);
        expect(error.errorCode).toBe(code);
        expect(httpService.request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      },
    );

    it('maps 429 to RateLimitError with Retry-After and no retry', async () => {
      httpService.request.mockReturnValue(
        throwError(() => ({
          response: {
            status: 429,
            headers: { 'retry-after': '7' },
            data: {
              statusCode: 429,
              code: 'RATE_LIMITED',
              message: 'slow down',
            },
          },
        })),
      );

      const error = await poll();
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBe(7);
      expect(error.errorCode).toBe('RATE_LIMITED');
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  // ─── recordRestockApplicationOutcome (POST .../application-outcome) — T4b2

  describe('recordRestockApplicationOutcome (T4b2)', () => {
    const decisionId = '77777777-7777-4777-8777-777777777777';
    const attemptId = '88888888-8888-4888-8888-888888888888';
    const messageId = 'wamid.HBgLMI6';
    const attemptedAt = '2026-08-25T13:00:00.000Z';
    const acceptedAt = '2026-08-25T13:00:05.000Z';
    const ackAt = '2026-08-25T13:00:06.000Z';
    type Rec = Record<string, unknown>;

    const accepted = (extra: Rec = {}): Rec => ({
      attemptId,
      expectedResolutionVersion: 2,
      outcome: 'PROVIDER_ACCEPTED',
      attemptedAt,
      providerMessageId: messageId,
      providerAcceptedObservedAt: acceptedAt,
      ...extra,
    });
    const late = (extra: Rec = {}): Rec =>
      accepted({ outcome: 'PROVIDER_ACCEPTED_LATE', ...extra });
    const unknownVariant = (extra: Rec = {}): Rec => ({
      attemptId,
      expectedResolutionVersion: 2,
      outcome: 'DELIVERY_UNKNOWN',
      attemptedAt,
      ...extra,
    });
    const stale = (extra: Rec = {}): Rec => ({
      attemptId,
      expectedResolutionVersion: 2,
      outcome: 'STALE',
      ...extra,
    });
    const ack = (outcome: string, extra: Rec = {}): Rec => ({
      id: decisionId,
      version: 2,
      attemptId,
      outcome,
      ackReceivedAt: ackAt,
      ...extra,
    });
    const asRequest = (value: Rec): RestockApplicationOutcomeRequest =>
      value as unknown as RestockApplicationOutcomeRequest;
    type RequestCfg = {
      method: string;
      url: string;
      data: Record<string, unknown>;
      headers: Record<string, string>;
    };
    const sentConfig = (index = 0) =>
      httpService.request.mock.calls[index][0] as RequestCfg;
    const record = (request: Rec = accepted()) =>
      client
        .recordRestockApplicationOutcome(decisionId, asRequest(request))
        .then(
          () => {
            throw new Error('expected rejection');
          },
          (error: ChatbotApiError) => error,
        );

    it('POSTs each normalized outcome variant to the encoded path with auth and no idempotency header', async () => {
      const cases: Array<[Rec, string]> = [
        [accepted(), 'PROVIDER_ACCEPTED'],
        [late(), 'PROVIDER_ACCEPTED_LATE'],
        [unknownVariant(), 'DELIVERY_UNKNOWN'],
        [stale(), 'STALE'],
      ];
      for (const [, outcome] of cases) {
        httpService.request.mockReturnValueOnce(
          of(axiosResponse(ack(outcome))),
        );
      }

      for (const [request, outcome] of cases) {
        await expect(
          client.recordRestockApplicationOutcome(
            decisionId,
            asRequest(request),
          ),
        ).resolves.toEqual(ack(outcome));
      }

      cases.forEach(([request], index) => {
        const cfg = sentConfig(index);
        expect(cfg.method).toBe('POST');
        expect(cfg.url).toBe(
          `/chatbot-api/human-decisions/${decisionId}/application-outcome`,
        );
        expect(cfg.data).toEqual(request);
        expect(Object.keys(cfg.data).sort()).toEqual(
          Object.keys(request).sort(),
        );
        expect(cfg.headers['Authorization']).toBe('Bearer svc_test_key');
        expect(cfg.headers['X-Branch-Id']).toBe('branch-123');
        expect(cfg.headers['X-Idempotency-Key']).toBeUndefined();
      });
      expect(httpService.request).toHaveBeenCalledTimes(cases.length);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('preserves optional UNKNOWN evidence and keeps an absent id key absent', async () => {
      httpService.request
        .mockReturnValueOnce(of(axiosResponse(ack('DELIVERY_UNKNOWN'))))
        .mockReturnValueOnce(of(axiosResponse(ack('DELIVERY_UNKNOWN'))));

      await client.recordRestockApplicationOutcome(
        decisionId,
        asRequest(unknownVariant()),
      );
      const withId = unknownVariant({ providerMessageId: messageId });
      await client.recordRestockApplicationOutcome(
        decisionId,
        asRequest(withId),
      );

      expect(sentConfig(0).data).toEqual(unknownVariant());
      expect(Object.keys(sentConfig(0).data)).not.toContain(
        'providerMessageId',
      );
      expect(sentConfig(1).data).toEqual(withId);
      expect(sentConfig(1).data.providerMessageId).toBe(messageId);
    });

    it('rejects an invalid decision id or malformed request before any HTTP request', async () => {
      const invalids: Array<[string, Rec]> = [
        ['not-a-uuid', accepted()],
        [decisionId, accepted({ evidenceCode: 'X' })],
        [decisionId, stale({ attemptedAt })],
        [decisionId, accepted({ providerMessageId: '   ' })],
        [decisionId, accepted({ expectedResolutionVersion: 1 })],
      ];

      for (const [id, request] of invalids) {
        await expect(
          client.recordRestockApplicationOutcome(id, asRequest(request)),
        ).rejects.toBeInstanceOf(ChatbotApiError);
      }

      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('rejects wrong, malformed and unexpected-status ACK bodies with UpstreamError evidence', async () => {
      const bodies: Array<[unknown, number]> = [
        [ack('PROVIDER_ACCEPTED', { extra: true }), 200],
        [ack('DELIVERY_UNKNOWN'), 200],
        [ack('PROVIDER_ACCEPTED', { version: 1 }), 200],
        [
          ack('PROVIDER_ACCEPTED', {
            id: '99999999-9999-4999-8999-999999999999',
          }),
          200,
        ],
        [
          ack('PROVIDER_ACCEPTED', {
            attemptId: '99999999-9999-4999-8999-999999999999',
          }),
          200,
        ],
        [ack('PROVIDER_ACCEPTED', { evidenceCode: null }), 200],
        [ack('PROVIDER_ACCEPTED'), 201],
      ];

      for (const [body, status] of bodies) {
        httpService.request.mockReturnValueOnce(
          of(axiosResponse(body, status)),
        );
        const error = await record();
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.statusCode).toBe(status);
        expect(error.responseBody).toEqual(body);
      }

      expect(httpService.request).toHaveBeenCalledTimes(bodies.length);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('preserves the structured errorCode of a fulfilled unexpected-status body', async () => {
      const body = { statusCode: 202, code: 'ACK_NOT_TERMINAL' };
      httpService.request.mockReturnValueOnce(of(axiosResponse(body, 202)));

      const error = await record();
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.statusCode).toBe(202);
      expect(error.errorCode).toBe('ACK_NOT_TERMINAL');
      expect(error.responseBody).toEqual(body);
    });

    it.each([
      [401, 'UNAUTHORIZED', AuthError],
      [403, 'FORBIDDEN', ForbiddenError],
      [409, 'VERSION_CONFLICT', UpstreamError],
    ])(
      'maps a %i scoped code envelope to %p in one request with no retry',
      async (status, code, ErrorType) => {
        httpService.request.mockReturnValue(
          throwError(() => ({
            response: {
              status,
              data: { statusCode: status, code, message: 'nope' },
            },
          })),
        );

        const error = await record();
        expect(error).toBeInstanceOf(ErrorType);
        expect(error.statusCode).toBe(status);
        expect(error.errorCode).toBe(code);
        expect(httpService.request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      },
    );

    it('maps 429 to RateLimitError with Retry-After in one request', async () => {
      httpService.request.mockReturnValue(
        throwError(() => ({
          response: {
            status: 429,
            headers: { 'retry-after': '5' },
            data: {
              statusCode: 429,
              code: 'RATE_LIMITED',
              message: 'slow down',
            },
          },
        })),
      );

      const error = await record();
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBe(5);
      expect(error.errorCode).toBe('RATE_LIMITED');
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('maps a persistent 5xx and an ambiguous network failure to UpstreamError with no sleep', async () => {
      httpService.request
        .mockReturnValueOnce(
          throwError(() => ({
            response: {
              status: 503,
              data: { statusCode: 503, code: 'UPSTREAM_DOWN', message: 'x' },
            },
          })),
        )
        .mockReturnValueOnce(
          throwError(() => ({ code: 'ECONNRESET', message: 'socket down' })),
        );

      const server = await record();
      expect(server).toBeInstanceOf(UpstreamError);
      expect(server.statusCode).toBe(503);
      expect(server.errorCode).toBe('UPSTREAM_DOWN');

      const network = await record();
      expect(network).toBeInstanceOf(UpstreamError);
      expect(network.statusCode).toBeNull();
      expect(network.errorCode).toBeNull();

      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('sends a caller-driven exact replay with the same attempt id as a second independent POST', async () => {
      httpService.request
        .mockReturnValueOnce(of(axiosResponse(ack('PROVIDER_ACCEPTED'))))
        .mockReturnValueOnce(of(axiosResponse(ack('PROVIDER_ACCEPTED'))));

      const first = await client.recordRestockApplicationOutcome(
        decisionId,
        asRequest(accepted()),
      );
      const second = await client.recordRestockApplicationOutcome(
        decisionId,
        asRequest(accepted()),
      );

      expect(first).toEqual(second);
      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect(sentConfig(1).data.attemptId).toBe(attemptId);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('CancelSaleInputSchema', () => {
    it('accepts each of the five reason values', () => {
      for (const reason of [
        'CUSTOMER_REQUEST',
        'ORDER_ERROR',
        'OUT_OF_STOCK',
        'DUPLICATE_SALE',
        'OTHER',
      ]) {
        const r = CancelSaleInputSchema.safeParse({
          reason,
          cashierUserId: 'cashier-1',
        });
        expect(r.success).toBe(true);
      }
    });

    it('rejects an unknown reason', () => {
      const r = CancelSaleInputSchema.safeParse({
        reason: 'NOT_A_REASON',
        cashierUserId: 'cashier-1',
      });
      expect(r.success).toBe(false);
    });

    it('rejects when cashierUserId is missing', () => {
      const r = CancelSaleInputSchema.safeParse({
        reason: 'CUSTOMER_REQUEST',
      });
      expect(r.success).toBe(false);
    });

    it('rejects an empty cashierUserId', () => {
      const r = CancelSaleInputSchema.safeParse({
        reason: 'CUSTOMER_REQUEST',
        cashierUserId: '',
      });
      expect(r.success).toBe(false);
    });
  });
});

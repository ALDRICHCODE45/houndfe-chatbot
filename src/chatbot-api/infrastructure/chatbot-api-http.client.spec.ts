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

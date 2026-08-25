import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import type { AppConfig } from '../../config/configuration';
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

describe('ChatbotApiHttpClient', () => {
  let httpService: jest.Mocked<Pick<HttpService, 'request'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'getOrThrow'>>;
  let sleep: jest.Mock<Promise<void>, [number]>;
  let client: ChatbotApiHttpClient;

  beforeEach(() => {
    httpService = {
      request: jest.fn(),
    };

    configService = {
      getOrThrow: jest.fn((key: keyof AppConfig | string) => {
        const values: Record<string, string> = {
          'chatbotApi.baseUrl': 'https://backend.example.com',
          'chatbotApi.serviceKey': 'svc_test_key',
          'chatbotApi.branchId': 'branch-123',
        };

        return values[key];
      }),
    };

    sleep = jest.fn().mockResolvedValue(undefined);

    client = new ChatbotApiHttpClient(
      httpService as HttpService,
      configService as ConfigService,
      sleep,
    );
  });

  it('sends Bearer and X-Branch-Id headers on read requests', async () => {
    httpService.request.mockReturnValue(
      of({
        data: [],
      }),
    );

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
        of({
          data: {
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
          },
        }),
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
      of({
        data: {
          saleId: 'sale-1',
          folio: 'F-001',
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 10000,
          paidCents: 0,
          debtCents: 10000,
          confirmedAt: null,
        },
      }),
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
        }),
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
    httpService.request.mockReturnValue(of({ data: [] }));

    await client.getOrderHistory('+5215550001111', '52');

    const requestConfig = httpService.request.mock.calls[0]?.[0];
    const url = requestConfig?.url;

    expect(url).toContain('%2B5215550001111');
    expect(url).not.toContain('+5215550001111');
  });

  it('percent-encodes a phone containing a slash to block path traversal', async () => {
    httpService.request.mockReturnValue(of({ data: [] }));

    await client.getOrderHistory('/555/0001111', '52');

    const requestConfig = httpService.request.mock.calls[0]?.[0];
    const url = requestConfig?.url;

    expect(url).toContain('%2F555%2F0001111');
    expect(url).not.toContain('/555/0001111');
  });

  it('percent-encodes productId, saleId, and order-history phone segments', async () => {
    httpService.request.mockReturnValue(of({ data: {} }));

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
      of({
        data: {
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
        },
      }),
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
      of({
        data: {
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
        },
      }),
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
      of({
        data: {
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
        },
      }),
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
      of({
        data: {
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
        },
      }),
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
      of({
        data: {
          id: 'p-1',
          bankName: 'AFIRME',
          beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
          isActive: true,
          updatedAt: '2026-08-24T12:00:00.000Z',
        },
      }),
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
});

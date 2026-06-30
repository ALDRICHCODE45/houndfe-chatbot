import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import type { AppConfig } from '../../config/configuration';
import {
  AuthError,
  BranchMismatchError,
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
});

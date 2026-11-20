import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import {
  AuthError,
  ChatbotApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { BackorderHttpClient } from './backorder-http.client';

const ID = '8c1d0000-1111-4222-8333-444455556666';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const KEY = `backorder:${DECISION}:5215512349901`;
const backorder = {
  id: ID,
  folio: 'BO-000012',
  status: 'WAITING',
  productId: PRODUCT,
  productName: 'Croquetas Adulto Raza Grande 18 kg',
  variantId: null,
  variantName: null,
  quantity: 2,
  referencePriceCents: 114900,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: '2026-11-20T15:00:00.000Z',
  estimatedAt: '2026-11-27T15:00:00.000Z',
  estimatedArrivalDays: 7,
  reservedAt: null,
  reservedUntil: null,
  reminderAt: null,
  queuePosition: 3,
  saleId: null,
  cancelledByKind: null,
  cancelReason: null,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
};
const input = {
  phoneCountryCode: '52',
  phone: '5512349901',
  customer: { mode: 'existing' as const, customerId: CUSTOMER },
  productId: PRODUCT,
  variantId: null,
  quantity: 2,
  sourceDecisionId: DECISION,
};
const response = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
const httpError = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data, headers },
  });

describe('backorder HTTP adapter', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let sleep: jest.Mock;
  let client: BackorderHttpClient;
  beforeEach(() => {
    const http = new HttpService();
    request = jest
      .spyOn(http, 'request')
      .mockImplementation(() => throwError(() => new Error('unexpected HTTP')));
    sleep = jest.fn().mockResolvedValue(undefined);
    client = new BackorderHttpClient(
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

  describe('createBackorder', () => {
    it('POSTs once with the bearer, branch and idempotency headers; 201 is created', async () => {
      request.mockReturnValue(of(response({ backorder }, 201)));
      await expect(client.createBackorder(input, KEY)).resolves.toEqual({
        created: true,
        backorder,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: '/chatbot-api/backorders',
          baseURL: 'https://example.invalid',
          data: input,
          headers: {
            Authorization: 'Bearer svc_test',
            'X-Branch-Id': 'branch',
            'X-Idempotency-Key': KEY,
          },
        }),
      );
    });

    it('200 is the same key replayed (created false); unknown keys are stripped', async () => {
      request.mockReturnValue(
        of(response({ backorder: { ...backorder, extra: 1 } }, 200)),
      );
      await expect(client.createBackorder(input, KEY)).resolves.toEqual({
        created: false,
        backorder,
      });
    });

    it('never sends expectedReferencePriceCents unless the caller does', async () => {
      request.mockReturnValue(of(response({ backorder }, 201)));
      await client.createBackorder(input, KEY);
      const sent = (request.mock.calls[0][0] as { data: object }).data;
      expect(Object.keys(sent)).not.toContain('expectedReferencePriceCents');
    });

    it.each([
      [409, 'STOCK_AVAILABLE_NOW', { availableToSell: 5 }],
      [409, 'BACKORDER_DUPLICATE', { backorderId: ID }],
      [409, 'IDEMPOTENCY_KEY_IN_FLIGHT', {}],
      [404, 'CUSTOMER_NOT_FOUND', {}],
      [422, 'PRICE_UNAVAILABLE', {}],
      [503, 'BACKORDER_RETRY_REQUIRED', {}],
    ])(
      'surfaces %s %s as a ChatbotApiError with the code and body, ONE attempt',
      async (status, code, detail) => {
        request.mockReturnValue(
          throwError(() =>
            httpError(status, {
              statusCode: status,
              error: code,
              message: code,
              ...detail,
            }),
          ),
        );
        const error = await client
          .createBackorder(input, KEY)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ChatbotApiError);
        expect(error).toMatchObject({ statusCode: status, errorCode: code });
        expect((error as ChatbotApiError).responseBody).toMatchObject(detail);
        expect(request).toHaveBeenCalledTimes(1);
      },
    );

    it('maps 401/403/404/429 to the shared error classes', async () => {
      const cases: Array<[number, new (...args: never[]) => Error]> = [
        [401, AuthError],
        [403, ForbiddenError],
        [404, NotFoundError],
      ];
      for (const [status, type] of cases) {
        request.mockReturnValueOnce(throwError(() => httpError(status, {})));
        await expect(client.createBackorder(input, KEY)).rejects.toBeInstanceOf(
          type,
        );
      }
      request.mockReturnValueOnce(
        throwError(() => httpError(429, {}, { 'retry-after': '7' })),
      );
      const limited = await client
        .createBackorder(input, KEY)
        .catch((e: unknown) => e);
      expect(limited).toBeInstanceOf(RateLimitError);
      expect((limited as RateLimitError).retryAfterSeconds).toBe(7);
    });

    it('a network failure has no status (unknown outcome) and is not retried', async () => {
      request.mockReturnValue(
        throwError(() =>
          Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
        ),
      );
      const error = await client
        .createBackorder(input, KEY)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).statusCode).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an unexpected status', response({ backorder }, 202)],
      ['a body without the envelope', response({}, 201)],
      ['a malformed backorder', response({ backorder: { id: ID } }, 201)],
    ])('%s is an UpstreamError', async (_label, bad) => {
      request.mockReturnValue(of(bad));
      await expect(client.createBackorder(input, KEY)).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });

    it.each(['', '   ', 'x'.repeat(201)])(
      'refuses the idempotency key %j locally, with no request',
      async (key) => {
        await expect(client.createBackorder(input, key)).rejects.toBeInstanceOf(
          ChatbotApiError,
        );
        expect(request).not.toHaveBeenCalled();
      },
    );
  });

  describe('getBackorder', () => {
    it('GETs the id and retries a 5xx (safe read)', async () => {
      request
        .mockReturnValueOnce(throwError(() => httpError(502, {})))
        .mockReturnValueOnce(of(response({ backorder })));
      await expect(client.getBackorder(ID)).resolves.toEqual(backorder);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: `/chatbot-api/backorders/${ID}`,
        }),
      );
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('404 BACKORDER_NOT_FOUND is a NotFoundError with the code', async () => {
      request.mockReturnValue(
        throwError(() =>
          httpError(404, {
            statusCode: 404,
            error: 'BACKORDER_NOT_FOUND',
            message: 'BACKORDER_NOT_FOUND',
          }),
        ),
      );
      await expect(client.getBackorder(ID)).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'BACKORDER_NOT_FOUND',
      });
    });

    it('encodes the id in the path', async () => {
      request.mockReturnValue(of(response({ backorder })));
      await client.getBackorder('a/b');
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/chatbot-api/backorders/a%2Fb' }),
      );
    });
  });

  describe('listBackorders', () => {
    it('sends only the given filters and returns the items', async () => {
      request.mockReturnValue(of(response({ items: [backorder] })));
      await expect(
        client.listBackorders({
          phoneCountryCode: '52',
          phone: '5512349901',
          status: 'WAITING,RESERVED',
        }),
      ).resolves.toEqual([backorder]);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: '/chatbot-api/backorders',
          params: {
            phoneCountryCode: '52',
            phone: '5512349901',
            status: 'WAITING,RESERVED',
          },
        }),
      );
    });

    it('an invalid item makes the whole list an UpstreamError', async () => {
      request.mockReturnValue(of(response({ items: [{ id: ID }] })));
      await expect(client.listBackorders()).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });
  });

  describe('cancelBackorder', () => {
    it('POSTs the optional reason once and returns the cancelled backorder', async () => {
      const cancelled = {
        ...backorder,
        status: 'CANCELLED',
        cancelledByKind: 'CUSTOMER',
      };
      request.mockReturnValue(of(response({ backorder: cancelled })));
      await expect(
        client.cancelBackorder(ID, 'ya no lo necesito'),
      ).resolves.toEqual(cancelled);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: `/chatbot-api/backorders/${ID}/cancel`,
          data: { reason: 'ya no lo necesito' },
        }),
      );
    });

    it('sends an empty body when there is no reason', async () => {
      request.mockReturnValue(of(response({ backorder })));
      await client.cancelBackorder(ID);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ data: {} }),
      );
    });

    it('409 BACKORDER_NOT_CANCELLABLE keeps its code for the caller', async () => {
      request.mockReturnValue(
        throwError(() =>
          httpError(409, {
            statusCode: 409,
            error: 'BACKORDER_NOT_CANCELLABLE',
            message: 'BACKORDER_NOT_CANCELLABLE',
            status: 'CANCELLED',
          }),
        ),
      );
      await expect(client.cancelBackorder(ID)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'BACKORDER_NOT_CANCELLABLE',
      });
    });
  });
});

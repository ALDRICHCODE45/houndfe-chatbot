import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

/**
 * Pay in store S3 (odd/tasks/pay-in-store.md): `PATCH
 * /chatbot-api/sales/:saleId/payment-intent` and the live `hold` sibling of
 * `GET /chatbot-api/checkouts/status` (backend contract
 * docs/chatbot-handoff/pay-in-store-hold-bot-contract.md).
 */

const SALE = '8c1d0000-1111-4222-8333-444455556666';
const KEY = '7b1d0000-1111-4222-8333-444455556666';
const hold = {
  saleId: SALE,
  folio: 'B-0042',
  paymentIntent: 'IN_STORE',
  holdUntil: '2026-11-19T18:30:00.000Z',
  reminderAt: '2026-11-19T15:30:00.000Z',
};
const response = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
const httpError = (status: number, data: unknown) =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data, headers: {} },
  });
const pickupCheckout = {
  status: 'created',
  customer: {
    resolution: 'existing',
    customerId: '22222222-2222-4222-8222-222222222222',
    firstName: 'Ana',
    lastName: null,
  },
  address: null,
  sale: {
    saleId: SALE,
    folio: 'B-0042',
    paymentStatus: 'CREDIT',
    channel: 'ONLINE',
    deliveryStatus: 'PENDING',
    totalCents: 3000,
    paidCents: 0,
    debtCents: 3000,
    confirmedAt: '2026-11-18T18:30:00.000Z',
    discountCents: 0,
    fulfillmentMode: 'PICKUP',
  },
  pickupLocation: { name: 'Sucursal Centro', address: null, hours: null },
};

describe('pay in store chatbot-api calls', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let sleep: jest.Mock;
  let client: ChatbotApiHttpClient;
  beforeEach(() => {
    const http = new HttpService();
    request = jest
      .spyOn(http, 'request')
      .mockImplementation(() => throwError(() => new Error('unexpected HTTP')));
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

  describe('PATCH /chatbot-api/sales/:saleId/payment-intent', () => {
    it('sends {"method":"IN_STORE"} once and returns the normalized hold', async () => {
      request.mockReturnValue(of(response({ ...hold, extra: 'ignored' })));
      await expect(client.setPayInStoreIntent(SALE)).resolves.toEqual(hold);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          url: `/chatbot-api/sales/${SALE}/payment-intent`,
          data: { method: 'IN_STORE' },
          headers: {
            Authorization: 'Bearer svc_test',
            'X-Branch-Id': 'branch',
          },
        }),
      );
    });

    it('accepts a null folio and a null reminderAt (hold of 3 h or less)', async () => {
      request.mockReturnValue(
        of(response({ ...hold, folio: null, reminderAt: null })),
      );
      await expect(client.setPayInStoreIntent(SALE)).resolves.toEqual({
        ...hold,
        folio: null,
        reminderAt: null,
      });
    });

    it.each([
      [409, 'PAY_IN_STORE_SALE_ALREADY_PAID'],
      [409, 'PAY_IN_STORE_SALE_NOT_CONFIRMED'],
      [422, 'PAY_IN_STORE_REQUIRES_PICKUP'],
      [404, 'SALE_NOT_FOUND'],
    ])(
      'surfaces %s %s as a ChatbotApiError with the code, one attempt',
      async (status, code) => {
        request.mockReturnValue(
          throwError(() =>
            httpError(status, {
              statusCode: status,
              error: code,
              message: code,
            }),
          ),
        );
        const error = await client
          .setPayInStoreIntent(SALE)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ChatbotApiError);
        expect(error).toMatchObject({ statusCode: status, errorCode: code });
        expect(request).toHaveBeenCalledTimes(1);
      },
    );

    it('never retries a 5xx (one PATCH per tap)', async () => {
      request.mockReturnValue(throwError(() => httpError(503, {})));
      await expect(client.setPayInStoreIntent(SALE)).rejects.toBeInstanceOf(
        ChatbotApiError,
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it.each([
      ['another sale', { ...hold, saleId: KEY }],
      ['another intent', { ...hold, paymentIntent: 'TRANSFER' }],
      ['no deadline', { ...hold, holdUntil: null }],
      ['a bad deadline', { ...hold, holdUntil: 'mañana' }],
    ])('rejects a 200 with %s as an upstream error', async (_name, body) => {
      request.mockReturnValue(of(response(body)));
      await expect(client.setPayInStoreIntent(SALE)).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });

    it('rejects a non-UUID sale id before any HTTP', async () => {
      await expect(
        client.setPayInStoreIntent('../checkouts'),
      ).rejects.toBeInstanceOf(ChatbotApiError);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('GET /chatbot-api/checkouts/status with the live hold', () => {
    it('keeps the strict creation receipt and exposes the hold', async () => {
      const live = {
        paymentIntent: 'IN_STORE',
        expiresAt: '2026-11-19T18:30:00.000Z',
        reminderAt: '2026-11-19T15:30:00.000Z',
        stage: 1,
        version: 2,
      };
      request.mockReturnValue(
        of(
          response({
            status: 'succeeded',
            checkout: pickupCheckout,
            hold: live,
          }),
        ),
      );
      await expect(client.getCheckoutStatus(KEY)).resolves.toEqual({
        status: 'succeeded',
        checkout: pickupCheckout,
        hold: live,
      });
    });

    it('accepts hold: null (no intent declared)', async () => {
      request.mockReturnValue(
        of(
          response({
            status: 'succeeded',
            checkout: pickupCheckout,
            hold: null,
          }),
        ),
      );
      await expect(client.getCheckoutStatus(KEY)).resolves.toEqual({
        status: 'succeeded',
        checkout: pickupCheckout,
        hold: null,
      });
    });

    it('an answer without hold (backend before pay in store) stays as today', async () => {
      request.mockReturnValue(
        of(response({ status: 'succeeded', checkout: pickupCheckout })),
      );
      await expect(client.getCheckoutStatus(KEY)).resolves.toEqual({
        status: 'succeeded',
        checkout: pickupCheckout,
      });
    });
  });
});

import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import {
  CHATBOT_API_TIMEOUTS_MS,
  ChatbotApiHttpClient,
} from './chatbot-api-http.client';

const order = {
  saleId: '5c1a0e4e-1b7b-4c55-9a3f-0f3a1c2b9d10',
  folio: 'B-0042',
  confirmedAt: '2026-10-20T18:00:00.000Z',
  channel: 'ONLINE',
  deliveryStatus: 'DELIVERED',
  paymentStatus: 'PAID',
  totalCents: 159900,
  paidCents: 159900,
  debtCents: 0,
  items: [
    {
      productId: '0b6f2c0e-6a8e-4f7e-9f3a-2d1f6b9c4e11',
      variantId: null,
      productName: 'Croquetas Adulto 18 kg',
      variantName: null,
      quantity: 1,
      unitPriceCents: 159900,
    },
  ],
  payments: [],
  shippingAddress: null,
};
const response = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});

describe('getOrderHistory response parsing', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let warn: jest.SpiedFunction<Logger['warn']>;
  let client: ChatbotApiHttpClient;

  beforeEach(() => {
    const http = new HttpService();
    request = jest
      .spyOn(http, 'request')
      .mockImplementation(() => throwError(() => new Error('unexpected HTTP')));
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    client = new ChatbotApiHttpClient(
      http,
      new ConfigService({
        chatbotApi: {
          baseUrl: 'https://example.invalid',
          serviceKey: 'svc_test',
          branchId: 'branch',
        },
      }),
      jest.fn().mockResolvedValue(undefined),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('GETs the history with phoneCountryCode and the default timeout, returning the parsed body', async () => {
    request.mockReturnValue(of(response([order])));
    await expect(client.getOrderHistory('5512345678', '52')).resolves.toEqual([
      order,
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    const config = request.mock.calls[0][0];
    expect(config.method).toBe('GET');
    expect(config.url).toBe(
      '/chatbot-api/customers/by-phone/5512345678/orders',
    );
    expect(config.params).toEqual({ phoneCountryCode: '52' });
    expect(config.timeout).toBe(CHATBOT_API_TIMEOUTS_MS.default);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns [] for a customer without orders', async () => {
    request.mockReturnValue(of(response([])));
    await expect(client.getOrderHistory('5512345678', '52')).resolves.toEqual(
      [],
    );
  });

  it('strips unknown keys and warns once by name, never by value', async () => {
    request.mockReturnValue(
      of(response([{ ...order, internalNote: 'SECRET-NOTE' }])),
    );
    await expect(client.getOrderHistory('5512345678', '52')).resolves.toEqual([
      order,
    ]);
    await client.getOrderHistory('5512345678', '52');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('[].internalNote');
    expect(logged).not.toContain('SECRET-NOTE');
  });

  it.each([
    ['an object', { orders: [order] }],
    [
      'a zero quantity',
      [{ ...order, items: [{ ...order.items[0], quantity: 0 }] }],
    ],
    ['a missing total', [{ ...order, totalCents: undefined }]],
  ])('maps %s to UpstreamError', async (_label, body) => {
    request.mockReturnValue(of(response(body)));
    const error = await client
      .getOrderHistory('5512345678', '52')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toMatch(/response was invalid/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-200 success status', async () => {
    request.mockReturnValue(of(response([order], 204)));
    await expect(
      client.getOrderHistory('5512345678', '52'),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it.each(['', '   '])(
    'refuses a blank phoneCountryCode %j before any request',
    async (cc) => {
      const error = await client
        .getOrderHistory('5512345678', cc)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChatbotApiError);
      expect(request).not.toHaveBeenCalled();
    },
  );
});

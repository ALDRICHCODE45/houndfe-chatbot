import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const id = '11111111-1111-4111-8111-111111111111';
const input = {
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
      {
        productId: id,
        productName: 'Food',
        quantity: 1,
        unitPriceCents: 60000,
      },
    ],
    expectedTotalCents: 61000,
    shipping: { chargeCents: 1000, approvalId: 'approval-1' },
  },
};
const receipt = {
  status: 'created',
  customer: {
    resolution: 'existing',
    customerId: id,
    firstName: 'Ana',
    lastName: null,
  },
  address: {
    resolution: 'existing',
    id,
    version: input.deliveryAddress.expectedVersion,
  },
  sale: {
    saleId: id,
    folio: null,
    paymentStatus: 'CREDIT',
    channel: 'ONLINE',
    deliveryStatus: 'PENDING',
    totalCents: 61000,
    subtotalCents: 60000,
    shippingChargeCents: 1000,
    paidCents: 0,
    debtCents: 61000,
    confirmedAt: null,
  },
};
const response = (data: unknown, status = 201) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});

describe('atomic checkout mocked HTTP contract (endpoint not live)', () => {
  const key = 'checkout-secret-key';
  let request: jest.SpiedFunction<HttpService['request']>;
  let client: ChatbotApiHttpClient;
  let sleep: jest.Mock;
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
  it('posts the exact freight-inclusive payload once with authenticated headers', async () => {
    request.mockReturnValue(of(response(receipt)));
    await expect(client.createCheckout(input, key)).resolves.toEqual({
      ...receipt,
      sale: { ...receipt.sale, discountCents: 0 },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/chatbot-api/checkouts',
        data: input,
        headers: {
          'X-Idempotency-Key': key,
          Authorization: 'Bearer svc_test',
          'X-Branch-Id': 'branch',
        },
      }),
    );
  });
  it('sends createIfAbsent/newSaved without freight for a covered delivery', async () => {
    const sale = { ...input.sale, shipping: undefined };
    const freeInput = {
      ...input,
      customer: { mode: 'createIfAbsent' as const, firstName: 'Ana' },
      deliveryAddress: {
        mode: 'newSaved' as const,
        address: { street: 'Centro' },
      },
      sale: { ...sale, expectedTotalCents: 60000 },
    };
    request.mockReturnValue(of(response(receipt)));
    await client.createCheckout(freeInput, key);
    expect(request.mock.calls[0][0].data).toEqual(freeInput);
  });
  it('omits null quoteId without mutating the caller', async () => {
    const dto = {
      ...input,
      sale: {
        ...input.sale,
        shipping: { ...input.sale.shipping, quoteId: null },
      },
    };
    request.mockReturnValue(of(response(receipt)));
    await client.createCheckout(dto, key);
    expect(request.mock.calls[0][0].data).toEqual(input);
    expect(dto.sale.shipping.quoteId).toBeNull();
  });
  it('does not retry an ambiguous POST but safely retries a status network failure', async () => {
    request.mockReturnValue(throwError(() => ({ code: 'ETIMEDOUT' })));
    await expect(client.createCheckout(input, key)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear();
    request
      .mockReturnValueOnce(throwError(() => ({ code: 'ETIMEDOUT' })))
      .mockReturnValueOnce(
        of(response({ status: 'not_observed', checkout: null }, 200)),
      );
    await expect(client.getCheckoutStatus(key)).resolves.toEqual({
      status: 'not_observed',
      checkout: null,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });
  it('rejects mixed-mode input before HTTP', async () => {
    await expect(
      client.createCheckout(
        {
          ...input,
          customer: { ...input.customer, firstName: 'Injected' },
        } as typeof input,
        key,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['', 'x'.repeat(201), 'bad\r\nkey'])(
    'rejects invalid keys locally',
    async (invalid) => {
      await expect(
        client.createCheckout(input, invalid),
      ).rejects.toBeInstanceOf(ChatbotApiError);
      await expect(client.getCheckoutStatus(invalid)).rejects.toBeInstanceOf(
        ChatbotApiError,
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each(['succeeded', 'not_observed'])(
    'polls %s using a header only',
    async (status) => {
      const body = {
        status,
        checkout: status === 'succeeded' ? receipt : null,
      };
      request.mockReturnValue(of(response(body, 200)));
      await expect(client.getCheckoutStatus(key)).resolves.toMatchObject({
        status,
      });
      const config = request.mock.calls[0][0];
      expect(config.url).toBe('/chatbot-api/checkouts/status');
      expect(config.params).toBeUndefined();
      expect(config.data).toBeUndefined();
      expect(config.headers).toEqual({
        'X-Idempotency-Key': key,
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
      });
    },
  );
  it.each([{}, { ...receipt, sale: null }])(
    'rejects malformed created bodies',
    async (body) => {
      request.mockReturnValue(of(response(body)));
      await expect(client.createCheckout(input, key)).rejects.toBeInstanceOf(
        UpstreamError,
      );
    },
  );
  it('rejects wrong success statuses and malformed status bodies', async () => {
    request.mockReturnValue(of(response(receipt, 200)));
    await expect(client.createCheckout(input, key)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    request.mockReturnValue(
      of(response({ status: 'succeeded', checkout: null }, 200)),
    );
    await expect(client.getCheckoutStatus(key)).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
  it.each([
    [409, 'CUSTOMER_PHONE_AMBIGUOUS'],
    [409, 'ADDRESS_VERSION_CONFLICT'],
    [409, 'IDEMPOTENCY_KEY_CONFLICT'],
    [409, 'IDEMPOTENCY_KEY_IN_FLIGHT'],
    [503, 'CHECKOUT_RETRY_REQUIRED'],
    [409, 'PROMO_RE_QUOTE'],
    [401, 'UNAUTHORIZED'],
    [404, 'CASHIER_NOT_FOUND'],
  ])(
    'preserves sanitized %s %s errors without retrying POST',
    async (statusCode, error) => {
      const body = { statusCode, error, message: 'Checkout rejected' };
      request.mockReturnValue(
        throwError(() => ({ response: { status: statusCode, data: body } })),
      );
      await expect(client.createCheckout(input, key)).rejects.toMatchObject({
        statusCode,
        errorCode: error,
        responseBody: body,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});

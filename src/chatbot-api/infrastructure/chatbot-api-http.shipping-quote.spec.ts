import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import {
  PACKAGING_DATA_MISSING,
  type ShippingQuoteResponse,
} from '../domain/dtos/shipping-quote.dto';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';
import { FakeShippingQuoteClient } from './fake-shipping-quote.client';

const id = '11111111-1111-4111-8111-111111111111';
const input = {
  items: [{ productId: id, quantity: 2 }],
  phoneCountryCode: '52',
  phone: '5512345678',
  destination: { shippingAddressId: id },
};
const quote: ShippingQuoteResponse = {
  quoteId: 'quote-1',
  expiresAt: '2026-11-05T12:00:00.000Z',
  zoneStatus: 'FREE',
  option: null,
  costCents: 0,
  creditCents: 0,
  customerChargeCents: 0,
  currency: 'MXN',
  eta: { days: 2, reason: null },
};
const response = (data: unknown, status = 201) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});

describe('shipping quote mocked HTTP contract', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let client: ChatbotApiHttpClient;
  beforeEach(() => {
    const http = new HttpService();
    request = jest
      .spyOn(http, 'request')
      .mockImplementation(() => throwError(() => new Error('unexpected HTTP')));
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

  it('posts the exact path and body once with authenticated headers', async () => {
    request.mockReturnValue(of(response(quote)));
    await expect(client.createShippingQuote(input)).resolves.toEqual(quote);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/chatbot-api/shipping/quotes',
        data: input,
        headers: {
          Authorization: 'Bearer svc_test',
          'X-Branch-Id': 'branch',
        },
      }),
    );
  });

  it('accepts a 200 response', async () => {
    request.mockReturnValue(of(response(quote, 200)));
    await expect(client.createShippingQuote(input)).resolves.toEqual(quote);
  });

  it('rejects an invalid request before any HTTP', async () => {
    await expect(
      client.createShippingQuote({
        ...input,
        destination: { shippingAddressId: id, zipCode: '06000' },
      }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_SHIPPING_QUOTE_REQUEST' });
    expect(request).not.toHaveBeenCalled();
  });

  it('maps a 422 PACKAGING_DATA_MISSING to ChatbotApiError with that code', async () => {
    const body = { error: PACKAGING_DATA_MISSING };
    request.mockReturnValue(
      throwError(() => ({ response: { status: 422, data: body } })),
    );
    const error = await client
      .createShippingQuote(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatbotApiError);
    expect(error).toMatchObject({
      statusCode: 422,
      errorCode: PACKAGING_DATA_MISSING,
      responseBody: body,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an unknown zoneStatus with UpstreamError evidence', async () => {
    const body = { ...quote, zoneStatus: 'MAYBE' };
    request.mockReturnValue(of(response(body)));
    const error = await client
      .createShippingQuote(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ statusCode: 201, responseBody: body });
  });

  it('does not retry an ambiguous POST network failure', async () => {
    request.mockReturnValue(throwError(() => ({ code: 'ETIMEDOUT' })));
    await expect(client.createShippingQuote(input)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('FakeShippingQuoteClient', () => {
  it('records calls and returns queued results in order', async () => {
    const fake = new FakeShippingQuoteClient();
    const error = new ChatbotApiError('x', 422, undefined, 'X');
    fake.enqueue(quote).enqueue(error);
    await expect(fake.createShippingQuote(input)).resolves.toEqual(quote);
    await expect(fake.createShippingQuote(input)).rejects.toBe(error);
    await expect(fake.createShippingQuote(input)).rejects.toThrow(
      'no shipping quote queued',
    );
    expect(fake.calls).toEqual([input, input, input]);
  });
});

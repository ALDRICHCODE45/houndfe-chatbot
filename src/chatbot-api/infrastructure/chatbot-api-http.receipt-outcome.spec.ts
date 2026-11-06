import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const RECEIPT = '33333333-3333-4333-8333-333333333333';
const outcome = {
  status: 'CONFIRMED',
  sale: { debtCents: 0, paymentStatus: 'PAID' },
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

describe('GET /chatbot-api/receipts/:receiptId (receipt outcome)', () => {
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

  it('reads the outcome with the service credential and parses it', async () => {
    request.mockReturnValue(of(response(outcome)));
    await expect(client.getReceiptOutcome(RECEIPT)).resolves.toEqual({
      ...outcome,
      customerReason: null,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: `/chatbot-api/receipts/${RECEIPT}`,
        headers: { Authorization: 'Bearer svc_test', 'X-Branch-Id': 'branch' },
      }),
    );
  });

  it('returns the customer reason of a rejection', async () => {
    request.mockReturnValue(
      of(
        response({
          status: 'REJECTED',
          customerReason: 'El monto no coincide',
          sale: { debtCents: 150000, paymentStatus: 'CREDIT' },
        }),
      ),
    );
    await expect(client.getReceiptOutcome(RECEIPT)).resolves.toMatchObject({
      status: 'REJECTED',
      customerReason: 'El monto no coincide',
    });
  });

  it('retries a 5xx with the GET policy and then succeeds', async () => {
    request
      .mockReturnValueOnce(throwError(() => httpError(503, {})))
      .mockReturnValueOnce(of(response(outcome)));
    await expect(client.getReceiptOutcome(RECEIPT)).resolves.toMatchObject({
      status: 'CONFIRMED',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('maps a 403 with body.error and never retries', async () => {
    request.mockReturnValue(
      throwError(() => httpError(403, { error: 'INSUFFICIENT_SCOPE' })),
    );
    const error = await client
      .getReceiptOutcome(RECEIPT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatbotApiError);
    expect(error).toMatchObject({
      statusCode: 403,
      errorCode: 'INSUFFICIENT_SCOPE',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed 200 body as an upstream error', async () => {
    request.mockReturnValue(
      of(response({ status: 'APPROVED', sale: outcome.sale })),
    );
    await expect(client.getReceiptOutcome(RECEIPT)).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('rejects a non-UUID receipt id before any HTTP', async () => {
    await expect(client.getReceiptOutcome('../sales')).rejects.toBeInstanceOf(
      ChatbotApiError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});

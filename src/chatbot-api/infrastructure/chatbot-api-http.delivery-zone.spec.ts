import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const SOURCE = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
const REQUESTER = 'c41b2c3d-1111-4222-8333-444455556666';
const DECISION = '8a2f0000-1111-4222-8333-444455556666';
const intake = {
  sourceRequestId: SOURCE,
  type: 'DELIVERY_ZONE' as const,
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
  phoneCountryCode: '52',
  phone: '5512345678',
  conversationRef: 'wa:5215512345678',
  lastCustomerMessageAt: '2026-11-05T10:00:00.000Z',
};
const requester = {
  id: REQUESTER,
  sourceRequestId: SOURCE,
  type: 'DELIVERY_ZONE',
  status: 'PENDING',
  version: 1,
  createdAt: '2026-11-05T10:01:00.000Z',
  decisionId: DECISION,
  snapshot: {
    branchName: 'Sucursal Centro',
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  },
  resolution: null,
  applyBefore: null,
};
const response = (data: unknown, status = 201) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});

describe('DELIVERY_ZONE mocked HTTP contract', () => {
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

  it('posts the exact intake body once with X-Idempotency-Key = sourceRequestId', async () => {
    request.mockReturnValue(of(response(requester)));
    await expect(client.submitDeliveryZoneIntake(intake)).resolves.toEqual(
      requester,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/chatbot-api/human-decisions',
        data: intake,
        headers: {
          'X-Idempotency-Key': SOURCE,
          Authorization: 'Bearer svc_test',
          'X-Branch-Id': 'branch',
        },
      }),
    );
    expect(Object.keys(request.mock.calls[0][0].data as object)).toEqual(
      Object.keys(intake),
    );
  });

  it('accepts a 200 replay', async () => {
    request.mockReturnValue(of(response(requester, 200)));
    await expect(client.submitDeliveryZoneIntake(intake)).resolves.toEqual(
      requester,
    );
  });

  it('rejects an invalid intake before any HTTP', async () => {
    await expect(
      client.submitDeliveryZoneIntake({ ...intake, zipCode: '123' }),
    ).rejects.toBeInstanceOf(ChatbotApiError);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an intake response bound to another sourceRequestId', async () => {
    request.mockReturnValue(
      of(
        response({
          ...requester,
          sourceRequestId: '11111111-1111-4111-8111-111111111111',
        }),
      ),
    );
    await expect(
      client.submitDeliveryZoneIntake(intake),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it('maps a 409 IDEMPOTENCY_CONFLICT from body.error and never retries', async () => {
    const body = { error: 'IDEMPOTENCY_CONFLICT' };
    request.mockReturnValue(
      throwError(() => ({ response: { status: 409, data: body } })),
    );
    await expect(client.submitDeliveryZoneIntake(intake)).rejects.toMatchObject(
      { statusCode: 409, errorCode: 'IDEMPOTENCY_CONFLICT' },
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('polls GET /human-decisions/:id and binds the requester id', async () => {
    request.mockReturnValue(of(response(requester, 200)));
    await expect(client.getDeliveryZoneRequester(REQUESTER)).resolves.toEqual(
      requester,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: `/chatbot-api/human-decisions/${REQUESTER}`,
      }),
    );
  });

  it('rejects a poll body for another requester', async () => {
    request.mockReturnValue(of(response({ ...requester, id: DECISION }, 200)));
    await expect(
      client.getDeliveryZoneRequester(REQUESTER),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it('rejects a non-UUID requester id before any HTTP', async () => {
    await expect(
      client.getDeliveryZoneRequester('../x'),
    ).rejects.toBeInstanceOf(ChatbotApiError);
    expect(request).not.toHaveBeenCalled();
  });
});

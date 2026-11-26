import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { UpstreamError } from '../domain/errors';
import {
  BRANCH_CACHE_TTL_MS,
  ChatbotApiHttpClient,
} from './chatbot-api-http.client';

/**
 * T2 H1 (odd/tasks/store-info-and-suggestions.md): `GET /chatbot-api/branch`
 * (scope `catalog:read`), the branch name, address, hours and pin — the same
 * source and shapes as the checkout `pickupLocation`. Strict body (drift is
 * an error the agent reads as unavailable); a 5-minute in-process cache that
 * never keeps a failure.
 */
const branch = {
  name: 'Sucursal Centro',
  address: {
    addressLine1: 'Av. Juárez 123',
    addressLine2: null,
    neighborhood: 'Centro',
    municipality: 'Cuauhtémoc',
    state: 'Ciudad de México',
    postalCode: '06000',
    formatted: 'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, 06000',
  },
  hours: {
    timeZone: 'America/Mexico_City',
    days: [
      {
        day: 'MONDAY',
        label: 'Lunes',
        closed: false,
        ranges: [{ open: '09:00', close: '18:00' }],
      },
    ],
    summary: 'Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
  },
  location: { latitude: 19.4326, longitude: -99.1332 },
};
const response = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
const httpError = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data, headers: {} },
  });

describe('GET /chatbot-api/branch (T2 H1)', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let client: ChatbotApiHttpClient;
  let now: jest.SpiedFunction<typeof Date.now>;
  beforeEach(() => {
    const http = new HttpService();
    request = jest
      .spyOn(http, 'request')
      .mockImplementation(() => throwError(() => new Error('unexpected HTTP')));
    now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
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

  it('reads the branch with the service credential and returns it parsed', async () => {
    request.mockReturnValue(of(response(branch)));
    await expect(client.getBranch()).resolves.toEqual(branch);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/chatbot-api/branch',
        headers: { Authorization: 'Bearer svc_test', 'X-Branch-Id': 'branch' },
      }),
    );
  });

  it('accepts null address, hours and location (staff have not set them)', async () => {
    const bare = {
      name: 'Sucursal',
      address: null,
      hours: null,
      location: null,
    };
    request.mockReturnValue(of(response(bare)));
    await expect(client.getBranch()).resolves.toEqual(bare);
  });

  it.each([
    ['an extra key', { ...branch, phone: '555' }],
    ['a missing location key', { ...branch, location: undefined }],
    [
      'a latitude out of range',
      { ...branch, location: { latitude: 91, longitude: 0 } },
    ],
    [
      'a longitude out of range',
      { ...branch, location: { latitude: 0, longitude: -181 } },
    ],
    [
      'string coordinates',
      { ...branch, location: { latitude: '19.4', longitude: '-99.1' } },
    ],
    [
      'an address without formatted',
      { ...branch, address: { ...branch.address, formatted: undefined } },
    ],
    ['an empty name', { ...branch, name: '' }],
    ['a non-object body', 'ok'],
  ])('drift (%s) rejects with UpstreamError', async (_name, body) => {
    request.mockReturnValue(of(response(JSON.parse(JSON.stringify(body)))));
    await expect(client.getBranch()).rejects.toBeInstanceOf(UpstreamError);
  });

  it('a 5xx (after the safe GET retries) rejects', async () => {
    request.mockReturnValue(throwError(() => httpError(503)));
    await expect(client.getBranch()).rejects.toBeInstanceOf(UpstreamError);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('a cache hit within 5 minutes makes no second request; past the TTL it reads again', async () => {
    request.mockReturnValue(of(response(branch)));
    await client.getBranch();
    now.mockReturnValue(1_000_000 + BRANCH_CACHE_TTL_MS - 1);
    await expect(client.getBranch()).resolves.toEqual(branch);
    expect(request).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + BRANCH_CACHE_TTL_MS);
    await client.getBranch();
    expect(request).toHaveBeenCalledTimes(2);
    expect(BRANCH_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it('a failure is never cached: the next call reads again', async () => {
    request.mockReturnValueOnce(of(response({ ...branch, extra: 1 })));
    await expect(client.getBranch()).rejects.toBeInstanceOf(UpstreamError);
    request.mockReturnValueOnce(of(response(branch)));
    await expect(client.getBranch()).resolves.toEqual(branch);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('the cached value cannot be mutated by a caller', async () => {
    request.mockReturnValue(of(response(branch)));
    const first = await client.getBranch();
    (first as { name: string }).name = 'changed';
    await expect(client.getBranch()).resolves.toEqual(branch);
  });
});

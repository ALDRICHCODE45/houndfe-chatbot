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

  describe('T4a: per-line pet and ?petId (customer-pets contract §6)', () => {
    const petId = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
    const line = order.items[0];
    const withPets = {
      ...order,
      items: [
        {
          ...line,
          pet: { id: petId, name: 'Bruno', species: 'DOG', status: 'ACTIVE' },
        },
        { ...line, productName: 'Shampoo', pet: null },
        {
          ...line,
          productName: 'Arena',
          pet: { id: null, name: 'Max', species: 'CAT', status: null },
        },
        { ...line, productName: 'Juguete' },
      ],
    };

    it('tolerates and parses pet: object, snapshot-only object, null and absent (deploy prerequisite)', async () => {
      request.mockReturnValue(of(response([withPets])));
      const [parsed] = await client.getOrderHistory('5512345678', '52');
      expect(parsed.items[0].pet).toEqual({
        id: petId,
        name: 'Bruno',
        species: 'DOG',
        status: 'ACTIVE',
      });
      expect(parsed.items[1].pet).toBeNull();
      expect(parsed.items[2].pet).toEqual({
        id: null,
        name: 'Max',
        species: 'CAT',
        status: null,
      });
      expect('pet' in parsed.items[3]).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('strips unknown members inside pet', async () => {
      request.mockReturnValue(
        of(
          response([
            {
              ...order,
              items: [
                {
                  ...line,
                  pet: {
                    id: petId,
                    name: 'Bruno',
                    species: 'DOG',
                    status: 'ARCHIVED',
                    extra: 1,
                  },
                },
              ],
            },
          ]),
        ),
      );
      const [parsed] = await client.getOrderHistory('5512345678', '52');
      expect(parsed.items[0].pet).toEqual({
        id: petId,
        name: 'Bruno',
        species: 'DOG',
        status: 'ARCHIVED',
      });
    });

    it.each([
      [
        'an object of nulls',
        { id: null, name: null, species: null, status: null },
      ],
      [
        'id without status',
        { id: petId, name: 'Bruno', species: 'DOG', status: null },
      ],
      [
        'a bad status',
        { id: petId, name: 'Bruno', species: 'DOG', status: 'GONE' },
      ],
      ['a string', 'Bruno'],
    ])(
      'T4b (L13 c): a pet with %s degrades to absent with a warning; the history still parses',
      async (_label, pet) => {
        request.mockReturnValue(
          of(
            response([
              {
                ...order,
                items: [
                  { ...line, pet },
                  {
                    ...line,
                    productName: 'Shampoo',
                    pet: {
                      id: petId,
                      name: 'Bruno',
                      species: 'DOG',
                      status: 'ACTIVE',
                    },
                  },
                ],
              },
            ]),
          ),
        );
        const [parsed] = await client.getOrderHistory('5512345678', '52');
        expect(parsed.items).toHaveLength(2);
        expect('pet' in parsed.items[0]).toBe(false);
        expect(parsed.items[0]).toEqual(line);
        expect(parsed.items[1].pet).toEqual({
          id: petId,
          name: 'Bruno',
          species: 'DOG',
          status: 'ACTIVE',
        });
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain('pet');
        expect(logged).toMatch(/absent/);
        // Never the pet's values.
        expect(logged).not.toContain('Bruno');
      },
    );

    it('T4b (L13 c): other line errors still fail the whole history', async () => {
      request.mockReturnValue(
        of(response([{ ...order, items: [{ ...line, quantity: 0, pet: 1 }] }])),
      );
      await expect(
        client.getOrderHistory('5512345678', '52'),
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it.each(['', '   '])(
      'T4b (L13 b): a blank petId %j is not sent as ?petId=',
      async (blank) => {
        request.mockReturnValue(of(response([withPets])));
        await client.getOrderHistory('5512345678', '52', { petId: blank });
        expect(request.mock.calls[0][0].params).toEqual({
          phoneCountryCode: '52',
        });
      },
    );

    it('sends ?petId= only when asked', async () => {
      request.mockReturnValue(of(response([withPets])));
      await client.getOrderHistory('5512345678', '52', { petId });
      expect(request.mock.calls[0][0].params).toEqual({
        phoneCountryCode: '52',
        petId,
      });
      await client.getOrderHistory('5512345678', '52', {});
      expect(request.mock.calls[1][0].params).toEqual({
        phoneCountryCode: '52',
      });
    });

    it('surfaces 404 PET_NOT_FOUND for ?petId as a NotFoundError with the code', async () => {
      request.mockReturnValue(
        throwError(() =>
          Object.assign(new Error('HTTP 404'), {
            response: {
              status: 404,
              headers: {},
              data: {
                statusCode: 404,
                error: 'PET_NOT_FOUND',
                message: 'PET_NOT_FOUND',
              },
            },
          }),
        ),
      );
      await expect(
        client.getOrderHistory('5512345678', '52', { petId }),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'PET_NOT_FOUND',
      });
    });
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

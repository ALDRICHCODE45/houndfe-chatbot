import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

/**
 * T4a: `customer.pets` in `GET /chatbot-api/customers/by-phone`
 * (customer-pets-bot-contract §1–§2). Absent without `pets:read`, an array
 * of ACTIVE pets with it. Also the deploy prerequisite (checklist item 3):
 * the lookup tolerates the new member.
 */
const customerId = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
const pet = {
  id: '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11',
  customerId,
  name: 'Bruno',
  species: 'DOG',
  speciesOther: null,
  breed: 'Chihuahua',
  size: 'SMALL',
  birthDate: '2026-01-01',
  birthDatePrecision: 'MONTH',
  ageMonths: 10,
  ageLabel: '~10 meses',
  allergies: 'Pollo',
  notes: null,
  status: 'ACTIVE',
  archivedAt: null,
  archivedReason: null,
  createdVia: 'CHATBOT',
  version: 3,
  createdAt: '2026-11-23T16:20:11.000Z',
  updatedAt: '2026-11-23T16:20:11.000Z',
};
const customer = {
  customerId,
  firstName: 'Ana',
  lastName: null,
  phoneCountryCode: '52',
  phone: '5512349901',
  preferredPaymentMethod: null,
  address: null,
};
const ok = (data: unknown) => ({
  data,
  status: 200,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});

describe('getCustomerByPhone customer.pets (T4a)', () => {
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
  afterEach(() => jest.restoreAllMocks());

  it('without pets:read the response is exactly the previous one (no pets key)', async () => {
    request.mockReturnValue(of(ok({ found: true, customer })));
    const lookup = await client.getCustomerByPhone('52', '5512349901');
    expect(lookup).toEqual({ found: true, customer });
    expect(Object.keys(lookup.customer ?? {})).not.toContain('pets');
  });

  it('parses customer.pets when present (deploy prerequisite: tolerated)', async () => {
    request.mockReturnValue(
      of(ok({ found: true, customer: { ...customer, pets: [pet] } })),
    );
    await expect(
      client.getCustomerByPhone('52', '5512349901'),
    ).resolves.toEqual({ found: true, customer: { ...customer, pets: [pet] } });
  });

  it('keeps an empty pets array distinct from absent', async () => {
    request.mockReturnValue(
      of(ok({ found: true, customer: { ...customer, pets: [] } })),
    );
    const lookup = await client.getCustomerByPhone('52', '5512349901');
    expect(lookup.customer?.pets).toEqual([]);
  });

  it('strips unknown pet members', async () => {
    request.mockReturnValue(
      of(
        ok({
          found: true,
          customer: { ...customer, pets: [{ ...pet, futureField: 1 }] },
        }),
      ),
    );
    const lookup = await client.getCustomerByPhone('52', '5512349901');
    expect(lookup.customer?.pets).toEqual([pet]);
  });

  it('leaves found:false untouched', async () => {
    request.mockReturnValue(of(ok({ found: false, customer: null })));
    await expect(
      client.getCustomerByPhone('52', '5512349901'),
    ).resolves.toEqual({ found: false, customer: null });
  });

  it.each([
    ['not an array', { bruno: pet }],
    ['a bad species', [{ ...pet, species: 'FISH' }]],
    ['a missing id', [{ ...pet, id: undefined }]],
  ])(
    'drops customer.pets with %s as absent (never a partial list) and keeps the lookup',
    async (_label, pets) => {
      request.mockReturnValue(
        of(ok({ found: true, customer: { ...customer, pets } })),
      );
      const lookup = await client.getCustomerByPhone('52', '5512349901');
      expect(lookup).toEqual({ found: true, customer });
      expect(lookup.customer).not.toHaveProperty('pets');
    },
  );
});

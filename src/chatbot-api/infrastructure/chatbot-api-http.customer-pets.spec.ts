import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import {
  ChatbotApiError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

/**
 * T4a: `/chatbot-api/customers/:customerId/pets` client
 * (docs/contracts/customer-pets-bot-contract.md §1–§4, §9).
 */
const customerId = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
const petId = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
const base = `/chatbot-api/customers/${customerId}/pets`;

const pet = {
  id: petId,
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
const archived = {
  ...pet,
  status: 'ARCHIVED',
  archivedAt: '2026-11-23T17:00:00.000Z',
  archivedReason: 'Se fue con otra familia',
  version: 4,
};

const ok = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
/** An axios-like HTTP failure with the code-only body (§1). */
const fail = (
  status: number,
  error?: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  throwError(() =>
    Object.assign(new Error(`HTTP ${status}`), {
      response: {
        status,
        headers,
        data:
          error === undefined
            ? { statusCode: status, message: 'Forbidden resource' }
            : { statusCode: status, error, message: error, ...extra },
      },
    }),
  );

const authHeaders = {
  Authorization: 'Bearer svc_test',
  'X-Branch-Id': 'branch',
};

describe('customer pets client (T4a)', () => {
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
  afterEach(() => jest.restoreAllMocks());

  const sent = (call = 0) => request.mock.calls[call][0];

  describe('listPets', () => {
    it('GETs the ACTIVE list by default (no status param) and returns the pets', async () => {
      request.mockReturnValue(of(ok([pet])));
      await expect(client.listPets(customerId)).resolves.toEqual({
        kind: 'ok',
        pets: [pet],
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sent()).toMatchObject({
        method: 'GET',
        url: base,
        headers: authHeaders,
      });
      expect(sent().params ?? {}).toEqual({});
      expect(sent().data).toBeUndefined();
    });

    it.each(['ACTIVE', 'ARCHIVED', 'ALL'] as const)(
      'sends ?status=%s when asked',
      async (status) => {
        request.mockReturnValue(of(ok([])));
        await expect(client.listPets(customerId, status)).resolves.toEqual({
          kind: 'ok',
          pets: [],
        });
        expect(sent().params).toEqual({ status });
      },
    );

    it('strips unknown pet members (the backend adds fields over time)', async () => {
      request.mockReturnValue(of(ok([{ ...pet, futureField: 'x' }])));
      const result = await client.listPets(customerId);
      expect(result).toEqual({ kind: 'ok', pets: [pet] });
    });

    it('is a safe GET: retries a 5xx and succeeds', async () => {
      request
        .mockReturnValueOnce(fail(503, 'CUSTOMER_PET_REQUEST_FAILED'))
        .mockReturnValueOnce(of(ok([pet])));
      await expect(client.listPets(customerId)).resolves.toEqual({
        kind: 'ok',
        pets: [pet],
      });
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('maps 404 CUSTOMER_NOT_FOUND', async () => {
      request.mockReturnValue(fail(404, 'CUSTOMER_NOT_FOUND'));
      await expect(client.listPets(customerId)).resolves.toEqual({
        kind: 'CUSTOMER_NOT_FOUND',
      });
    });

    it('maps 403 (missing pets:read) to FORBIDDEN', async () => {
      request.mockReturnValue(fail(403));
      await expect(client.listPets(customerId)).resolves.toEqual({
        kind: 'FORBIDDEN',
      });
    });

    it('rejects an undocumented 404 (old backend without the route)', async () => {
      request.mockReturnValue(fail(404, 'Not Found'));
      await expect(client.listPets(customerId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it.each([
      ['an object', { pets: [pet] }],
      ['a bad species', [{ ...pet, species: 'FISH' }]],
      ['a missing version', [{ ...pet, version: undefined }]],
    ])('rejects %s as UpstreamError', async (_label, body) => {
      request.mockReturnValue(of(ok(body)));
      await expect(client.listPets(customerId)).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });
  });

  describe('createPet', () => {
    const body = {
      name: 'Bruno',
      species: 'DOG' as const,
      breed: 'Chihuahua',
      size: 'SMALL' as const,
      approxAge: { months: 10 },
      allergies: 'Pollo',
    };
    const key = `pet-migration:${customerId}:1`;

    it('POSTs the body once with X-Idempotency-Key and returns the 201 pet + warnings', async () => {
      request.mockReturnValue(of(ok({ ...pet, warnings: [] }, 201)));
      await expect(client.createPet(customerId, body, key)).resolves.toEqual({
        kind: 'ok',
        created: true,
        pet,
        warnings: [],
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sent()).toMatchObject({
        method: 'POST',
        url: base,
        headers: { 'X-Idempotency-Key': key, ...authHeaders },
      });
      expect(JSON.stringify(sent().data)).toBe(JSON.stringify(body));
    });

    it('treats the 200 replay (same key + same body) as success, created=false', async () => {
      request.mockReturnValue(
        of(ok({ ...pet, warnings: ['PET_NAME_DUPLICATE'] }, 200)),
      );
      await expect(client.createPet(customerId, body, key)).resolves.toEqual({
        kind: 'ok',
        created: false,
        pet,
        warnings: ['PET_NAME_DUPLICATE'],
      });
    });

    it('a retry with the same key sends the same key and a byte-identical body', async () => {
      request
        .mockReturnValueOnce(fail(409, 'IDEMPOTENCY_KEY_IN_FLIGHT'))
        .mockReturnValueOnce(of(ok({ ...pet, warnings: [] }, 200)));
      await client.createPet(customerId, body, key);
      await client.createPet(customerId, body, key);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sent(1).headers).toEqual(sent(0).headers);
      expect(JSON.stringify(sent(1).data)).toBe(JSON.stringify(sent(0).data));
    });

    it('never sends undefined or unknown members', async () => {
      request.mockReturnValue(of(ok({ ...pet, warnings: [] }, 201)));
      const input = {
        name: 'Bruno',
        species: 'DOG' as const,
        breed: undefined,
        stray: 'x',
      };
      await client.createPet(customerId, input, key);
      expect(sent().data).toEqual({ name: 'Bruno', species: 'DOG' });
      expect(Object.keys(sent().data as object)).toEqual(['name', 'species']);
    });

    it('is single attempt: a 5xx is not retried', async () => {
      request.mockReturnValue(fail(500, 'CUSTOMER_PET_REQUEST_FAILED'));
      await expect(
        client.createPet(customerId, body, key),
      ).rejects.toBeInstanceOf(UpstreamError);
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it.each([
      [409, 'IDEMPOTENCY_KEY_CONFLICT'],
      [409, 'IDEMPOTENCY_KEY_IN_FLIGHT'],
      [400, 'INVALID_IDEMPOTENCY_KEY'],
      [404, 'CUSTOMER_NOT_FOUND'],
      [422, 'PET_LIMIT_REACHED'],
    ])('maps %i %s', async (status, code) => {
      request.mockReturnValue(fail(status, code));
      await expect(client.createPet(customerId, body, key)).resolves.toEqual({
        kind: code,
      });
    });

    it('maps 403 to FORBIDDEN', async () => {
      request.mockReturnValue(fail(403));
      await expect(client.createPet(customerId, body, key)).resolves.toEqual({
        kind: 'FORBIDDEN',
      });
    });

    it.each(['', '   ', 'k'.repeat(201)])(
      'refuses an invalid key %j before any request',
      async (bad) => {
        await expect(client.createPet(customerId, body, bad)).resolves.toEqual({
          kind: 'INVALID_IDEMPOTENCY_KEY',
        });
        expect(request).not.toHaveBeenCalled();
      },
    );

    it('sends the trimmed key', async () => {
      request.mockReturnValue(of(ok({ ...pet, warnings: [] }, 201)));
      await client.createPet(customerId, body, `  ${key}  `);
      expect(sent().headers).toMatchObject({ 'X-Idempotency-Key': key });
    });

    it('rejects a 400 validation failure (not a documented result)', async () => {
      request.mockReturnValue(fail(400, 'Bad Request'));
      await expect(
        client.createPet(customerId, body, key),
      ).rejects.toBeInstanceOf(ChatbotApiError);
    });

    it('rejects a 429 as RateLimitError with Retry-After', async () => {
      request.mockReturnValue(
        fail(429, 'Too Many Requests', {}, { 'retry-after': '7' }),
      );
      const error = await client
        .createPet(customerId, body, key)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBe(7);
    });

    it.each([
      ['no warnings', { ...pet }],
      ['non-string warnings', { ...pet, warnings: [1] }],
      ['a bad pet', { ...pet, name: 7, warnings: [] }],
    ])('rejects a 201 with %s as UpstreamError', async (_label, data) => {
      request.mockReturnValue(of(ok(data, 201)));
      await expect(
        client.createPet(customerId, body, key),
      ).rejects.toBeInstanceOf(UpstreamError);
    });
  });

  describe('patchPet', () => {
    it('PATCHes only the members given (null clears) with the version, no key', async () => {
      request.mockReturnValue(
        of(ok({ ...pet, version: 4, allergies: null, warnings: [] })),
      );
      const result = await client.patchPet(customerId, petId, {
        version: 3,
        allergies: null,
        size: 'MEDIUM',
      });
      expect(result).toEqual({
        kind: 'ok',
        pet: { ...pet, version: 4, allergies: null },
        warnings: [],
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sent()).toMatchObject({
        method: 'PATCH',
        url: `${base}/${petId}`,
        data: { version: 3, allergies: null, size: 'MEDIUM' },
      });
      expect(sent().headers).toEqual(authHeaders);
      expect(Object.keys(sent().data as object).sort()).toEqual(
        ['allergies', 'size', 'version'].sort(),
      );
    });

    it('exposes PET_NAME_DUPLICATE warnings', async () => {
      request.mockReturnValue(
        of(ok({ ...pet, warnings: ['PET_NAME_DUPLICATE'] })),
      );
      await expect(
        client.patchPet(customerId, petId, { version: 3, name: 'Bruno' }),
      ).resolves.toMatchObject({ warnings: ['PET_NAME_DUPLICATE'] });
    });

    it('maps 409 PET_VERSION_CONFLICT with currentVersion', async () => {
      request.mockReturnValue(
        fail(409, 'PET_VERSION_CONFLICT', { currentVersion: 5 }),
      );
      await expect(
        client.patchPet(customerId, petId, { version: 3, notes: 'x' }),
      ).resolves.toEqual({ kind: 'PET_VERSION_CONFLICT', currentVersion: 5 });
    });

    it('a PET_VERSION_CONFLICT without a usable currentVersion keeps it null', async () => {
      request.mockReturnValue(fail(409, 'PET_VERSION_CONFLICT'));
      await expect(
        client.patchPet(customerId, petId, { version: 3, notes: 'x' }),
      ).resolves.toEqual({
        kind: 'PET_VERSION_CONFLICT',
        currentVersion: null,
      });
    });

    it.each([
      [404, 'PET_NOT_FOUND'],
      [404, 'CUSTOMER_NOT_FOUND'],
      [422, 'PET_ARCHIVED'],
    ])('maps %i %s', async (status, code) => {
      request.mockReturnValue(fail(status, code));
      await expect(
        client.patchPet(customerId, petId, { version: 3, notes: 'x' }),
      ).resolves.toEqual({ kind: code });
    });

    it('maps 403 to FORBIDDEN', async () => {
      request.mockReturnValue(fail(403));
      await expect(
        client.patchPet(customerId, petId, { version: 3, notes: 'x' }),
      ).resolves.toEqual({ kind: 'FORBIDDEN' });
    });

    it('is single attempt (not keyed)', async () => {
      request.mockReturnValue(fail(502, 'Bad Gateway'));
      await expect(
        client.patchPet(customerId, petId, { version: 3, notes: 'x' }),
      ).rejects.toBeInstanceOf(UpstreamError);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'refuses version %p before any request',
      async (version) => {
        await expect(
          client.patchPet(customerId, petId, { version, notes: 'x' }),
        ).rejects.toBeInstanceOf(ChatbotApiError);
        expect(request).not.toHaveBeenCalled();
      },
    );
  });

  describe('archivePet', () => {
    it('POSTs {version, reason} to …/archive and returns the archived pet', async () => {
      request.mockReturnValue(of(ok({ ...archived, warnings: [] })));
      await expect(
        client.archivePet(customerId, petId, {
          version: 3,
          reason: 'Se fue con otra familia',
        }),
      ).resolves.toEqual({ kind: 'ok', pet: archived, warnings: [] });
      expect(sent()).toMatchObject({
        method: 'POST',
        url: `${base}/${petId}/archive`,
        data: { version: 3, reason: 'Se fue con otra familia' },
      });
      expect(sent().headers).toEqual(authHeaders);
    });

    it('omits reason when not given', async () => {
      request.mockReturnValue(of(ok({ ...archived, warnings: [] })));
      await client.archivePet(customerId, petId, { version: 3 });
      expect(sent().data).toEqual({ version: 3 });
      expect(Object.keys(sent().data as object)).toEqual(['version']);
    });

    it.each([
      [404, 'PET_NOT_FOUND'],
      [404, 'CUSTOMER_NOT_FOUND'],
      [422, 'PET_ARCHIVED'],
    ])('maps %i %s', async (status, code) => {
      request.mockReturnValue(fail(status, code));
      await expect(
        client.archivePet(customerId, petId, { version: 3 }),
      ).resolves.toEqual({ kind: code });
    });

    it('maps PET_VERSION_CONFLICT with currentVersion', async () => {
      request.mockReturnValue(
        fail(409, 'PET_VERSION_CONFLICT', { currentVersion: 4 }),
      );
      await expect(
        client.archivePet(customerId, petId, { version: 3 }),
      ).resolves.toEqual({ kind: 'PET_VERSION_CONFLICT', currentVersion: 4 });
    });

    it('maps 403 to FORBIDDEN', async () => {
      request.mockReturnValue(fail(403));
      await expect(
        client.archivePet(customerId, petId, { version: 3 }),
      ).resolves.toEqual({ kind: 'FORBIDDEN' });
    });
  });

  describe('restorePet', () => {
    it('POSTs {version} to …/restore and returns the active pet + warnings', async () => {
      request.mockReturnValue(
        of(ok({ ...pet, version: 5, warnings: ['PET_NAME_DUPLICATE'] })),
      );
      await expect(
        client.restorePet(customerId, petId, { version: 4 }),
      ).resolves.toEqual({
        kind: 'ok',
        pet: { ...pet, version: 5 },
        warnings: ['PET_NAME_DUPLICATE'],
      });
      expect(sent()).toMatchObject({
        method: 'POST',
        url: `${base}/${petId}/restore`,
      });
      expect(sent().data).toEqual({ version: 4 });
      expect(sent().headers).toEqual(authHeaders);
    });

    it.each([
      [404, 'PET_NOT_FOUND'],
      [404, 'CUSTOMER_NOT_FOUND'],
      [422, 'PET_NOT_ARCHIVED'],
      [422, 'PET_LIMIT_REACHED'],
    ])('maps %i %s', async (status, code) => {
      request.mockReturnValue(fail(status, code));
      await expect(
        client.restorePet(customerId, petId, { version: 4 }),
      ).resolves.toEqual({ kind: code });
    });

    it('maps PET_VERSION_CONFLICT with currentVersion', async () => {
      request.mockReturnValue(
        fail(409, 'PET_VERSION_CONFLICT', { currentVersion: 6 }),
      );
      await expect(
        client.restorePet(customerId, petId, { version: 4 }),
      ).resolves.toEqual({ kind: 'PET_VERSION_CONFLICT', currentVersion: 6 });
    });

    it('maps 403 to FORBIDDEN', async () => {
      request.mockReturnValue(fail(403));
      await expect(
        client.restorePet(customerId, petId, { version: 4 }),
      ).resolves.toEqual({ kind: 'FORBIDDEN' });
    });
  });

  describe('deletePet', () => {
    it('DELETEs with ?version=N, no body, and resolves on 204', async () => {
      request.mockReturnValue(of(ok('', 204)));
      await expect(client.deletePet(customerId, petId, 4)).resolves.toEqual({
        kind: 'ok',
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sent()).toMatchObject({
        method: 'DELETE',
        url: `${base}/${petId}`,
        params: { version: 4 },
      });
      expect(sent().data).toBeUndefined();
      expect(sent().headers).toEqual(authHeaders);
    });

    it('maps 409 PET_VERSION_CONFLICT with currentVersion', async () => {
      request.mockReturnValue(
        fail(409, 'PET_VERSION_CONFLICT', { currentVersion: 5 }),
      );
      await expect(client.deletePet(customerId, petId, 4)).resolves.toEqual({
        kind: 'PET_VERSION_CONFLICT',
        currentVersion: 5,
      });
    });

    it.each([
      [404, 'PET_NOT_FOUND'],
      [404, 'CUSTOMER_NOT_FOUND'],
    ])(
      'maps %i %s (PET_NOT_FOUND after a timeout = done, caller decides)',
      async (status, code) => {
        request.mockReturnValue(fail(status, code));
        await expect(client.deletePet(customerId, petId, 4)).resolves.toEqual({
          kind: code,
        });
      },
    );

    it('maps 403 (missing pets:delete) to FORBIDDEN', async () => {
      request.mockReturnValue(fail(403));
      await expect(client.deletePet(customerId, petId, 4)).resolves.toEqual({
        kind: 'FORBIDDEN',
      });
    });

    it('is single attempt', async () => {
      request.mockReturnValue(fail(503, 'Service Unavailable'));
      await expect(
        client.deletePet(customerId, petId, 4),
      ).rejects.toBeInstanceOf(UpstreamError);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects an unexpected 200 success status', async () => {
      request.mockReturnValue(of(ok({}, 200)));
      await expect(
        client.deletePet(customerId, petId, 4),
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it.each([0, -2, 2.5])(
      'refuses version %p before any request',
      async (version) => {
        await expect(
          client.deletePet(customerId, petId, version),
        ).rejects.toBeInstanceOf(ChatbotApiError);
        expect(request).not.toHaveBeenCalled();
      },
    );
  });

  it('encodes path ids', async () => {
    request.mockReturnValue(of(ok([])));
    await client.listPets('a/b');
    expect(sent().url).toBe('/chatbot-api/customers/a%2Fb/pets');
  });
});

import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import type { CreateHumanRequestInput } from '../domain/dtos/human-requests.dto';
import type {
  ListSlotsInput,
  RescheduleRequestInput,
} from '../domain/dtos/scheduling.dto';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const PHONE = '5215512345678';
const REF = `wa:${PHONE}`;
const ENCODED_REF = `wa%3A${PHONE}`;
const REQUEST = '9a7e0000-1111-4222-8333-444455556666';
const SOURCE = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
const KEY = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const LAST_MESSAGE_AT = '2026-11-10T02:10:00.000Z';
const SLOT_1 = '2026-11-10T15:00:00.000Z';
const SLOT_2 = '2026-11-10T15:30:00.000Z';
const SLOT_3 = '2026-11-10T16:00:00.000Z';
const WINDOW_CLOSES = '2026-11-11T02:10:00.000Z';
const ZONE = 'America/Mexico_City';

const response = (
  data: unknown,
  statusCode = 200,
  headers: Record<string, string> = {},
) => ({
  data,
  status: statusCode,
  statusText: '',
  headers,
  config: { headers: new AxiosHeaders() },
});
/** An axios-style failure whose message carries the ref (it must never leak). */
const httpError = (
  statusCode: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  throwError(() =>
    Object.assign(new Error(`HTTP ${statusCode} for ${REF} ${PHONE}`), {
      response: { status: statusCode, data: body, headers },
    }),
  );
const apiError = (statusCode: number, code: string, extra = {}) => ({
  statusCode,
  code,
  message: 'fixed text',
  ...extra,
});
const transportError = (code: string) =>
  throwError(() =>
    Object.assign(new Error(`${code} talking to ${REF} ${PHONE}`), { code }),
  );

const slotsBody = {
  timeZone: ZONE,
  whatsappWindowClosesAt: WINDOW_CLOSES,
  businessHours: {
    openNow: false,
    nextOpenAt: SLOT_1,
    timeZone: ZONE,
    weeklyRanges: [
      { day: 'MONDAY', ranges: [{ open: '09:00', close: '19:00' }] },
      { day: 'TUESDAY', ranges: [] },
    ],
    closedDates: ['2026-12-25'],
  },
  slots: [
    { startsAt: SLOT_1, withinWindow: true, available: true },
    { startsAt: SLOT_2, withinWindow: true, available: true },
    { startsAt: SLOT_3, withinWindow: false, available: true },
  ],
};
const parsedSlots = {
  kind: 'ok',
  timeZone: ZONE,
  whatsappWindowClosesAt: WINDOW_CLOSES,
  businessHours: {
    openNow: false,
    nextOpenAt: SLOT_1,
    timeZone: ZONE,
    weeklyRanges: [
      { day: 'MONDAY', ranges: [{ open: '09:00', close: '19:00' }] },
      { day: 'TUESDAY', ranges: [] },
    ],
    closedDates: ['2026-12-25'],
  },
  slots: [
    { startsAt: SLOT_1, withinWindow: true },
    { startsAt: SLOT_2, withinWindow: true },
    { startsAt: SLOT_3, withinWindow: false },
  ],
};

const bookInput: CreateHumanRequestInput = {
  sourceRequestId: SOURCE,
  subtype: 'TALK_TO_HUMAN',
  customer: { phoneCountryCode: '52', phone: '5512345678' },
  conversationRef: REF,
  lastCustomerMessageAt: LAST_MESSAGE_AT,
  summary: 'Quiere hablar con una persona',
  scheduledFor: SLOT_1,
};
const bookedAnswer = {
  id: REQUEST,
  folio: 'S-000123',
  status: 'NEW',
  outcome: 'CREATED',
  mergedIntoId: null,
  businessHours: { openNow: false, nextOpenAt: SLOT_1, timeZone: ZONE },
  scheduledFor: SLOT_1,
  scheduleVersion: 1,
  requiresTemplateAtStart: false,
  whatsappWindowClosesAt: WINDOW_CLOSES,
};
const slotUnavailableBody = apiError(409, 'SLOT_UNAVAILABLE', {
  slots: [
    { startsAt: SLOT_2, withinWindow: true, available: true },
    { startsAt: SLOT_3, withinWindow: false, available: true },
  ],
  timeZone: ZONE,
  whatsappWindowClosesAt: WINDOW_CLOSES,
});
const parsedSlotUnavailable = {
  kind: 'SLOT_UNAVAILABLE',
  slots: [
    { startsAt: SLOT_2, withinWindow: true },
    { startsAt: SLOT_3, withinWindow: false },
  ],
  timeZone: ZONE,
  whatsappWindowClosesAt: WINDOW_CLOSES,
};

describe('scheduling client (mocked HTTP)', () => {
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
  const sent = (i = 0) => request.mock.calls[i][0];
  /** Nothing the client resolves may carry the ref or the phone (S5). */
  const expectNoPhone = (result: unknown) => {
    const text = JSON.stringify(result);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(ENCODED_REF);
  };

  describe('listSlots', () => {
    const input = {
      conversationRef: REF,
      lastCustomerMessageAt: LAST_MESSAGE_AT,
    };

    it('GETs the slots route with both query params, auth headers and a bounded timeout', async () => {
      request.mockReturnValue(of(response(slotsBody)));
      await client.listSlots(input);
      expect(request).toHaveBeenCalledTimes(1);
      const config = sent();
      expect(config.method).toBe('GET');
      expect(config.url).toBe('/chatbot-api/scheduling/slots');
      expect(config.params).toEqual({
        conversationRef: REF,
        lastCustomerMessageAt: LAST_MESSAGE_AT,
      });
      expect(config.data).toBeUndefined();
      expect(config.baseURL).toBe('https://example.invalid');
      expect(config.timeout).toBe(10_000);
      expect(config.headers).toMatchObject({
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
      });
      expect(config.headers).not.toHaveProperty('X-Idempotency-Key');
    });

    it('parses the exact contract shape and drops extra keys', async () => {
      request.mockReturnValue(of(response({ ...slotsBody, extra: 'dropped' })));
      const result = await client.listSlots(input);
      expect(result).toEqual(parsedSlots);
      expectNoPhone(result);
    });

    it('reads an empty slot list as ok (no free time for 14 days)', async () => {
      request.mockReturnValue(of(response({ ...slotsBody, slots: [] })));
      await expect(client.listSlots(input)).resolves.toEqual({
        ...parsedSlots,
        slots: [],
      });
    });

    it('reads a null nextOpenAt and empty closedDates', async () => {
      request.mockReturnValue(
        of(
          response({
            ...slotsBody,
            businessHours: {
              ...slotsBody.businessHours,
              nextOpenAt: null,
              closedDates: [],
            },
          }),
        ),
      );
      const result = await client.listSlots(input);
      expect(result).toMatchObject({
        kind: 'ok',
        businessHours: { nextOpenAt: null, closedDates: [] },
      });
    });

    it('never offers a slot the backend marks unavailable', async () => {
      request.mockReturnValue(
        of(
          response({
            ...slotsBody,
            slots: [
              { startsAt: SLOT_1, withinWindow: true, available: false },
              { startsAt: SLOT_2, withinWindow: true, available: true },
            ],
          }),
        ),
      );
      await expect(client.listSlots(input)).resolves.toMatchObject({
        slots: [{ startsAt: SLOT_2, withinWindow: true }],
      });
    });

    it('maps 422 SCHEDULING_DISABLED to its own kind (the unit 11 fallback cue)', async () => {
      request.mockReturnValue(
        httpError(422, apiError(422, 'SCHEDULING_DISABLED')),
      );
      await expect(client.listSlots(input)).resolves.toEqual({
        kind: 'SCHEDULING_DISABLED',
      });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'a 400',
        httpError(400, apiError(400, 'VALIDATION_ERROR')),
        { kind: 'VALIDATION_ERROR', message: 'fixed text', local: false },
      ],
      ['a 401', httpError(401, {}), { kind: 'UNAUTHORIZED' }],
      [
        'a 403',
        httpError(403, apiError(403, 'INSUFFICIENT_SCOPE')),
        { kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' },
      ],
      [
        'a 429',
        httpError(429, apiError(429, 'RATE_LIMITED'), { 'retry-after': '3' }),
        { kind: 'RATE_LIMITED', retryAfterSeconds: 3 },
      ],
      [
        'a 503',
        httpError(503, {}, { 'retry-after': '7' }),
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 503,
          retryAfterSeconds: 7,
        },
      ],
      [
        'a timeout',
        transportError('ECONNABORTED'),
        {
          kind: 'RETRYABLE',
          cause: 'timeout',
          status: null,
          retryAfterSeconds: null,
        },
      ],
      [
        'a network error',
        transportError('ECONNRESET'),
        {
          kind: 'RETRYABLE',
          cause: 'network',
          status: null,
          retryAfterSeconds: null,
        },
      ],
      [
        'an undocumented 409',
        httpError(409, apiError(409, 'SOMETHING_NEW')),
        { kind: 'UNEXPECTED', status: 409, code: 'SOMETHING_NEW' },
      ],
    ])(
      'resolves %s as a typed failure, with one request and no phone',
      async (_label, reply, expected) => {
        request.mockReturnValue(reply);
        const result = await client.listSlots(input);
        expect(result).toEqual(expected);
        expect(request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expectNoPhone(result);
      },
    );

    it.each([
      ['a non-object body', 'oops'],
      ['no timeZone', { ...slotsBody, timeZone: undefined }],
      [
        'a slot without withinWindow',
        { ...slotsBody, slots: [{ startsAt: SLOT_1 }] },
      ],
      ['slots that are not a list', { ...slotsBody, slots: null }],
      [
        'businessHours without openNow',
        { ...slotsBody, businessHours: { timeZone: ZONE } },
      ],
      [
        'an unknown weekday',
        {
          ...slotsBody,
          businessHours: {
            ...slotsBody.businessHours,
            weeklyRanges: [{ day: 'FUNDAY', ranges: [] }],
          },
        },
      ],
      [
        'a range without close',
        {
          ...slotsBody,
          businessHours: {
            ...slotsBody.businessHours,
            weeklyRanges: [{ day: 'MONDAY', ranges: [{ open: '09:00' }] }],
          },
        },
      ],
      [
        'closedDates that are not strings',
        {
          ...slotsBody,
          businessHours: { ...slotsBody.businessHours, closedDates: [1] },
        },
      ],
    ])('fails closed on %s with UNEXPECTED', async (_label, body) => {
      request.mockReturnValue(of(response(body)));
      await expect(client.listSlots(input)).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 200,
        code: null,
      });
    });

    it('treats a non-200 success as UNEXPECTED', async () => {
      request.mockReturnValue(of(response(slotsBody, 204)));
      await expect(client.listSlots(input)).resolves.toMatchObject({
        kind: 'UNEXPECTED',
        status: 204,
      });
    });

    it.each([
      ['an empty conversationRef', { ...input, conversationRef: '' }],
      ['a conversationRef with spaces', { ...input, conversationRef: 'a b' }],
      ['a missing lastCustomerMessageAt', { conversationRef: REF }],
      [
        'a non-ISO lastCustomerMessageAt',
        { ...input, lastCustomerMessageAt: 'yesterday' },
      ],
    ])('rejects %s locally before any HTTP', async (_label, bad) => {
      const result = await client.listSlots(bad as ListSlotsInput);
      expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
      expectNoPhone(result);
    });
  });

  describe('createHumanRequest with scheduledFor (booking)', () => {
    it('sends scheduledFor on the wire with the idempotency key', async () => {
      request.mockReturnValue(of(response(bookedAnswer, 201)));
      await client.createHumanRequest(bookInput);
      expect(request).toHaveBeenCalledTimes(1);
      const config = sent();
      expect(config.url).toBe('/chatbot-api/requests');
      expect(config.data).toMatchObject({
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: SLOT_1,
      });
      expect(config.headers).toMatchObject({ 'X-Idempotency-Key': SOURCE });
    });

    it('parses the extended answer', async () => {
      request.mockReturnValue(of(response(bookedAnswer, 201)));
      await expect(client.createHumanRequest(bookInput)).resolves.toEqual({
        kind: 'ok',
        status: 201,
        response: bookedAnswer,
      });
    });

    it('parses a replayed booking and a template-at-start booking', async () => {
      const replay = {
        ...bookedAnswer,
        outcome: 'REPLAYED',
        requiresTemplateAtStart: true,
      };
      request.mockReturnValue(of(response(replay, 200)));
      await expect(client.createHumanRequest(bookInput)).resolves.toEqual({
        kind: 'ok',
        status: 200,
        response: replay,
      });
    });

    it('works unchanged without scheduledFor: no key on the wire, no scheduling fields', async () => {
      const plain = {
        id: REQUEST,
        folio: 'R-0001',
        status: 'NEW',
        outcome: 'CREATED',
        mergedIntoId: null,
        businessHours: null,
      };
      request.mockReturnValue(of(response(plain, 201)));
      const unscheduled: CreateHumanRequestInput = { ...bookInput };
      delete (unscheduled as { scheduledFor?: string | null }).scheduledFor;
      const result = await client.createHumanRequest(unscheduled);
      expect(result).toEqual({ kind: 'ok', status: 201, response: plain });
      expect(sent().data).not.toHaveProperty('scheduledFor');
      const parsed = (
        result as unknown as { response: Record<string, unknown> }
      ).response;
      expect(parsed).not.toHaveProperty('scheduledFor');
      expect(parsed).not.toHaveProperty('scheduleVersion');
    });

    it('treats scheduledFor: null as absent', async () => {
      request.mockReturnValue(of(response(bookedAnswer, 201)));
      await client.createHumanRequest({
        ...bookInput,
        scheduledFor: null,
      });
      expect(sent().data).not.toHaveProperty('scheduledFor');
    });

    it('maps 409 SLOT_UNAVAILABLE to a typed result with the fresh list', async () => {
      request.mockReturnValue(httpError(409, slotUnavailableBody));
      const result = await client.createHumanRequest(bookInput);
      expect(result).toEqual(parsedSlotUnavailable);
      expect(request).toHaveBeenCalledTimes(1);
      expectNoPhone(result);
    });

    it('maps a SLOT_UNAVAILABLE with an empty list (nothing free) as typed', async () => {
      request.mockReturnValue(
        httpError(409, { ...slotUnavailableBody, slots: [] }),
      );
      await expect(client.createHumanRequest(bookInput)).resolves.toEqual({
        ...parsedSlotUnavailable,
        slots: [],
      });
    });

    it('maps 409 ALREADY_SCHEDULED to a typed result', async () => {
      request.mockReturnValue(
        httpError(
          409,
          apiError(409, 'ALREADY_SCHEDULED', {
            requestId: REQUEST,
            scheduledFor: SLOT_2,
          }),
        ),
      );
      const result = await client.createHumanRequest(bookInput);
      expect(result).toEqual({
        kind: 'ALREADY_SCHEDULED',
        requestId: REQUEST,
        scheduledFor: SLOT_2,
      });
      expectNoPhone(result);
    });

    it('keeps mapping 422 SCHEDULING_DISABLED', async () => {
      request.mockReturnValue(
        httpError(422, apiError(422, 'SCHEDULING_DISABLED')),
      );
      await expect(client.createHumanRequest(bookInput)).resolves.toEqual({
        kind: 'SCHEDULING_DISABLED',
      });
    });

    it('still throws when a 409 body breaks the contract (same style as the other create errors)', async () => {
      request.mockReturnValueOnce(
        httpError(409, apiError(409, 'SLOT_UNAVAILABLE', { slots: 'nope' })),
      );
      await expect(client.createHumanRequest(bookInput)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'SLOT_UNAVAILABLE',
      });
      request.mockReturnValueOnce(
        httpError(409, apiError(409, 'ALREADY_SCHEDULED', {})),
      );
      await expect(client.createHumanRequest(bookInput)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'ALREADY_SCHEDULED',
      });
    });

    it('rejects a malformed scheduled answer as UpstreamError', async () => {
      request.mockReturnValue(
        of(response({ ...bookedAnswer, scheduleVersion: 'one' }, 201)),
      );
      await expect(client.createHumanRequest(bookInput)).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });

    it('rejects a non-string scheduledFor locally before any HTTP', async () => {
      await expect(
        client.createHumanRequest({
          ...bookInput,
          scheduledFor: 12345,
        } as unknown as CreateHumanRequestInput),
      ).rejects.toBeInstanceOf(ChatbotApiError);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('rescheduleRequest', () => {
    const body = { scheduledFor: SLOT_2 };
    const okBody = {
      id: REQUEST,
      status: 'NEW',
      outcome: 'RESCHEDULED',
      scheduledFor: SLOT_2,
      previousScheduledFor: SLOT_1,
      scheduleVersion: 2,
      requiresTemplateAtStart: false,
      whatsappWindowClosesAt: WINDOW_CLOSES,
    };

    it('POSTs exactly the contract keys to the encoded id with X-Idempotency-Key', async () => {
      request.mockReturnValue(of(response(okBody)));
      await client.rescheduleRequest(
        REQUEST,
        {
          scheduledFor: SLOT_2,
          lastCustomerMessageAt: LAST_MESSAGE_AT,
          triggerWaMessageId: 'wamid.1',
        },
        KEY,
      );
      expect(request).toHaveBeenCalledTimes(1);
      const config = sent();
      expect(config.method).toBe('POST');
      expect(config.url).toBe(`/chatbot-api/requests/${REQUEST}/reschedule`);
      expect(Object.keys(config.data as object)).toEqual([
        'scheduledFor',
        'lastCustomerMessageAt',
        'triggerWaMessageId',
      ]);
      expect(config.data).toEqual({
        scheduledFor: SLOT_2,
        lastCustomerMessageAt: LAST_MESSAGE_AT,
        triggerWaMessageId: 'wamid.1',
      });
      expect(config.timeout).toBe(10_000);
      expect(config.headers).toMatchObject({
        'X-Idempotency-Key': KEY,
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
      });
    });

    it('omits the optional keys it was not given and drops unknown input keys', async () => {
      request.mockReturnValue(of(response(okBody)));
      await client.rescheduleRequest(
        REQUEST,
        { ...body, bogus: 1 } as RescheduleRequestInput,
        KEY,
      );
      expect(sent().data).toEqual({ scheduledFor: SLOT_2 });
    });

    it('URL-encodes the request id', async () => {
      request.mockReturnValue(of(response({ ...okBody, id: 'a/b' })));
      await client.rescheduleRequest('a/b', body, KEY);
      expect(sent().url).toBe('/chatbot-api/requests/a%2Fb/reschedule');
    });

    it('parses RESCHEDULED', async () => {
      request.mockReturnValue(of(response({ ...okBody, extra: 'dropped' })));
      await expect(
        client.rescheduleRequest(REQUEST, body, KEY),
      ).resolves.toEqual({
        kind: 'ok',
        status: 'RESCHEDULED',
        requestId: REQUEST,
        scheduledFor: SLOT_2,
        previousScheduledFor: SLOT_1,
        scheduleVersion: 2,
        requiresTemplateAtStart: false,
        whatsappWindowClosesAt: WINDOW_CLOSES,
      });
    });

    it('parses UNCHANGED, which carries no previous time', async () => {
      request.mockReturnValue(
        of(
          response({
            id: REQUEST,
            status: 'NEW',
            outcome: 'UNCHANGED',
            scheduledFor: SLOT_2,
            scheduleVersion: 2,
          }),
        ),
      );
      await expect(
        client.rescheduleRequest(REQUEST, body, KEY),
      ).resolves.toEqual({
        kind: 'ok',
        status: 'UNCHANGED',
        requestId: REQUEST,
        scheduledFor: SLOT_2,
        previousScheduledFor: null,
        scheduleVersion: 2,
        requiresTemplateAtStart: null,
        whatsappWindowClosesAt: null,
      });
    });

    it('maps 409 SLOT_UNAVAILABLE with the fresh list', async () => {
      request.mockReturnValue(httpError(409, slotUnavailableBody));
      const result = await client.rescheduleRequest(REQUEST, body, KEY);
      expect(result).toEqual(parsedSlotUnavailable);
      expect(request).toHaveBeenCalledTimes(1);
      expectNoPhone(result);
    });

    it.each([
      [409, 'REQUEST_CLOSED'],
      [409, 'NOT_SCHEDULED'],
      [409, 'RESCHEDULE_NOT_ALLOWED'],
      [409, 'IDEMPOTENCY_CONFLICT'],
      [422, 'SCHEDULING_DISABLED'],
    ])('maps %i %s to its own kind', async (status, code) => {
      request.mockReturnValue(httpError(status, apiError(status, code)));
      await expect(
        client.rescheduleRequest(REQUEST, body, KEY),
      ).resolves.toEqual({ kind: code });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('maps 404 to NOT_FOUND', async () => {
      request.mockReturnValue(httpError(404, apiError(404, 'NOT_FOUND')));
      await expect(
        client.rescheduleRequest(REQUEST, body, KEY),
      ).resolves.toEqual({ kind: 'NOT_FOUND' });
    });

    it.each([
      [
        'a 400',
        httpError(400, apiError(400, 'VALIDATION_ERROR')),
        { kind: 'VALIDATION_ERROR', message: 'fixed text', local: false },
      ],
      ['a 401', httpError(401, {}), { kind: 'UNAUTHORIZED' }],
      [
        'a 403',
        httpError(403, apiError(403, 'INSUFFICIENT_SCOPE')),
        { kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' },
      ],
      [
        'a 429',
        httpError(429, apiError(429, 'RATE_LIMITED'), { 'retry-after': '2' }),
        { kind: 'RATE_LIMITED', retryAfterSeconds: 2 },
      ],
      [
        'a 500',
        httpError(500, {}),
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 500,
          retryAfterSeconds: null,
        },
      ],
      [
        'a timeout',
        transportError('ETIMEDOUT'),
        {
          kind: 'RETRYABLE',
          cause: 'timeout',
          status: null,
          retryAfterSeconds: null,
        },
      ],
      [
        'a network error',
        transportError('ECONNREFUSED'),
        {
          kind: 'RETRYABLE',
          cause: 'network',
          status: null,
          retryAfterSeconds: null,
        },
      ],
      [
        'an undocumented 409 code',
        httpError(409, apiError(409, 'SOMETHING_NEW')),
        { kind: 'UNEXPECTED', status: 409, code: 'SOMETHING_NEW' },
      ],
    ])(
      'resolves %s as a typed failure, one request, no retry, no phone',
      async (_label, reply, expected) => {
        request.mockReturnValue(reply);
        const result = await client.rescheduleRequest(REQUEST, body, KEY);
        expect(result).toEqual(expected);
        expect(request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expectNoPhone(result);
      },
    );

    it('treats a SLOT_UNAVAILABLE body that breaks the contract as UNEXPECTED', async () => {
      request.mockReturnValue(
        httpError(409, apiError(409, 'SLOT_UNAVAILABLE', { slots: 'nope' })),
      );
      await expect(
        client.rescheduleRequest(REQUEST, body, KEY),
      ).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 409,
        code: 'SLOT_UNAVAILABLE',
      });
    });

    it.each([
      ['a body for another request', { ...okBody, id: 'other' }],
      ['an unknown outcome', { ...okBody, outcome: 'MAYBE' }],
      ['a missing scheduledFor', { ...okBody, scheduledFor: undefined }],
      ['a non-integer scheduleVersion', { ...okBody, scheduleVersion: 1.5 }],
      ['a non-object body', 'oops'],
    ])('fails closed on %s with UNEXPECTED', async (_label, bad) => {
      request.mockReturnValue(of(response(bad)));
      await expect(
        client.rescheduleRequest(REQUEST, body, KEY),
      ).resolves.toEqual({ kind: 'UNEXPECTED', status: 200, code: null });
    });

    it.each([
      ['an empty request id', ['', body, KEY]],
      ['an empty idempotency key', [REQUEST, body, '']],
      ['a non-UUID idempotency key', [REQUEST, body, 'not-a-uuid']],
      ['a missing scheduledFor', [REQUEST, {}, KEY]],
      ['a non-ISO scheduledFor', [REQUEST, { scheduledFor: 'soon' }, KEY]],
      [
        'a non-ISO lastCustomerMessageAt',
        [REQUEST, { ...body, lastCustomerMessageAt: 'x' }, KEY],
      ],
      [
        'an empty triggerWaMessageId',
        [REQUEST, { ...body, triggerWaMessageId: '' }, KEY],
      ],
    ])('rejects %s locally before any HTTP', async (_label, args) => {
      const result = await client.rescheduleRequest(
        ...(args as [string, { scheduledFor: string }, string]),
      );
      expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
    });
  });
});

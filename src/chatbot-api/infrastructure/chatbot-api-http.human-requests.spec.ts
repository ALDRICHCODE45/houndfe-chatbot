import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import {
  ChatbotApiError,
  ForbiddenError,
  UpstreamError,
} from '../domain/errors';
import type {
  CreateHumanRequestInput,
  DeliveryOutcomeInput,
} from '../domain/dtos/human-requests.dto';
import {
  FEED_TIMEOUT_SLACK_MS,
  ChatbotApiHttpClient,
} from './chatbot-api-http.client';

const SOURCE = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
const REQUEST = '9a7e0000-1111-4222-8333-444455556666';
const DELIVERY = 'b1c00000-1111-4222-8333-444455556666';
const ATTEMPT = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const AT = '2026-11-10T16:20:00.000Z';

const createInput: CreateHumanRequestInput = {
  sourceRequestId: SOURCE,
  subtype: 'UNKNOWN_QUESTION',
  customer: {
    phoneCountryCode: '52',
    phone: '5512345678',
    displayName: 'Juan',
  },
  conversationRef: 'wa:5215512345678',
  lastCustomerMessageAt: '2026-11-10T16:02:11.000Z',
  summary: '¿El shampoo X sirve para cachorros?',
  dedupKey: 'UNKNOWN_QUESTION:abc',
  triggerWaMessageId: 'wamid.1',
};
const created = {
  id: REQUEST,
  folio: 'R-0001',
  status: 'NEW',
  outcome: 'CREATED',
  mergedIntoId: null,
  businessHours: null,
};

const answeredItem = {
  cursor: '000000001842',
  deliveryId: DELIVERY,
  type: 'request.answered',
  requestId: REQUEST,
  conversationRef: 'wa:5215512345678',
  payload: {
    kind: 'DECISION',
    subtype: 'RESTOCK',
    action: 'PROVIDE_RESTOCK_ESTIMATE',
    legacyId: SOURCE,
    text: 'El producto «Croquetas 20 kg» estará disponible en aproximadamente 7 días.',
    prefix: null,
    productName: 'Croquetas 20 kg',
    restockDays: 7,
  },
  notBefore: null,
  expiresAt: null,
};

const response = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
const httpError = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) => throwError(() => ({ response: { status, data, headers } }));

describe('human requests, feed and delivery outcome (mocked HTTP)', () => {
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

  const sent = (i = 0) => request.mock.calls[i][0];

  describe('createHumanRequest', () => {
    it('posts once with X-Idempotency-Key = sourceRequestId and resolves a 201', async () => {
      request.mockReturnValue(of(response(created, 201)));
      await expect(client.createHumanRequest(createInput)).resolves.toEqual({
        kind: 'ok',
        status: 201,
        response: created,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sent()).toEqual(
        expect.objectContaining({
          method: 'POST',
          url: '/chatbot-api/requests',
          data: createInput,
          headers: {
            'X-Idempotency-Key': SOURCE,
            Authorization: 'Bearer svc_test',
            'X-Branch-Id': 'branch',
          },
        }),
      );
    });

    it('resolves a 200 merge with mergedIntoId and the legacy answer', async () => {
      const merged = {
        ...created,
        outcome: 'MERGED',
        mergedIntoId: SOURCE,
        businessHours: { openNow: false, nextOpenAt: AT },
        legacy: { id: SOURCE, status: 'PENDING' },
      };
      request.mockReturnValue(of(response(merged, 200)));
      await expect(client.createHumanRequest(createInput)).resolves.toEqual({
        kind: 'ok',
        status: 200,
        response: merged,
      });
    });

    it('accepts an already approved DELIVERY_ZONE (id null, RESOLVED)', async () => {
      const resolved = {
        ...created,
        id: null,
        folio: null,
        status: 'RESOLVED',
        outcome: 'REPLAYED',
        legacy: { id: SOURCE },
      };
      request.mockReturnValue(of(response(resolved, 200)));
      await expect(client.createHumanRequest(createInput)).resolves.toEqual({
        kind: 'ok',
        status: 200,
        response: resolved,
      });
    });

    it('rejects a malformed success body as UpstreamError', async () => {
      request.mockReturnValue(
        of(response({ ...created, outcome: 'MAYBE' }, 201)),
      );
      await expect(
        client.createHumanRequest(createInput),
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it('rejects a local input without sourceRequestId before any HTTP', async () => {
      await expect(
        client.createHumanRequest({ ...createInput, sourceRequestId: '' }),
      ).rejects.toBeInstanceOf(ChatbotApiError);
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      [
        httpError(409, {
          statusCode: 409,
          code: 'CUSTOMER_OPEN_LIMIT',
          limit: 20,
          open: 20,
        }),
        { kind: 'CUSTOMER_OPEN_LIMIT', limit: 20, open: 20 },
      ],
      [
        httpError(
          429,
          { statusCode: 429, code: 'CUSTOMER_RATE_LIMITED', limit: 10 },
          { 'retry-after': '1800' },
        ),
        { kind: 'CUSTOMER_RATE_LIMITED', limit: 10, retryAfterSeconds: 1800 },
      ],
      [
        httpError(
          429,
          { statusCode: 429, code: 'RATE_LIMITED' },
          { 'retry-after': '3' },
        ),
        { kind: 'RATE_LIMITED', retryAfterSeconds: 3 },
      ],
      [
        httpError(409, { code: 'IDEMPOTENCY_CONFLICT' }),
        { kind: 'IDEMPOTENCY_CONFLICT' },
      ],
      [
        httpError(422, { code: 'SUBTYPE_DISABLED' }),
        { kind: 'SUBTYPE_DISABLED' },
      ],
      [
        httpError(422, { code: 'SCHEDULING_DISABLED' }),
        { kind: 'SCHEDULING_DISABLED' },
      ],
      [
        httpError(409, { code: 'VERSION_CONFLICT' }),
        { kind: 'VERSION_CONFLICT' },
      ],
      [
        httpError(400, {
          code: 'VALIDATION_ERROR',
          message: 'summary too long',
        }),
        { kind: 'VALIDATION_ERROR', message: 'summary too long' },
      ],
      [
        httpError(404, { code: 'NOT_FOUND', message: 'x' }),
        { kind: 'NOT_FOUND' },
      ],
    ])(
      'maps a documented error to a typed result (%#) without retry',
      async (reply, expected) => {
        request.mockReturnValue(reply);
        await expect(client.createHumanRequest(createInput)).resolves.toEqual(
          expected,
        );
        expect(request).toHaveBeenCalledTimes(1);
      },
    );

    it('still throws transport errors (403, 5xx, unknown 409 code)', async () => {
      request.mockReturnValueOnce(
        httpError(403, { code: 'INSUFFICIENT_SCOPE' }),
      );
      await expect(
        client.createHumanRequest(createInput),
      ).rejects.toBeInstanceOf(ForbiddenError);
      request.mockReturnValueOnce(httpError(503, {}));
      await expect(
        client.createHumanRequest(createInput),
      ).rejects.toBeInstanceOf(UpstreamError);
      request.mockReturnValueOnce(httpError(409, { code: 'SOMETHING_NEW' }));
      await expect(
        client.createHumanRequest(createInput),
      ).rejects.toMatchObject({ statusCode: 409, errorCode: 'SOMETHING_NEW' });
      expect(request).toHaveBeenCalledTimes(3);
    });
  });

  describe('cancelHumanRequest', () => {
    const body = {
      reason: 'CUSTOMER_WITHDREW' as const,
      triggerWaMessageId: 'wamid.2',
    };
    const key = '11111111-1111-4111-8111-111111111111';

    it('posts the exact body with the given key and resolves 200', async () => {
      const ok = {
        id: REQUEST,
        status: 'CANCELLED',
        reason: 'CUSTOMER_WITHDREW',
        cancelledAt: AT,
      };
      request.mockReturnValue(of(response(ok)));
      await expect(
        client.cancelHumanRequest(REQUEST, body, key),
      ).resolves.toEqual({
        kind: 'ok',
        response: ok,
      });
      expect(sent()).toEqual(
        expect.objectContaining({
          method: 'POST',
          url: `/chatbot-api/requests/${REQUEST}/cancel`,
          data: body,
        }),
      );
      expect(sent().headers).toMatchObject({ 'X-Idempotency-Key': key });
    });

    it('rejects a 200 bound to another request', async () => {
      request.mockReturnValue(
        of(
          response({
            id: SOURCE,
            status: 'CANCELLED',
            reason: 'CUSTOMER_WITHDREW',
            cancelledAt: AT,
          }),
        ),
      );
      await expect(
        client.cancelHumanRequest(REQUEST, body, key),
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it.each([
      [
        httpError(409, {
          code: 'ALREADY_RESOLVED',
          resolution: { text: 'Sí hay' },
        }),
        { kind: 'ALREADY_RESOLVED', resolution: { text: 'Sí hay' } },
      ],
      [httpError(409, { code: 'REQUEST_CLOSED' }), { kind: 'REQUEST_CLOSED' }],
      [
        httpError(409, { code: 'CANCEL_NOT_ALLOWED' }),
        { kind: 'CANCEL_NOT_ALLOWED' },
      ],
      [httpError(404, { message: 'Request not found' }), { kind: 'NOT_FOUND' }],
      [
        httpError(409, { code: 'IDEMPOTENCY_CONFLICT' }),
        { kind: 'IDEMPOTENCY_CONFLICT' },
      ],
      [
        httpError(429, { code: 'RATE_LIMITED' }, { 'retry-after': '2' }),
        { kind: 'RATE_LIMITED', retryAfterSeconds: 2 },
      ],
    ])(
      'maps a documented error to a typed result (%#)',
      async (reply, expected) => {
        request.mockReturnValue(reply);
        await expect(
          client.cancelHumanRequest(REQUEST, body, key),
        ).resolves.toEqual(expected);
      },
    );

    it('rejects an empty id or key before any HTTP', async () => {
      await expect(
        client.cancelHumanRequest('', body, key),
      ).rejects.toBeInstanceOf(ChatbotApiError);
      await expect(
        client.cancelHumanRequest(REQUEST, body, ''),
      ).rejects.toBeInstanceOf(ChatbotApiError);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('readFeed', () => {
    it('sends after/limit/waitSeconds with a timeout above the long-poll wait and no retry', async () => {
      request.mockReturnValue(
        of(response({ items: [answeredItem], nextCursor: '000000001842' })),
      );
      const result = await client.readFeed({
        after: '000000001841',
        limit: 50,
        waitSeconds: 25,
      });
      expect(result).toEqual({
        kind: 'ok',
        nextCursor: '000000001842',
        items: [
          {
            type: 'request.answered',
            cursor: '000000001842',
            deliveryId: DELIVERY,
            requestId: REQUEST,
            conversationRef: 'wa:5215512345678',
            notBefore: null,
            expiresAt: null,
            payload: {
              kind: 'DECISION',
              subtype: 'RESTOCK',
              action: 'PROVIDE_RESTOCK_ESTIMATE',
              legacyId: SOURCE,
              text: answeredItem.payload.text,
              prefix: null,
              productName: 'Croquetas 20 kg',
              restockDays: 7,
            },
          },
        ],
      });
      expect(sent()).toEqual(
        expect.objectContaining({
          method: 'GET',
          url: '/chatbot-api/feed',
          params: { after: '000000001841', limit: 50, waitSeconds: 25 },
          timeout: 25_000 + FEED_TIMEOUT_SLACK_MS,
        }),
      );
      expect(FEED_TIMEOUT_SLACK_MS).toBe(10_000);
    });

    it('defaults to limit 50 / waitSeconds 25 and omits after', async () => {
      request.mockReturnValue(of(response({ items: [], nextCursor: '' })));
      await expect(client.readFeed()).resolves.toEqual({
        kind: 'ok',
        items: [],
        nextCursor: '',
      });
      expect(sent().params).toEqual({ limit: 50, waitSeconds: 25 });
      expect(sent().timeout).toBe(35_000);
    });

    it('uses waitSeconds 0 with a 10 s timeout', async () => {
      request.mockReturnValue(of(response({ items: [], nextCursor: 'c' })));
      await client.readFeed({ after: 'c', waitSeconds: 0 });
      expect(sent().timeout).toBe(10_000);
    });

    it('never retries a failed long-poll', async () => {
      request.mockReturnValue(
        throwError(() =>
          Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
        ),
      );
      await expect(client.readFeed({ after: 'c' })).rejects.toBeInstanceOf(
        UpstreamError,
      );
      request.mockReturnValue(httpError(502, {}));
      await expect(client.readFeed({ after: 'c' })).rejects.toBeInstanceOf(
        UpstreamError,
      );
      expect(request).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });

    it.each([
      [{ limit: 0 }],
      [{ limit: 51 }],
      [{ limit: 1.5 }],
      [{ waitSeconds: -1 }],
      [{ waitSeconds: 26 }],
      [{ after: '' }],
    ])(
      'rejects out-of-range options %j before any HTTP (never clamps)',
      async (options) => {
        await expect(client.readFeed(options)).rejects.toBeInstanceOf(
          ChatbotApiError,
        );
        expect(request).not.toHaveBeenCalled();
      },
    );

    it('maps 410 CURSOR_EXPIRED and 429 RATE_LIMITED to typed results', async () => {
      request.mockReturnValueOnce(httpError(410, { code: 'CURSOR_EXPIRED' }));
      await expect(client.readFeed({ after: 'old' })).resolves.toEqual({
        kind: 'CURSOR_EXPIRED',
      });
      request.mockReturnValueOnce(
        httpError(429, { code: 'RATE_LIMITED' }, { 'retry-after': '1' }),
      );
      await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 1,
      });
    });

    it('surfaces an unknown item type as "unknown" carrying the raw item', async () => {
      const raw = {
        cursor: '000000001843',
        deliveryId: 'd2',
        type: 'conversation.staff_message',
        requestId: REQUEST,
        payload: { handoffEpoch: 3, seq: 17, messageId: 'm', text: 'hola' },
      };
      request.mockReturnValue(
        of(response({ items: [raw], nextCursor: '000000001843' })),
      );
      await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
        kind: 'ok',
        nextCursor: '000000001843',
        items: [
          {
            type: 'unknown',
            rawType: 'conversation.staff_message',
            cursor: '000000001843',
            deliveryId: 'd2',
            raw,
          },
        ],
      });
    });

    it.each([
      ['intoRequestId in the payload', { payload: { intoRequestId: 'req-b' } }],
      ['intoRequestId at the top level', { intoRequestId: 'req-b' }],
    ])('parses request.merged with %s', async (_label, shape) => {
      const raw = {
        cursor: '000000001844',
        deliveryId: 'd3',
        type: 'request.merged',
        requestId: 'req-a',
        conversationRef: 'wa:5215550001111',
        ...shape,
      };
      request.mockReturnValue(
        of(response({ items: [raw], nextCursor: '000000001844' })),
      );
      await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
        kind: 'ok',
        nextCursor: '000000001844',
        items: [
          {
            type: 'request.merged',
            cursor: '000000001844',
            deliveryId: 'd3',
            requestId: 'req-a',
            conversationRef: 'wa:5215550001111',
            notBefore: null,
            expiresAt: null,
            payload: { intoRequestId: 'req-b' },
          },
        ],
      });
    });

    it('parses request.merged with requestId only in the payload', async () => {
      const raw = {
        cursor: '000000001846',
        deliveryId: 'd5',
        type: 'request.merged',
        payload: { requestId: 'req-a', intoRequestId: 'req-b' },
      };
      request.mockReturnValue(
        of(response({ items: [raw], nextCursor: '000000001846' })),
      );
      await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
        kind: 'ok',
        nextCursor: '000000001846',
        items: [
          {
            type: 'request.merged',
            cursor: '000000001846',
            deliveryId: 'd5',
            requestId: 'req-a',
            conversationRef: null,
            notBefore: null,
            expiresAt: null,
            payload: { intoRequestId: 'req-b' },
          },
        ],
      });
    });

    it('request.merged: the top-level requestId wins over the payload one', async () => {
      const raw = {
        cursor: '000000001847',
        deliveryId: 'd6',
        type: 'request.merged',
        requestId: 'req-top',
        payload: { requestId: 'req-payload', intoRequestId: 'req-b' },
      };
      request.mockReturnValue(
        of(response({ items: [raw], nextCursor: '000000001847' })),
      );
      await expect(client.readFeed({ after: 'c' })).resolves.toMatchObject({
        kind: 'ok',
        items: [{ type: 'request.merged', requestId: 'req-top' }],
      });
    });

    it('request.merged: an invalid payload intoRequestId yields to a valid top-level one', async () => {
      const raw = {
        cursor: '000000001848',
        deliveryId: 'd7',
        type: 'request.merged',
        requestId: 'req-a',
        intoRequestId: 'req-top-b',
        payload: { intoRequestId: 42 },
      };
      request.mockReturnValue(
        of(response({ items: [raw], nextCursor: '000000001848' })),
      );
      await expect(client.readFeed({ after: 'c' })).resolves.toMatchObject({
        kind: 'ok',
        items: [
          {
            type: 'request.merged',
            requestId: 'req-a',
            payload: { intoRequestId: 'req-top-b' },
          },
        ],
      });
    });

    it.each([
      ['no intoRequestId anywhere', { requestId: 'req-a' }],
      [
        'payload not an object',
        { requestId: 'req-a', intoRequestId: 'req-b', payload: 'x' },
      ],
      [
        'numeric conversationRef',
        { requestId: 'req-a', intoRequestId: 'req-b', conversationRef: 5 },
      ],
      [
        'numeric notBefore',
        { requestId: 'req-a', intoRequestId: 'req-b', notBefore: 5 },
      ],
      [
        'numeric expiresAt',
        { requestId: 'req-a', intoRequestId: 'req-b', expiresAt: 5 },
      ],
    ])(
      'surfaces a request.merged with %s as "unknown" without rejecting the page',
      async (_label, shape) => {
        const raw = {
          cursor: '000000001849',
          deliveryId: 'd8',
          type: 'request.merged',
          ...shape,
        };
        request.mockReturnValue(
          of(response({ items: [raw], nextCursor: '000000001849' })),
        );
        await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
          kind: 'ok',
          nextCursor: '000000001849',
          items: [
            {
              type: 'unknown',
              rawType: 'request.merged',
              cursor: '000000001849',
              deliveryId: 'd8',
              raw,
            },
          ],
        });
      },
    );

    it('surfaces a malformed request.merged as "unknown" instead of rejecting the page', async () => {
      const raw = {
        cursor: '000000001845',
        deliveryId: 'd4',
        type: 'request.merged',
        payload: { intoRequestId: 'req-b' },
      };
      request.mockReturnValue(
        of(response({ items: [raw], nextCursor: '000000001845' })),
      );
      await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
        kind: 'ok',
        nextCursor: '000000001845',
        items: [
          {
            type: 'unknown',
            rawType: 'request.merged',
            cursor: '000000001845',
            deliveryId: 'd4',
            raw,
          },
        ],
      });
    });

    it.each([
      ['missing deliveryId', { ...answeredItem, deliveryId: undefined }],
      ['numeric cursor', { ...answeredItem, cursor: 1842 }],
      ['missing notBefore', { ...answeredItem, notBefore: undefined }],
      ['payload not an object', { ...answeredItem, payload: 'x' }],
      [
        'known subtype with a malformed field',
        {
          ...answeredItem,
          payload: { ...answeredItem.payload, restockDays: 'siete' },
        },
      ],
    ])(
      'rejects a page with a malformed item (%s) as UpstreamError',
      async (_name, item) => {
        request.mockReturnValue(
          of(response({ items: [item], nextCursor: 'c' })),
        );
        await expect(client.readFeed({ after: 'c' })).rejects.toBeInstanceOf(
          UpstreamError,
        );
      },
    );

    it('rejects a page without nextCursor', async () => {
      request.mockReturnValue(of(response({ items: [] })));
      await expect(client.readFeed({ after: 'c' })).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });
  });

  describe('recordDeliveryOutcome', () => {
    const ack = (outcome: string, ackReceivedAt: string | null = AT) => ({
      deliveryId: DELIVERY,
      outcome,
      attemptId: ATTEMPT,
      ackReceivedAt,
    });

    it.each<[DeliveryOutcomeInput, string | null]>([
      [
        {
          outcome: 'PROVIDER_ACCEPTED',
          attemptId: ATTEMPT,
          providerMessageId: 'wamid.HBg',
          attemptedAt: AT,
        },
        AT,
      ],
      [
        { outcome: 'DELIVERY_UNKNOWN', attemptId: ATTEMPT, attemptedAt: AT },
        AT,
      ],
      [
        {
          outcome: 'DELIVERY_UNKNOWN',
          attemptId: ATTEMPT,
          attemptedAt: AT,
          providerMessageId: 'wamid.X',
        },
        AT,
      ],
      [
        {
          outcome: 'DEFERRED_WINDOW_CLOSED',
          attemptId: ATTEMPT,
          attemptedAt: AT,
        },
        null,
      ],
      [
        {
          outcome: 'DEFERRED_HUMAN_SESSION',
          attemptId: ATTEMPT,
          attemptedAt: AT,
        },
        null,
      ],
      [{ outcome: 'STALE', attemptId: ATTEMPT }, AT],
      [{ outcome: 'STALE', attemptId: ATTEMPT, attemptedAt: AT }, AT],
    ])(
      'posts exactly the variant keys once (%j)',
      async (input, ackReceivedAt) => {
        request.mockReturnValue(
          of(response(ack(input.outcome, ackReceivedAt))),
        );
        await expect(
          client.recordDeliveryOutcome(DELIVERY, input),
        ).resolves.toEqual({
          kind: 'ok',
          response: ack(input.outcome, ackReceivedAt),
        });
        expect(request).toHaveBeenCalledTimes(1);
        expect(sent()).toEqual(
          expect.objectContaining({
            method: 'POST',
            url: `/chatbot-api/deliveries/${DELIVERY}/outcome`,
            data: input,
          }),
        );
        expect(Object.keys(sent().data as object).sort()).toEqual(
          Object.keys(input).sort(),
        );
      },
    );

    it.each([
      [
        'uppercase attemptId',
        { outcome: 'STALE', attemptId: ATTEMPT.toUpperCase() },
      ],
      ['non-UUID attemptId', { outcome: 'STALE', attemptId: 'abc' }],
      [
        'non-canonical attemptedAt',
        {
          outcome: 'DELIVERY_UNKNOWN',
          attemptId: ATTEMPT,
          attemptedAt: '2026-11-10T16:20:00Z',
        },
      ],
      [
        'offset attemptedAt',
        {
          outcome: 'DELIVERY_UNKNOWN',
          attemptId: ATTEMPT,
          attemptedAt: '2026-11-10T16:20:00.000+01:00',
        },
      ],
      [
        'impossible date',
        {
          outcome: 'DELIVERY_UNKNOWN',
          attemptId: ATTEMPT,
          attemptedAt: '2026-02-30T16:20:00.000Z',
        },
      ],
      [
        'accepted without providerMessageId',
        { outcome: 'PROVIDER_ACCEPTED', attemptId: ATTEMPT, attemptedAt: AT },
      ],
      [
        'blank providerMessageId',
        {
          outcome: 'PROVIDER_ACCEPTED',
          attemptId: ATTEMPT,
          attemptedAt: AT,
          providerMessageId: '  ',
        },
      ],
      [
        'control chars in providerMessageId',
        {
          outcome: 'PROVIDER_ACCEPTED',
          attemptId: ATTEMPT,
          attemptedAt: AT,
          providerMessageId: 'wamid\n1',
        },
      ],
      [
        'deferral with providerMessageId',
        {
          outcome: 'DEFERRED_WINDOW_CLOSED',
          attemptId: ATTEMPT,
          attemptedAt: AT,
          providerMessageId: 'w',
        },
      ],
      [
        'deferral without attemptedAt',
        { outcome: 'DEFERRED_WINDOW_CLOSED', attemptId: ATTEMPT },
      ],
      [
        'stale with providerMessageId',
        { outcome: 'STALE', attemptId: ATTEMPT, providerMessageId: 'w' },
      ],
      [
        'unknown outcome',
        { outcome: 'SENT', attemptId: ATTEMPT, attemptedAt: AT },
      ],
      ['extra key', { outcome: 'STALE', attemptId: ATTEMPT, note: 'x' }],
    ])(
      'rejects a body that breaks the contract (%s) before any HTTP',
      async (_name, input) => {
        await expect(
          client.recordDeliveryOutcome(
            DELIVERY,
            input as unknown as DeliveryOutcomeInput,
          ),
        ).rejects.toBeInstanceOf(ChatbotApiError);
        expect(request).not.toHaveBeenCalled();
      },
    );

    it('rejects an ACK bound to another attempt or outcome', async () => {
      const input: DeliveryOutcomeInput = {
        outcome: 'STALE',
        attemptId: ATTEMPT,
      };
      request.mockReturnValueOnce(
        of(response({ ...ack('STALE'), attemptId: SOURCE })),
      );
      await expect(
        client.recordDeliveryOutcome(DELIVERY, input),
      ).rejects.toBeInstanceOf(UpstreamError);
      request.mockReturnValueOnce(of(response(ack('DELIVERY_UNKNOWN'))));
      await expect(
        client.recordDeliveryOutcome(DELIVERY, input),
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it.each([
      [
        httpError(409, { code: 'IDEMPOTENCY_CONFLICT' }),
        { kind: 'IDEMPOTENCY_CONFLICT' },
      ],
      [
        httpError(409, { code: 'OUTCOME_ALREADY_RECORDED' }),
        { kind: 'OUTCOME_ALREADY_RECORDED' },
      ],
      [
        httpError(422, { code: 'OUTCOME_NOT_ALLOWED' }),
        { kind: 'OUTCOME_NOT_ALLOWED' },
      ],
      [
        httpError(404, { message: 'Delivery not found' }),
        { kind: 'NOT_FOUND' },
      ],
      [
        httpError(429, { code: 'RATE_LIMITED' }, { 'retry-after': '4' }),
        { kind: 'RATE_LIMITED', retryAfterSeconds: 4 },
      ],
      [
        httpError(400, {
          code: 'VALIDATION_ERROR',
          message: 'outcome must be one of',
        }),
        { kind: 'VALIDATION_ERROR', message: 'outcome must be one of' },
      ],
    ])(
      'maps a documented error to a typed result (%#) without retry',
      async (reply, expected) => {
        request.mockReturnValue(reply);
        await expect(
          client.recordDeliveryOutcome(DELIVERY, {
            outcome: 'DEFERRED_HUMAN_SESSION',
            attemptId: ATTEMPT,
            attemptedAt: AT,
          }),
        ).resolves.toEqual(expected);
        expect(request).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('listPendingDeliveries', () => {
    it('queries by conversationRef and accepts an optional deferredReason', async () => {
      request.mockReturnValue(
        of(
          response({
            items: [{ ...answeredItem, deferredReason: 'WINDOW_CLOSED' }],
          }),
        ),
      );
      const result = await client.listPendingDeliveries({
        conversationRef: 'wa:5215512345678',
      });
      expect(result.kind).toBe('ok');
      expect(result.kind === 'ok' && result.items[0]).toMatchObject({
        type: 'request.answered',
        deliveryId: DELIVERY,
        deferredReason: 'WINDOW_CLOSED',
      });
      expect(sent()).toEqual(
        expect.objectContaining({
          method: 'GET',
          url: '/chatbot-api/requests/pending-deliveries',
          params: { conversationRef: 'wa:5215512345678' },
        }),
      );
    });

    it('queries by requestId', async () => {
      request.mockReturnValue(of(response({ items: [] })));
      await expect(
        client.listPendingDeliveries({ requestId: REQUEST }),
      ).resolves.toEqual({
        kind: 'ok',
        items: [],
      });
      expect(sent().params).toEqual({ requestId: REQUEST });
    });

    it.each([
      [{}],
      [{ conversationRef: 'wa:1', requestId: REQUEST }],
      [{ conversationRef: '' }],
    ])(
      'requires exactly one non-empty filter (%j) before any HTTP',
      async (filter) => {
        await expect(
          client.listPendingDeliveries(
            filter as unknown as { requestId: string },
          ),
        ).rejects.toBeInstanceOf(ChatbotApiError);
        expect(request).not.toHaveBeenCalled();
      },
    );

    it('rejects an unknown deferredReason and a malformed item', async () => {
      request.mockReturnValueOnce(
        of(response({ items: [{ ...answeredItem, deferredReason: 'LATER' }] })),
      );
      await expect(
        client.listPendingDeliveries({ requestId: REQUEST }),
      ).rejects.toBeInstanceOf(UpstreamError);
      request.mockReturnValueOnce(
        of(response({ items: [{ ...answeredItem, requestId: 5 }] })),
      );
      await expect(
        client.listPendingDeliveries({ requestId: REQUEST }),
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it('maps 429 to RATE_LIMITED', async () => {
      request.mockReturnValue(
        httpError(429, { code: 'RATE_LIMITED' }, { 'retry-after': '5' }),
      );
      await expect(
        client.listPendingDeliveries({ requestId: REQUEST }),
      ).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 5,
      });
    });
  });

  describe('listOpenRequests (5c recovery)', () => {
    const openRequest = (patch: Record<string, unknown> = {}) => ({
      id: REQUEST,
      folio: 'S-000123',
      kind: 'DECISION',
      subtype: 'RESTOCK',
      status: 'RESOLVED',
      conversationRef: 'wa:5215512345678',
      legacyId: SOURCE,
      whatsappWindowClosesAt: '2026-11-11T16:20:00.000Z',
      cancelReason: null,
      createdAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T16:00:00.000Z',
      closedAt: '2026-11-10T16:00:00.000Z',
      pendingDeliveries: [{ ...answeredItem, deferredReason: null }],
      undeliveredTruncated: false,
      undeliveredResumeAfter: null,
      ...patch,
    });
    const body = (
      items: unknown[] = [openRequest()],
      nextPage: string | null = 'eyJ1Ijoi',
    ) => ({ items, nextCursor: '000000001900', nextPage });

    it('GETs status=open with updatedSince/cursor/limit (safe retry) and parses the page', async () => {
      request
        .mockReturnValueOnce(httpError(503, {}))
        .mockReturnValueOnce(of(response(body())));
      const result = await client.listOpenRequests({
        updatedSince: AT,
        cursor: 'abc',
        limit: 20,
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(sent()).toEqual(
        expect.objectContaining({
          method: 'GET',
          url: '/chatbot-api/requests',
          params: {
            status: 'open',
            updatedSince: AT,
            cursor: 'abc',
            limit: 20,
          },
        }),
      );
      expect(result).toEqual({
        kind: 'ok',
        nextCursor: '000000001900',
        nextPage: 'eyJ1Ijoi',
        items: [
          {
            ...openRequest(),
            pendingDeliveries: [
              expect.objectContaining({
                type: 'request.answered',
                deliveryId: DELIVERY,
                cursor: '000000001842',
              }),
            ],
          },
        ],
      });
      const item = result.kind === 'ok' ? result.items[0] : undefined;
      expect(item?.pendingDeliveries[0]).not.toHaveProperty('deferredReason');
    });

    it('defaults to status=open&limit=50 without updatedSince or cursor', async () => {
      request.mockReturnValue(of(response(body([], null))));
      await expect(client.listOpenRequests()).resolves.toEqual({
        kind: 'ok',
        items: [],
        nextCursor: '000000001900',
        nextPage: null,
      });
      expect(sent().params).toEqual({ status: 'open', limit: 50 });
    });

    it('keeps a HUMAN_SESSION deferral, nullable fields and a truncated request', async () => {
      request.mockReturnValue(
        of(
          response(
            body([
              openRequest({
                status: 'NEW',
                folio: null,
                conversationRef: null,
                legacyId: null,
                whatsappWindowClosesAt: null,
                closedAt: null,
                pendingDeliveries: [
                  { ...answeredItem, deferredReason: 'HUMAN_SESSION' },
                ],
                undeliveredTruncated: true,
                undeliveredResumeAfter: '000000001700',
              }),
            ]),
          ),
        ),
      );
      const result = await client.listOpenRequests();
      expect(result.kind === 'ok' && result.items[0]).toMatchObject({
        status: 'NEW',
        conversationRef: null,
        undeliveredTruncated: true,
        undeliveredResumeAfter: '000000001700',
        pendingDeliveries: [{ deferredReason: 'HUMAN_SESSION' }],
      });
    });

    it.each([
      ['updatedSince not canonical', { updatedSince: '2026-11-10T16:20:00Z' }],
      ['updatedSince not a date', { updatedSince: 'yesterday' }],
      ['empty cursor', { cursor: '' }],
      ['limit 0', { limit: 0 }],
      ['limit 51', { limit: 51 }],
      ['limit 1.5', { limit: 1.5 }],
    ])('rejects %s before any HTTP', async (_name, options) => {
      await expect(client.listOpenRequests(options)).rejects.toBeInstanceOf(
        ChatbotApiError,
      );
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown status', { status: 'MERGED' }],
      ['a missing folio', { folio: undefined }],
      ['a non-boolean truncated flag', { undeliveredTruncated: 'no' }],
      [
        'truncated without a resume cursor',
        { undeliveredTruncated: true, undeliveredResumeAfter: null },
      ],
      ['a malformed pending delivery', { pendingDeliveries: [{ x: 1 }] }],
      [
        'an unknown deferredReason',
        {
          pendingDeliveries: [{ ...answeredItem, deferredReason: 'LATER' }],
        },
      ],
      [
        'a pending delivery of another request',
        { pendingDeliveries: [{ ...answeredItem, requestId: SOURCE }] },
      ],
      ['pendingDeliveries not an array', { pendingDeliveries: null }],
      ['a missing updatedAt', { updatedAt: undefined }],
    ])('rejects a page with %s as UpstreamError', async (_name, patch) => {
      request.mockReturnValue(of(response(body([openRequest(patch)]))));
      await expect(client.listOpenRequests()).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });

    it.each([
      ['no nextCursor', { items: [], nextPage: null }],
      ['an empty nextCursor', { items: [], nextCursor: '', nextPage: null }],
      ['no nextPage', { items: [], nextCursor: '1' }],
      ['items not an array', { items: {}, nextCursor: '1', nextPage: null }],
    ])('rejects a page with %s as UpstreamError', async (_name, page) => {
      request.mockReturnValue(of(response(page)));
      await expect(client.listOpenRequests()).rejects.toBeInstanceOf(
        UpstreamError,
      );
    });

    it('maps 400 VALIDATION_ERROR and 429 RATE_LIMITED to typed results', async () => {
      request.mockReturnValueOnce(
        httpError(400, {
          code: 'VALIDATION_ERROR',
          message: 'updatedSince must be canonical',
        }),
      );
      await expect(client.listOpenRequests()).resolves.toEqual({
        kind: 'VALIDATION_ERROR',
        message: 'updatedSince must be canonical',
      });
      request.mockReturnValueOnce(
        httpError(429, { code: 'RATE_LIMITED' }, { 'retry-after': '3' }),
      );
      await expect(client.listOpenRequests()).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 3,
      });
    });

    it('still throws 403 (missing requests:read scope)', async () => {
      request.mockReturnValue(httpError(403, { message: 'Forbidden' }));
      await expect(client.listOpenRequests()).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});

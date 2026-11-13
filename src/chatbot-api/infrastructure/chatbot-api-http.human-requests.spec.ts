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

    it("uses the caller's timeoutMs as the request timeout and never sends it (F1)", async () => {
      request.mockReturnValue(of(response(created, 201)));
      await client.createHumanRequest({ ...createInput, timeoutMs: 3_200 });
      expect(sent().timeout).toBe(3_200);
      expect(sent().data).toEqual(createInput);
      expect(sent().data).not.toHaveProperty('timeoutMs');
    });

    it('falls back to the default timeout for an absent or invalid timeoutMs', async () => {
      request.mockReturnValue(of(response(created, 201)));
      await client.createHumanRequest(createInput);
      await client.createHumanRequest({ ...createInput, timeoutMs: 0 });
      await client.createHumanRequest({ ...createInput, timeoutMs: NaN });
      expect(sent(0).timeout).toBe(10_000);
      expect(sent(1).timeout).toBe(10_000);
      expect(sent(2).timeout).toBe(10_000);
    });

    it('keeps the unscheduled answer free of scheduling fields and passes the branch zone through (unit 14)', async () => {
      const withZone = {
        ...created,
        businessHours: {
          openNow: false,
          nextOpenAt: AT,
          timeZone: 'America/Mexico_City',
        },
      };
      request.mockReturnValue(of(response(withZone, 201)));
      const result = await client.createHumanRequest(createInput);
      expect(result).toEqual({ kind: 'ok', status: 201, response: withZone });
      expect(sent().data).not.toHaveProperty('scheduledFor');
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

    describe('request.answered CLARIFICATION (unit 10)', () => {
      const REPLY = '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09';
      const clarificationRaw = (payload: Record<string, unknown>) => ({
        ...answeredItem,
        payload: {
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          action: 'REPLY',
          text: 'Sí, es apto desde las 8 semanas.',
          prefix: 'Le comparto la respuesta del equipo:',
          staffText: 'Sí, es apto desde las 8 semanas.',
          ...payload,
        },
      });
      const readPayload = async (raw: unknown) => {
        request.mockReturnValue(
          of(response({ items: [raw], nextCursor: '000000001842' })),
        );
        const result = await client.readFeed({ after: 'c' });
        if (result.kind !== 'ok') throw new Error('expected ok');
        return (result.items[0] as { payload: unknown }).payload;
      };

      it('parses replyId and relays staffText', async () => {
        await expect(
          readPayload(clarificationRaw({ replyId: REPLY })),
        ).resolves.toEqual({
          kind: 'CLARIFICATION',
          text: 'Sí, es apto desde las 8 semanas.',
          prefix: 'Le comparto la respuesta del equipo:',
          replyId: REPLY,
        });
      });

      it('an item without replyId still parses (no attribution)', async () => {
        const payload = await readPayload(clarificationRaw({}));
        expect(payload).toEqual({
          kind: 'CLARIFICATION',
          text: 'Sí, es apto desde las 8 semanas.',
          prefix: 'Le comparto la respuesta del equipo:',
        });
        expect(payload).not.toHaveProperty('replyId');
      });

      it('staffText wins over text; text is the fallback when staffText is absent', async () => {
        await expect(
          readPayload(
            clarificationRaw({
              text: 'otro',
              staffText: 'tal cual',
              replyId: REPLY,
            }),
          ),
        ).resolves.toMatchObject({ text: 'tal cual' });
        await expect(
          readPayload(clarificationRaw({ staffText: undefined })),
        ).resolves.toMatchObject({ text: 'Sí, es apto desde las 8 semanas.' });
      });

      it.each([[null], [''], [42], ['not-a-uuid']])(
        'a malformed replyId (%j) is ignored, never rejects the page',
        async (replyId) => {
          const payload = await readPayload(clarificationRaw({ replyId }));
          expect(payload).toMatchObject({ kind: 'CLARIFICATION' });
          expect(payload).not.toHaveProperty('replyId');
        },
      );
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

    describe('request.overdue_notice', () => {
      const overdueRaw = (patch: Record<string, unknown> = {}) => ({
        cursor: '000000001850',
        deliveryId: 'd9',
        type: 'request.overdue_notice',
        requestId: 'req-o',
        conversationRef: 'wa:5215550001111',
        notBefore: null,
        expiresAt: null,
        payload: {
          requestId: 'req-o',
          folio: 'SOL-0042',
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          clock: 'RESOLVE',
          overdueAt: '2026-11-11T10:00:00.000Z',
          assigned: true,
        },
        ...patch,
      });
      const read = async (raw: unknown) => {
        request.mockReturnValue(
          of(response({ items: [raw], nextCursor: '000000001850' })),
        );
        const result = await client.readFeed({ after: 'c' });
        if (result.kind !== 'ok') throw new Error('expected ok');
        return result.items;
      };

      it('parses a valid item', async () => {
        await expect(read(overdueRaw())).resolves.toEqual([
          {
            type: 'request.overdue_notice',
            cursor: '000000001850',
            deliveryId: 'd9',
            requestId: 'req-o',
            conversationRef: 'wa:5215550001111',
            notBefore: null,
            expiresAt: null,
            payload: {
              requestId: 'req-o',
              folio: 'SOL-0042',
              kind: 'CLARIFICATION',
              subtype: 'UNKNOWN_QUESTION',
              clock: 'RESOLVE',
              overdueAt: '2026-11-11T10:00:00.000Z',
              assigned: true,
            },
          },
        ]);
      });

      it('is tolerant: only the clock is required in the payload', async () => {
        const items = await read(
          overdueRaw({
            payload: { clock: 'CLAIM', assigned: 'yes', folio: 7 },
          }),
        );
        expect(items).toEqual([
          expect.objectContaining({
            type: 'request.overdue_notice',
            payload: {
              requestId: 'req-o',
              folio: null,
              kind: null,
              subtype: null,
              clock: 'CLAIM',
              overdueAt: null,
              assigned: false,
            },
          }),
        ]);
      });

      it.each([
        ['an unknown clock', { payload: { clock: 'SOON' } }],
        ['a missing clock', { payload: { folio: 'SOL-1' } }],
        ['a payload that is not an object', { payload: 'x' }],
        ['a missing payload', { payload: undefined }],
        ['a missing requestId', { requestId: undefined }],
        ['a numeric conversationRef', { conversationRef: 5 }],
      ])(
        'falls back to "unknown" for %s without rejecting the page',
        async (_label, patch) => {
          const raw = overdueRaw(patch);
          await expect(read(raw)).resolves.toEqual([
            {
              type: 'unknown',
              rawType: 'request.overdue_notice',
              cursor: '000000001850',
              deliveryId: 'd9',
              raw,
            },
          ]);
        },
      );
    });

    describe('live conversation items (unit 11)', () => {
      const envelope = (type: string, payload: unknown, extra = {}) => ({
        cursor: '000000001900',
        deliveryId: 'd-live',
        type,
        requestId: 'req-l',
        conversationRef: 'wa:5215550001111',
        notBefore: null,
        expiresAt: null,
        payload,
        ...extra,
      });
      const read = async (raw: unknown) => {
        request.mockReturnValue(
          of(response({ items: [raw], nextCursor: '000000001900' })),
        );
        const result = await client.readFeed({ after: 'c' });
        if (result.kind !== 'ok') throw new Error('expected ok');
        return result.items;
      };
      const base = {
        cursor: '000000001900',
        deliveryId: 'd-live',
        requestId: 'req-l',
        conversationRef: 'wa:5215550001111',
        notBefore: null,
        expiresAt: null,
      };
      const startedPayload = {
        requestId: 'req-l',
        handoffEpoch: 3,
        staffFirstName: 'Ana',
        whatsappWindowClosesAt: '2026-11-13T10:00:00.000Z',
      };
      const textPayload = {
        requestId: 'req-l',
        handoffEpoch: 3,
        seq: 18,
        messageId: 'msg-1',
        type: 'TEXT',
        text: 'Hola\nLe confirmo su pedido',
      };
      const mediaPayload = {
        requestId: 'req-l',
        handoffEpoch: 3,
        seq: 19,
        messageId: 'msg-2',
        type: 'IMAGE',
        mediaId: 'media-1',
        mimeType: 'image/jpeg',
        filename: 'foto.jpg',
        caption: 'Así se ve',
      };
      const templatePayload = {
        requestId: 'req-l',
        handoffEpoch: 3,
        seq: 20,
        messageId: 'msg-3',
        templateName: 'seguimiento',
        languageCode: 'es_MX',
      };
      const reassignedPayload = {
        requestId: 'req-l',
        handoffEpoch: 3,
        staffFirstName: 'Luis',
      };
      const endedPayload = {
        requestId: 'req-l',
        handoffEpoch: 3,
        reason: 'FINISHED',
        farewell: true,
        resumeNotice: false,
      };

      it('parses conversation.started', async () => {
        await expect(
          read(envelope('conversation.started', startedPayload)),
        ).resolves.toEqual([
          { ...base, type: 'conversation.started', payload: startedPayload },
        ]);
      });

      it('conversation.started: null name and null window are kept as null', async () => {
        const payload = {
          ...startedPayload,
          staffFirstName: null,
          whatsappWindowClosesAt: null,
        };
        await expect(
          read(envelope('conversation.started', payload)),
        ).resolves.toEqual([
          { ...base, type: 'conversation.started', payload },
        ]);
      });

      it('conversation.started: an empty name is no name and a malformed window is informational only', async () => {
        const items = await read(
          envelope('conversation.started', {
            ...startedPayload,
            staffFirstName: '',
            whatsappWindowClosesAt: 42,
          }),
        );
        expect(items).toEqual([
          {
            ...base,
            type: 'conversation.started',
            payload: {
              ...startedPayload,
              staffFirstName: null,
              whatsappWindowClosesAt: null,
            },
          },
        ]);
      });

      it('parses a TEXT conversation.staff_message verbatim (no trimming)', async () => {
        const payload = { ...textPayload, text: '  Hola  \n' };
        await expect(
          read(envelope('conversation.staff_message', payload)),
        ).resolves.toEqual([
          { ...base, type: 'conversation.staff_message', payload },
        ]);
      });

      it.each(['IMAGE', 'DOCUMENT'])(
        'parses a %s conversation.staff_message with media fields',
        async (kind) => {
          const payload = {
            ...mediaPayload,
            type: kind,
            mimeType: kind === 'IMAGE' ? 'image/png' : 'application/pdf',
            filename: kind === 'IMAGE' ? 'a.png' : 'lista.pdf',
          };
          await expect(
            read(envelope('conversation.staff_message', payload)),
          ).resolves.toEqual([
            { ...base, type: 'conversation.staff_message', payload },
          ]);
        },
      );

      it('a media staff_message with a null or absent caption keeps caption null', async () => {
        const { caption: _drop, ...noCaption } = mediaPayload;
        void _drop;
        for (const payload of [{ ...mediaPayload, caption: null }, noCaption])
          await expect(
            read(envelope('conversation.staff_message', payload)),
          ).resolves.toEqual([
            {
              ...base,
              type: 'conversation.staff_message',
              payload: { ...mediaPayload, caption: null },
            },
          ]);
      });

      it('parses template.requested and defaults the language to es_MX when absent', async () => {
        await expect(
          read(envelope('template.requested', templatePayload)),
        ).resolves.toEqual([
          { ...base, type: 'template.requested', payload: templatePayload },
        ]);
        const { languageCode: _drop, ...noLanguage } = templatePayload;
        void _drop;
        await expect(
          read(envelope('template.requested', noLanguage)),
        ).resolves.toEqual([
          {
            ...base,
            type: 'template.requested',
            payload: { ...templatePayload, languageCode: 'es_MX' },
          },
        ]);
      });

      it('parses template.requested with a two-letter language', async () => {
        const payload = { ...templatePayload, languageCode: 'es' };
        await expect(
          read(envelope('template.requested', payload)),
        ).resolves.toEqual([{ ...base, type: 'template.requested', payload }]);
      });

      it('parses conversation.reassigned, with and without a name', async () => {
        await expect(
          read(envelope('conversation.reassigned', reassignedPayload)),
        ).resolves.toEqual([
          {
            ...base,
            type: 'conversation.reassigned',
            payload: reassignedPayload,
          },
        ]);
        const payload = { ...reassignedPayload, staffFirstName: null };
        await expect(
          read(envelope('conversation.reassigned', payload)),
        ).resolves.toEqual([
          { ...base, type: 'conversation.reassigned', payload },
        ]);
      });

      it.each([
        ['FINISHED', true, false],
        ['FORCED', true, false],
        ['IDLE_TIMEOUT', true, false],
        ['START_TIMEOUT', false, true],
      ])(
        'parses conversation.ended %s',
        async (reason, farewell, resumeNotice) => {
          const payload = { ...endedPayload, reason, farewell, resumeNotice };
          await expect(
            read(envelope('conversation.ended', payload)),
          ).resolves.toEqual([
            { ...base, type: 'conversation.ended', payload },
          ]);
        },
      );

      it('keeps the deferredReason of a pending staff_message', async () => {
        const items = await read(
          envelope('conversation.staff_message', textPayload, {
            deferredReason: 'WINDOW_CLOSED',
          }),
        );
        expect(items).toEqual([
          expect.objectContaining({
            type: 'conversation.staff_message',
            deferredReason: 'WINDOW_CLOSED',
          }),
        ]);
      });

      const MALFORMED: Array<[string, string, Record<string, unknown>]> = [
        ['started: epoch 0', 'conversation.started', { handoffEpoch: 0 }],
        [
          'started: epoch as text',
          'conversation.started',
          { handoffEpoch: '3' },
        ],
        [
          'started: fractional epoch',
          'conversation.started',
          { handoffEpoch: 1.5 },
        ],
        [
          'started: numeric name',
          'conversation.started',
          { staffFirstName: 7 },
        ],
        [
          'started: payload requestId differs',
          'conversation.started',
          { requestId: 'other' },
        ],
        [
          'staff: missing messageId',
          'conversation.staff_message',
          { messageId: undefined },
        ],
        [
          'staff: missing seq',
          'conversation.staff_message',
          { seq: undefined },
        ],
        ['staff: negative seq', 'conversation.staff_message', { seq: -1 }],
        [
          'staff: unknown type',
          'conversation.staff_message',
          { type: 'AUDIO' },
        ],
        ['staff: empty text', 'conversation.staff_message', { text: '' }],
        [
          'staff: text over 4096',
          'conversation.staff_message',
          { text: 'x'.repeat(4097) },
        ],
        ['staff: numeric text', 'conversation.staff_message', { text: 5 }],
        [
          'staff: epoch missing',
          'conversation.staff_message',
          { handoffEpoch: undefined },
        ],
        [
          'template: missing templateName',
          'template.requested',
          { templateName: undefined },
        ],
        [
          'template: bad language',
          'template.requested',
          { languageCode: 'espanol' },
        ],
        [
          'template: missing messageId',
          'template.requested',
          { messageId: undefined },
        ],
        ['template: missing seq', 'template.requested', { seq: undefined }],
        [
          'reassigned: epoch missing',
          'conversation.reassigned',
          { handoffEpoch: undefined },
        ],
        [
          'reassigned: numeric name',
          'conversation.reassigned',
          { staffFirstName: 1 },
        ],
        ['ended: unknown reason', 'conversation.ended', { reason: 'BORED' }],
        ['ended: farewell as text', 'conversation.ended', { farewell: 'yes' }],
        [
          'ended: missing resumeNotice',
          'conversation.ended',
          { resumeNotice: undefined },
        ],
        ['ended: epoch as text', 'conversation.ended', { handoffEpoch: 'x' }],
      ];
      const validPayload: Record<string, Record<string, unknown>> = {
        'conversation.started': startedPayload,
        'conversation.staff_message': textPayload,
        'template.requested': templatePayload,
        'conversation.reassigned': reassignedPayload,
        'conversation.ended': endedPayload,
      };
      it.each(MALFORMED)(
        'falls back to "unknown" for %s without rejecting the page',
        async (_label, type, patch) => {
          const raw = envelope(type, { ...validPayload[type], ...patch });
          await expect(read(raw)).resolves.toEqual([
            {
              type: 'unknown',
              rawType: type,
              cursor: '000000001900',
              deliveryId: 'd-live',
              raw,
            },
          ]);
        },
      );

      it.each([
        ['IMAGE missing mediaId', { mediaId: undefined }],
        ['IMAGE missing mimeType', { mimeType: undefined }],
        ['IMAGE missing filename', { filename: undefined }],
        ['IMAGE numeric caption', { caption: 4 }],
        ['IMAGE with text instead of media', { mediaId: '' }],
      ])('staff_message %s falls back to "unknown"', async (_label, patch) => {
        const raw = envelope('conversation.staff_message', {
          ...mediaPayload,
          ...patch,
        });
        await expect(read(raw)).resolves.toEqual([
          expect.objectContaining({
            type: 'unknown',
            rawType: 'conversation.staff_message',
          }),
        ]);
      });

      it.each([
        ['a missing payload', { payload: undefined }],
        ['a payload that is not an object', { payload: 'x' }],
        ['a missing requestId and payload requestId', { requestId: undefined }],
        ['a numeric conversationRef', { conversationRef: 5 }],
        ['a numeric notBefore', { notBefore: 5 }],
        ['an unknown deferredReason', { deferredReason: 'LATER' }],
      ])(
        'an envelope with %s falls back to "unknown"',
        async (_label, patch) => {
          const payload =
            'requestId' in patch
              ? { ...endedPayload, requestId: undefined }
              : endedPayload;
          const raw = envelope('conversation.ended', payload, patch);
          const items = await read(raw);
          expect(items).toHaveLength(1);
          expect(items[0]).toMatchObject({
            type: 'unknown',
            rawType: 'conversation.ended',
          });
        },
      );

      it('a bad live item never rejects a page that carries other items', async () => {
        const good = envelope('conversation.ended', endedPayload);
        const bad = envelope(
          'conversation.staff_message',
          { ...textPayload, seq: 'x' },
          { deliveryId: 'd-bad', cursor: '000000001901' },
        );
        request.mockReturnValue(
          of(response({ items: [good, bad], nextCursor: '000000001901' })),
        );
        const result = await client.readFeed({ after: 'c' });
        if (result.kind !== 'ok') throw new Error('expected ok');
        expect(result.items.map((i) => i.type)).toEqual([
          'conversation.ended',
          'unknown',
        ]);
      });

      it('a live item arrives typed through pending deliveries too', async () => {
        request.mockReturnValue(
          of(
            response({
              items: [
                envelope('conversation.staff_message', textPayload, {
                  deferredReason: 'WINDOW_CLOSED',
                }),
              ],
            }),
          ),
        );
        const result = await client.listPendingDeliveries({
          conversationRef: 'wa:5215550001111',
        });
        if (result.kind !== 'ok') throw new Error('expected ok');
        expect(result.items[0]).toMatchObject({
          type: 'conversation.staff_message',
          deferredReason: 'WINDOW_CLOSED',
        });
      });
    });

    describe('scheduled conversation items (unit 14)', () => {
      const envelope = (type: string, payload: unknown, extra = {}) => ({
        cursor: '000000002000',
        deliveryId: 'd-sch',
        type,
        requestId: 'req-s',
        conversationRef: 'wa:5215550001111',
        notBefore: null,
        expiresAt: null,
        payload,
        ...extra,
      });
      const base = {
        cursor: '000000002000',
        deliveryId: 'd-sch',
        requestId: 'req-s',
        conversationRef: 'wa:5215550001111',
        notBefore: null,
        expiresAt: null,
      };
      const read = async (raw: unknown) => {
        request.mockReturnValue(
          of(response({ items: [raw], nextCursor: '000000002000' })),
        );
        const result = await client.readFeed({ after: 'c' });
        if (result.kind !== 'ok') throw new Error('expected ok');
        return result.items;
      };
      // The contract's full payloads (extra keys are tolerated, not kept).
      const reminderWire = {
        requestId: 'req-s',
        scheduledFor: '2026-11-10T15:00:00.000Z',
        scheduleVersion: 2,
        minutesBefore: 10,
        timeZone: 'America/Mexico_City',
        whatsappWindowClosesAt: '2026-11-10T21:02:11.000Z',
        requiresTemplateAtStart: false,
      };
      const rescheduledWire = {
        requestId: 'req-s',
        scheduledFor: '2026-11-11T15:30:00.000Z',
        previousScheduledFor: '2026-11-10T15:00:00.000Z',
        scheduleVersion: 3,
        timeZone: 'America/Mexico_City',
        whatsappWindowClosesAt: '2026-11-11T21:02:11.000Z',
        requiresTemplateAtStart: false,
      };
      const reminderPayload = {
        requestId: 'req-s',
        scheduledFor: '2026-11-10T15:00:00.000Z',
        scheduleVersion: 2,
        timeZone: 'America/Mexico_City',
        whatsappWindowClosesAt: '2026-11-10T21:02:11.000Z',
      };
      const rescheduledPayload = {
        requestId: 'req-s',
        scheduledFor: '2026-11-11T15:30:00.000Z',
        previousScheduledFor: '2026-11-10T15:00:00.000Z',
        scheduleVersion: 3,
        timeZone: 'America/Mexico_City',
        whatsappWindowClosesAt: '2026-11-11T21:02:11.000Z',
      };

      it('parses conversation.scheduled_reminder', async () => {
        await expect(
          read(envelope('conversation.scheduled_reminder', reminderWire)),
        ).resolves.toEqual([
          {
            ...base,
            type: 'conversation.scheduled_reminder',
            payload: reminderPayload,
          },
        ]);
      });

      it('parses conversation.rescheduled', async () => {
        await expect(
          read(envelope('conversation.rescheduled', rescheduledWire)),
        ).resolves.toEqual([
          {
            ...base,
            type: 'conversation.rescheduled',
            payload: rescheduledPayload,
          },
        ]);
      });

      it('timeZone and window are informational: absent, null, a bad zone or a wrong type become null', async () => {
        for (const extra of [
          { timeZone: undefined, whatsappWindowClosesAt: undefined },
          { timeZone: null, whatsappWindowClosesAt: null },
          { timeZone: 'Mars/Olympus', whatsappWindowClosesAt: 'later' },
          { timeZone: 42, whatsappWindowClosesAt: 7 },
        ]) {
          const items = await read(
            envelope('conversation.scheduled_reminder', {
              ...reminderWire,
              ...extra,
            }),
          );
          expect(items).toEqual([
            {
              ...base,
              type: 'conversation.scheduled_reminder',
              payload: {
                ...reminderPayload,
                timeZone: null,
                whatsappWindowClosesAt: null,
              },
            },
          ]);
        }
      });

      it('takes the requestId from the payload when the envelope omits it', async () => {
        const raw = envelope('conversation.scheduled_reminder', reminderWire);
        delete (raw as { requestId?: string }).requestId;
        await expect(read(raw)).resolves.toMatchObject([
          { type: 'conversation.scheduled_reminder', requestId: 'req-s' },
        ]);
      });

      it.each<[string, string, Record<string, unknown>]>([
        [
          'reminder: no scheduledFor',
          'conversation.scheduled_reminder',
          { scheduledFor: undefined },
        ],
        [
          'reminder: scheduledFor not a date',
          'conversation.scheduled_reminder',
          { scheduledFor: 'mañana' },
        ],
        [
          'reminder: scheduledFor a number',
          'conversation.scheduled_reminder',
          { scheduledFor: 1762786800000 },
        ],
        [
          'reminder: no scheduleVersion',
          'conversation.scheduled_reminder',
          { scheduleVersion: undefined },
        ],
        [
          'reminder: scheduleVersion 0',
          'conversation.scheduled_reminder',
          { scheduleVersion: 0 },
        ],
        [
          'reminder: scheduleVersion fractional',
          'conversation.scheduled_reminder',
          { scheduleVersion: 1.5 },
        ],
        [
          'reminder: scheduleVersion a string',
          'conversation.scheduled_reminder',
          { scheduleVersion: '2' },
        ],
        [
          'reminder: payload requestId disagrees',
          'conversation.scheduled_reminder',
          { requestId: 'req-other' },
        ],
        [
          'rescheduled: no previousScheduledFor',
          'conversation.rescheduled',
          { previousScheduledFor: undefined },
        ],
        [
          'rescheduled: previousScheduledFor not a date',
          'conversation.rescheduled',
          { previousScheduledFor: 'antes' },
        ],
        [
          'rescheduled: scheduleVersion negative',
          'conversation.rescheduled',
          { scheduleVersion: -1 },
        ],
        [
          'rescheduled: scheduledFor null',
          'conversation.rescheduled',
          { scheduledFor: null },
        ],
      ])('%s → unknown, never a rejected page', async (_name, type, patch) => {
        const wire =
          type === 'conversation.rescheduled' ? rescheduledWire : reminderWire;
        const raw = envelope(type, { ...wire, ...patch });
        await expect(read(raw)).resolves.toEqual([
          {
            type: 'unknown',
            rawType: type,
            cursor: '000000002000',
            deliveryId: 'd-sch',
            raw,
          },
        ]);
      });

      it('a missing payload or requestId is unknown too', async () => {
        for (const raw of [
          envelope('conversation.scheduled_reminder', null),
          envelope('conversation.rescheduled', 'x'),
          envelope(
            'conversation.scheduled_reminder',
            { ...reminderWire, requestId: undefined },
            { requestId: undefined },
          ),
        ])
          await expect(read(raw)).resolves.toMatchObject([{ type: 'unknown' }]);
      });

      it('a bad scheduled item never rejects a page that carries other items', async () => {
        const good = envelope('conversation.rescheduled', rescheduledWire);
        const bad = envelope(
          'conversation.scheduled_reminder',
          { ...reminderWire, scheduleVersion: 'x' },
          { deliveryId: 'd-bad', cursor: '000000002001' },
        );
        request.mockReturnValue(
          of(response({ items: [good, bad], nextCursor: '000000002001' })),
        );
        const result = await client.readFeed({ after: 'c' });
        if (result.kind !== 'ok') throw new Error('expected ok');
        expect(result.items.map((i) => i.type)).toEqual([
          'conversation.rescheduled',
          'unknown',
        ]);
      });

      it('a scheduled item arrives typed through pending deliveries too', async () => {
        request.mockReturnValue(
          of(
            response({
              items: [
                envelope('conversation.scheduled_reminder', reminderWire),
              ],
            }),
          ),
        );
        const result = await client.listPendingDeliveries({
          conversationRef: 'wa:5215550001111',
        });
        if (result.kind !== 'ok') throw new Error('expected ok');
        expect(result.items[0]).toMatchObject({
          type: 'conversation.scheduled_reminder',
        });
      });
    });

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

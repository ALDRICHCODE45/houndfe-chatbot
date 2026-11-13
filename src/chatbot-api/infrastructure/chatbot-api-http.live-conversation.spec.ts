import { createHash } from 'node:crypto';
import { promises as fsPromises, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { STAFF_MEDIA_MAX_BYTES } from '../domain/dtos/live-conversation.dto';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const PHONE = '5215512345678';
const REF = `wa:${PHONE}`;
const ENCODED_REF = `wa%3A${PHONE}`;
const MEDIA_ID = '0b3f1c1e-8a53-4d6f-9c1b-2a4e5f6a7b8c';

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
  Object.assign(new Error(`HTTP ${statusCode} for ${REF}`), {
    response: { status: statusCode, data: body, headers },
  });
const apiError = (statusCode: number, code: string, extra = {}) => ({
  statusCode,
  code,
  message: 'fixed text',
  ...extra,
});
const transportError = (code: string) =>
  Object.assign(new Error(`${code} talking to ${REF}`), { code });

const bytesStream = (...chunks: Buffer[]) => Readable.from(chunks);

describe('live conversation client (mocked HTTP)', () => {
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
  const sent = () => request.mock.calls[0][0];
  /** Nothing the client resolves may carry the ref or the phone (S7). */
  const expectNoPhone = (result: unknown) => {
    const text = JSON.stringify(result);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(ENCODED_REF);
  };

  describe('sessionAck', () => {
    it('posts exactly {epoch, state} to the URL-encoded ref with a 10 s timeout', async () => {
      request.mockReturnValue(
        of(
          response({
            epoch: 3,
            state: 'STARTED',
            sessionState: 'ACTIVE',
            extra: 'dropped',
          }),
        ),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({
        kind: 'ok',
        epoch: 3,
        state: 'STARTED',
        sessionState: 'ACTIVE',
      });
      expect(request).toHaveBeenCalledTimes(1);
      const config = sent();
      expect(config.method).toBe('POST');
      expect(config.url).toBe(
        `/chatbot-api/conversations/${ENCODED_REF}/session-ack`,
      );
      expect(config.baseURL).toBe('https://example.invalid');
      expect(config.timeout).toBe(10_000);
      expect(config.headers).toMatchObject({
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
      });
      expect(config.headers).not.toHaveProperty('X-Idempotency-Key');
      expect(Object.keys(config.data as object)).toEqual(['epoch', 'state']);
      expect(config.data).toEqual({ epoch: 3, state: 'STARTED' });
    });

    it('sends providerMessageId when given and only the three contract keys', async () => {
      request.mockReturnValue(
        of(response({ epoch: 2, state: 'ENDED', sessionState: 'ENDED' }, 200)),
      );
      const input = {
        epoch: 2,
        state: 'ENDED' as const,
        providerMessageId: 'wamid.HBgM',
        tenantId: 'x',
      };
      await client.sessionAck(REF, input);
      expect(Object.keys(sent().data as object)).toEqual([
        'epoch',
        'state',
        'providerMessageId',
      ]);
      expect(sent().data).toEqual({
        epoch: 2,
        state: 'ENDED',
        providerMessageId: 'wamid.HBgM',
      });
    });

    it('reads an unknown sessionState as null and never invents one', async () => {
      request.mockReturnValue(
        of(response({ epoch: 3, state: 'STARTED', sessionState: 'WEIRD' })),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toMatchObject({ kind: 'ok', sessionState: null });
    });

    it('maps 409 STALE_EPOCH to a reconcile result with the body facts, no retry', async () => {
      request.mockReturnValue(
        throwError(() =>
          httpError(
            409,
            apiError(409, 'STALE_EPOCH', {
              currentEpoch: 4,
              mode: 'HUMAN',
              sessionState: 'ACTIVE',
            }),
          ),
        ),
      );
      const result = await client.sessionAck(REF, {
        epoch: 3,
        state: 'STARTED',
      });
      expect(result).toEqual({
        kind: 'STALE_EPOCH',
        currentEpoch: 4,
        mode: 'HUMAN',
        sessionState: 'ACTIVE',
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expectNoPhone(result);
    });

    it('accepts a null or ENDED sessionState on STALE_EPOCH (late ack after a revert)', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(
            409,
            apiError(409, 'STALE_EPOCH', {
              currentEpoch: 3,
              mode: 'BOT',
              sessionState: null,
            }),
          ),
        ),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({
        kind: 'STALE_EPOCH',
        currentEpoch: 3,
        mode: 'BOT',
        sessionState: null,
      });
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(
            409,
            apiError(409, 'STALE_EPOCH', {
              currentEpoch: 3,
              mode: 'BOT',
              sessionState: 'ENDED',
            }),
          ),
        ),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toMatchObject({ kind: 'STALE_EPOCH', sessionState: 'ENDED' });
    });

    it('treats a STALE_EPOCH body that breaks the contract as UNEXPECTED, not as a guess', async () => {
      request.mockReturnValue(
        throwError(() =>
          httpError(409, apiError(409, 'STALE_EPOCH', { mode: 'HUMAN' })),
        ),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 409,
        code: 'STALE_EPOCH',
      });
    });

    it('maps 409 SESSION_NOT_ENDING', async () => {
      request.mockReturnValue(
        throwError(() => httpError(409, apiError(409, 'SESSION_NOT_ENDING'))),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'ENDED' }),
      ).resolves.toEqual({ kind: 'SESSION_NOT_ENDING' });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('maps an undocumented 409 code to UNEXPECTED', async () => {
      request.mockReturnValue(
        throwError(() => httpError(409, apiError(409, 'SOMETHING_NEW'))),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'ENDED' }),
      ).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 409,
        code: 'SOMETHING_NEW',
      });
    });

    it('maps 404 to NOT_FOUND', async () => {
      request.mockReturnValue(
        throwError(() => httpError(404, apiError(404, 'NOT_FOUND'))),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({ kind: 'NOT_FOUND' });
    });

    it('maps 429 with Retry-After seconds, no retry inside', async () => {
      request.mockReturnValue(
        throwError(() =>
          httpError(429, apiError(429, 'RATE_LIMITED'), { 'retry-after': '7' }),
        ),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({ kind: 'RATE_LIMITED', retryAfterSeconds: 7 });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('maps auth failures: 401 and 403 (with the code)', async () => {
      request.mockReturnValueOnce(throwError(() => httpError(401)));
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({ kind: 'UNAUTHORIZED' });
      request.mockReturnValueOnce(
        throwError(() => httpError(403, apiError(403, 'INSUFFICIENT_SCOPE'))),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({ kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' });
    });

    it('maps 400 to VALIDATION_ERROR (not local) with the backend message', async () => {
      request.mockReturnValue(
        throwError(() =>
          httpError(400, {
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            message: ['epoch must be an integer'],
          }),
        ),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({
        kind: 'VALIDATION_ERROR',
        message: 'epoch must be an integer',
        local: false,
      });
    });

    it('maps 5xx, timeouts and network failures to RETRYABLE without retrying', async () => {
      request.mockReturnValueOnce(throwError(() => httpError(503)));
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toMatchObject({
        kind: 'RETRYABLE',
        cause: 'http_5xx',
        status: 503,
      });
      request.mockReturnValueOnce(
        throwError(() => transportError('ECONNABORTED')),
      );
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toMatchObject({ kind: 'RETRYABLE', cause: 'timeout' });
      request.mockReturnValueOnce(
        throwError(() => transportError('ECONNRESET')),
      );
      const network = await client.sessionAck(REF, {
        epoch: 3,
        state: 'STARTED',
      });
      expect(network).toMatchObject({ kind: 'RETRYABLE', cause: 'network' });
      expectNoPhone(network);
      expect(request).toHaveBeenCalledTimes(3);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('treats a 200 with a broken body as UNEXPECTED', async () => {
      request.mockReturnValue(of(response({ epoch: 'x', state: 'STARTED' })));
      await expect(
        client.sessionAck(REF, { epoch: 3, state: 'STARTED' }),
      ).resolves.toEqual({ kind: 'UNEXPECTED', status: 200, code: null });
    });

    it.each([
      ['epoch 0', { epoch: 0, state: 'STARTED' }],
      ['fractional epoch', { epoch: 1.5, state: 'STARTED' }],
      ['unknown state', { epoch: 1, state: 'ACTIVE' }],
      [
        'empty providerMessageId',
        { epoch: 1, state: 'STARTED', providerMessageId: '' },
      ],
      [
        'oversized providerMessageId',
        { epoch: 1, state: 'STARTED', providerMessageId: 'w'.repeat(513) },
      ],
    ])('rejects %s locally before any request', async (_name, input) => {
      const result = await client.sessionAck(
        REF,
        input as Parameters<typeof client.sessionAck>[1],
      );
      expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
      expectNoPhone(result);
    });

    it('rejects a ref out of contract locally without echoing it', async () => {
      const result = await client.sessionAck('wa:55 12/../', {
        epoch: 1,
        state: 'STARTED',
      });
      expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(JSON.stringify(result)).not.toContain('55 12');
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('getConversationState', () => {
    it('GETs the encoded ref state and parses the shape', async () => {
      request.mockReturnValue(
        of(
          response({
            mode: 'HUMAN',
            handoffEpoch: 3,
            sessionState: 'ACTIVE',
            requestId: '9a7e',
            assigneeFirstName: 'Ana',
            extra: 'dropped',
          }),
        ),
      );
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'ok',
        mode: 'HUMAN',
        handoffEpoch: 3,
        sessionState: 'ACTIVE',
        requestId: '9a7e',
        assigneeFirstName: 'Ana',
      });
      expect(request).toHaveBeenCalledTimes(1);
      const config = sent();
      expect(config.method).toBe('GET');
      expect(config.url).toBe(
        `/chatbot-api/conversations/${ENCODED_REF}/state`,
      );
      expect(config.data).toBeUndefined();
    });

    it('reads BOT with nulls', async () => {
      request.mockReturnValue(
        of(
          response({
            mode: 'BOT',
            handoffEpoch: 4,
            sessionState: null,
            requestId: null,
            assigneeFirstName: null,
          }),
        ),
      );
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'ok',
        mode: 'BOT',
        handoffEpoch: 4,
        sessionState: null,
        requestId: null,
        assigneeFirstName: null,
      });
    });

    it('reads a 404 as BOT, epoch 0', async () => {
      request.mockReturnValue(
        throwError(() => httpError(404, apiError(404, 'NOT_FOUND'))),
      );
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'ok',
        mode: 'BOT',
        handoffEpoch: 0,
        sessionState: null,
        requestId: null,
        assigneeFirstName: null,
      });
    });

    it('fails closed on an unknown mode or a bad epoch', async () => {
      request.mockReturnValueOnce(
        of(response({ mode: 'ROBOT', handoffEpoch: 1 })),
      );
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 200,
        code: null,
      });
      request.mockReturnValueOnce(
        of(response({ mode: 'HUMAN', handoffEpoch: -1 })),
      );
      await expect(client.getConversationState(REF)).resolves.toMatchObject({
        kind: 'UNEXPECTED',
      });
    });

    it('maps every documented failure and never retries inside', async () => {
      request.mockReturnValueOnce(throwError(() => httpError(401)));
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'UNAUTHORIZED',
      });
      request.mockReturnValueOnce(
        throwError(() => httpError(403, apiError(403, 'INSUFFICIENT_SCOPE'))),
      );
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'FORBIDDEN',
        code: 'INSUFFICIENT_SCOPE',
      });
      request.mockReturnValueOnce(
        throwError(() => httpError(429, {}, { 'retry-after': '3' })),
      );
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 3,
      });
      request.mockReturnValueOnce(throwError(() => httpError(500)));
      const failure = await client.getConversationState(REF);
      expect(failure).toMatchObject({ kind: 'RETRYABLE', cause: 'http_5xx' });
      expectNoPhone(failure);
      request.mockReturnValueOnce(
        throwError(() => transportError('ETIMEDOUT')),
      );
      await expect(client.getConversationState(REF)).resolves.toMatchObject({
        kind: 'RETRYABLE',
        cause: 'timeout',
      });
      expect(request).toHaveBeenCalledTimes(5);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('rejects a ref out of contract locally', async () => {
      await expect(client.getConversationState('')).resolves.toMatchObject({
        kind: 'VALIDATION_ERROR',
        local: true,
      });
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('listHumanConversations', () => {
    const item = (n: number) => ({
      conversationRef: `wa:52155500000${n}`,
      mode: 'HUMAN',
      handoffEpoch: n,
      sessionState: 'ACTIVE',
      requestId: `req-${n}`,
      assigneeFirstName: null,
    });

    it('asks only mode=HUMAN by default and parses the page', async () => {
      request.mockReturnValue(
        of(response({ items: [item(1), item(2)], nextCursor: 'abc' })),
      );
      const result = await client.listHumanConversations();
      expect(result).toEqual({
        kind: 'ok',
        items: [item(1), item(2)],
        nextCursor: 'abc',
      });
      const config = sent();
      expect(config.method).toBe('GET');
      expect(config.url).toBe('/chatbot-api/conversations/state');
      expect(config.params).toEqual({ mode: 'HUMAN' });
    });

    it('passes cursor and limit and reads a null nextCursor on the last page', async () => {
      request.mockReturnValue(of(response({ items: [], nextCursor: null })));
      await expect(
        client.listHumanConversations({ cursor: 'abc', limit: 500 }),
      ).resolves.toEqual({ kind: 'ok', items: [], nextCursor: null });
      expect(sent().params).toEqual({
        mode: 'HUMAN',
        limit: 500,
        cursor: 'abc',
      });
    });

    it('fails closed when one item breaks the contract', async () => {
      request.mockReturnValue(
        of(
          response({
            items: [item(1), { ...item(2), mode: 'X' }],
            nextCursor: null,
          }),
        ),
      );
      await expect(client.listHumanConversations()).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 200,
        code: null,
      });
    });

    it.each([
      ['limit 0', { limit: 0 }],
      ['limit 501', { limit: 501 }],
      ['fractional limit', { limit: 1.5 }],
      ['empty cursor', { cursor: '' }],
    ])('rejects %s locally', async (_name, options) => {
      await expect(
        client.listHumanConversations(options),
      ).resolves.toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
    });

    it('maps 400 and the shared failures', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(400, {
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            message: 'mode must be HUMAN',
          }),
        ),
      );
      await expect(client.listHumanConversations()).resolves.toEqual({
        kind: 'VALIDATION_ERROR',
        message: 'mode must be HUMAN',
        local: false,
      });
      request.mockReturnValueOnce(throwError(() => httpError(401)));
      await expect(client.listHumanConversations()).resolves.toEqual({
        kind: 'UNAUTHORIZED',
      });
      request.mockReturnValueOnce(throwError(() => httpError(502)));
      await expect(client.listHumanConversations()).resolves.toMatchObject({
        kind: 'RETRYABLE',
        cause: 'http_5xx',
      });
    });
  });

  describe('scheduledRequest on the state routes (unit 14)', () => {
    const SCHEDULED = {
      requestId: '9a7e0000-1111-4222-8333-444455556666',
      subtype: 'TALK_TO_HUMAN',
      scheduledFor: '2026-11-10T15:00:00.000Z',
      needsReschedule: false,
      scheduleVersion: 2,
    };
    const botState = {
      mode: 'BOT',
      handoffEpoch: 0,
      sessionState: null,
      requestId: null,
      assigneeFirstName: null,
    };

    it('getConversationState parses scheduledRequest (extra keys dropped)', async () => {
      request.mockReturnValue(
        of(
          response({
            ...botState,
            scheduledRequest: { ...SCHEDULED, extra: 'dropped' },
          }),
        ),
      );
      const result = await client.getConversationState(REF);
      expect(result).toEqual({
        kind: 'ok',
        ...botState,
        scheduledRequest: SCHEDULED,
      });
      expectNoPhone(result);
    });

    it('getConversationState reads an unseen chat with a booking (200, BOT, epoch 0)', async () => {
      request.mockReturnValue(
        of(
          response({
            ...botState,
            scheduledRequest: { ...SCHEDULED, needsReschedule: true },
          }),
        ),
      );
      await expect(client.getConversationState(REF)).resolves.toMatchObject({
        kind: 'ok',
        mode: 'BOT',
        handoffEpoch: 0,
        scheduledRequest: { needsReschedule: true },
      });
    });

    it('getConversationState reads an explicit null as null', async () => {
      request.mockReturnValue(
        of(response({ ...botState, scheduledRequest: null })),
      );
      await expect(client.getConversationState(REF)).resolves.toEqual({
        kind: 'ok',
        ...botState,
        scheduledRequest: null,
      });
    });

    it('getConversationState keeps working when the key is absent (pre-unit-14 backend)', async () => {
      request.mockReturnValue(of(response(botState)));
      const result = await client.getConversationState(REF);
      expect(result).toEqual({ kind: 'ok', ...botState });
      expect(result).not.toHaveProperty('scheduledRequest');
    });

    it.each([
      ['a non-object', 'soon'],
      ['no requestId', { ...SCHEDULED, requestId: undefined }],
      ['a bad scheduledFor', { ...SCHEDULED, scheduledFor: 'x' }],
      ['a non-boolean needsReschedule', { ...SCHEDULED, needsReschedule: 1 }],
      ['a zero scheduleVersion', { ...SCHEDULED, scheduleVersion: 0 }],
    ])(
      'a malformed scheduledRequest (%s) reads as null and never breaks the mode/epoch read',
      async (_label, bad) => {
        request.mockReturnValue(
          of(
            response({
              mode: 'HUMAN',
              handoffEpoch: 3,
              sessionState: 'ACTIVE',
              requestId: 'r',
              assigneeFirstName: null,
              scheduledRequest: bad,
            }),
          ),
        );
        await expect(client.getConversationState(REF)).resolves.toMatchObject({
          kind: 'ok',
          mode: 'HUMAN',
          handoffEpoch: 3,
          scheduledRequest: null,
        });
      },
    );

    it('listHumanConversations parses scheduledRequest per item', async () => {
      const base = {
        mode: 'HUMAN',
        handoffEpoch: 1,
        sessionState: 'ACTIVE',
        requestId: 'req-1',
        assigneeFirstName: null,
      };
      request.mockReturnValue(
        of(
          response({
            items: [
              {
                conversationRef: 'wa:a',
                ...base,
                scheduledRequest: SCHEDULED,
              },
              { conversationRef: 'wa:b', ...base, scheduledRequest: null },
              { conversationRef: 'wa:c', ...base },
            ],
            nextCursor: null,
          }),
        ),
      );
      const result = await client.listHumanConversations();
      expect(result).toEqual({
        kind: 'ok',
        items: [
          { conversationRef: 'wa:a', ...base, scheduledRequest: SCHEDULED },
          { conversationRef: 'wa:b', ...base, scheduledRequest: null },
          { conversationRef: 'wa:c', ...base },
        ],
        nextCursor: null,
      });
    });
  });

  describe('downloadStaffMedia', () => {
    let dir: string;
    let tmpdirSpy: jest.SpyInstance<string, []>;
    const cleanups: Array<() => Promise<void>> = [];
    beforeEach(async () => {
      dir = await fsPromises.mkdtemp(join(os.tmpdir(), 'live-media-spec-'));
      // `process.env` is a per-test copy under jest, so spy on the function.
      tmpdirSpy = jest.spyOn(os, 'tmpdir').mockReturnValue(dir);
    });
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
      tmpdirSpy.mockRestore();
      await fsPromises.rm(dir, { recursive: true, force: true });
    });
    const files = () => fsPromises.readdir(dir);
    const mediaHeaders = (extra: Record<string, string> = {}) => ({
      'content-type': 'image/jpeg',
      'content-disposition': 'attachment; filename="photo-1.jpg"',
      ...extra,
    });

    it('streams the bytes to a mode-0600 temp file and returns the facts', async () => {
      const body = Buffer.from('JPEGBYTES-'.repeat(1000));
      request.mockReturnValue(
        of(
          response(
            bytesStream(body.subarray(0, 4000), body.subarray(4000)),
            200,
            mediaHeaders({ 'content-length': String(body.length) }),
          ),
        ),
      );
      const result = await client.downloadStaffMedia(MEDIA_ID);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      cleanups.push(result.cleanup);
      expect(result).toMatchObject({
        mimeType: 'image/jpeg',
        filename: 'photo-1.jpg',
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
      expect(statSync(result.filePath).mode & 0o777).toBe(0o600);
      expect(result.filePath.startsWith(dir)).toBe(true);
      expect(await fsPromises.readFile(result.filePath)).toEqual(body);

      const config = sent();
      expect(config.method).toBe('GET');
      expect(config.url).toBe(`/chatbot-api/media/${MEDIA_ID}`);
      expect(config.responseType).toBe('stream');
      expect(config.maxRedirects).toBe(0);
      expect(config.headers).toMatchObject({
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
      });

      await result.cleanup();
      await result.cleanup();
      expect(await files()).toEqual([]);
    });

    it('strips Content-Type parameters, falls back to "media" and sanitizes the filename', async () => {
      request.mockReturnValueOnce(
        of(
          response(bytesStream(Buffer.from('%PDF-1.4')), 200, {
            'content-type': 'application/pdf; charset=binary',
          }),
        ),
      );
      const noName = await client.downloadStaffMedia(MEDIA_ID);
      expect(noName).toMatchObject({
        kind: 'ok',
        mimeType: 'application/pdf',
        filename: 'media',
      });
      if (noName.kind === 'ok') cleanups.push(noName.cleanup);

      request.mockReturnValueOnce(
        of(
          response(bytesStream(Buffer.from('%PDF-1.4')), 200, {
            'content-type': 'application/pdf',
            'content-disposition':
              'attachment; filename="../../etc/pa ss?.pdf"',
          }),
        ),
      );
      const odd = await client.downloadStaffMedia(MEDIA_ID);
      expect(odd).toMatchObject({ kind: 'ok' });
      if (odd.kind === 'ok') {
        cleanups.push(odd.cleanup);
        expect(odd.filename).not.toMatch(/[/\\?]/);
      }
    });

    it('enforces the cap while streaming (no Content-Length) and leaves nothing on disk', async () => {
      const chunk = Buffer.alloc(1024, 1);
      let pushed = 0;
      const endless = new Readable({
        read() {
          pushed += 1;
          this.push(pushed > 1000 ? null : chunk);
        },
      });
      request.mockReturnValue(of(response(endless, 200, mediaHeaders())));
      await expect(
        client.downloadStaffMedia(MEDIA_ID, { maxBytes: 4096 }),
      ).resolves.toEqual({ kind: 'MEDIA_TOO_LARGE' });
      // It stopped reading long before the 1000 chunks the source offered.
      expect(pushed).toBeLessThan(100);
      expect(endless.destroyed).toBe(true);
      expect(await files()).toEqual([]);
    });

    it('defaults the cap to 10 MiB', async () => {
      expect(STAFF_MEDIA_MAX_BYTES).toBe(10 * 1024 * 1024);
      const over = Readable.from(
        (function* () {
          const chunk = Buffer.alloc(1024 * 1024, 2);
          for (let i = 0; i < 12; i += 1) yield chunk;
        })(),
      );
      request.mockReturnValue(of(response(over, 200, mediaHeaders())));
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'MEDIA_TOO_LARGE',
      });
      expect(await files()).toEqual([]);
    });

    it('refuses a declared Content-Length over the cap without reading the body', async () => {
      const body = bytesStream(Buffer.from('x'));
      request.mockReturnValue(
        of(response(body, 200, mediaHeaders({ 'content-length': '5000' }))),
      );
      await expect(
        client.downloadStaffMedia(MEDIA_ID, { maxBytes: 4096 }),
      ).resolves.toEqual({ kind: 'MEDIA_TOO_LARGE' });
      expect(body.destroyed).toBe(true);
      expect(await files()).toEqual([]);
    });

    it('treats a body shorter or longer than the declared Content-Length as a retryable network failure', async () => {
      request.mockReturnValue(
        of(
          response(
            bytesStream(Buffer.from('abc')),
            200,
            mediaHeaders({ 'content-length': '10' }),
          ),
        ),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toMatchObject({
        kind: 'RETRYABLE',
        cause: 'network',
      });
      expect(await files()).toEqual([]);
    });

    it('maps a stream that errors mid-download to RETRYABLE and removes the partial file', async () => {
      const broken = new Readable({
        read() {
          this.push(Buffer.from('partial'));
          this.destroy(new Error(`socket hang up for ${REF}`));
        },
      });
      request.mockReturnValue(of(response(broken, 200, mediaHeaders())));
      const result = await client.downloadStaffMedia(MEDIA_ID);
      expect(result).toMatchObject({ kind: 'RETRYABLE', cause: 'network' });
      expectNoPhone(result);
      expect(await files()).toEqual([]);
    });

    it('rejects an empty body and a content type the route never serves as UNEXPECTED', async () => {
      request.mockReturnValueOnce(
        of(response(bytesStream(), 200, mediaHeaders())),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 200,
        code: null,
      });
      request.mockReturnValueOnce(
        of(
          response(bytesStream(Buffer.from('x')), 200, {
            'content-type': 'text/html',
          }),
        ),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 200,
        code: null,
      });
      expect(await files()).toEqual([]);
    });

    it('maps 404 MEDIA_NOT_FOUND (stream error body) to a typed result', async () => {
      const errorBody = bytesStream(
        Buffer.from(JSON.stringify(apiError(404, 'MEDIA_NOT_FOUND'))),
      );
      request.mockReturnValue(throwError(() => httpError(404, errorBody)));
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'MEDIA_NOT_FOUND',
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('also reads a parsed JSON error body (non-stream)', async () => {
      request.mockReturnValue(
        throwError(() => httpError(404, apiError(404, 'MEDIA_NOT_FOUND'))),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'MEDIA_NOT_FOUND',
      });
    });

    it('does not read a 404 with another code as a purged file', async () => {
      request.mockReturnValue(
        throwError(() => httpError(404, bytesStream(Buffer.from('<html>')))),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 404,
        code: null,
      });
    });

    it('maps 429 with Retry-After and the auth failures', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(429, bytesStream(Buffer.from('{}')), {
            'retry-after': '9',
          }),
        ),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 9,
      });
      request.mockReturnValueOnce(
        throwError(() => httpError(401, bytesStream(Buffer.from('{}')))),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'UNAUTHORIZED',
      });
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(
            403,
            bytesStream(
              Buffer.from(JSON.stringify(apiError(403, 'INSUFFICIENT_SCOPE'))),
            ),
          ),
        ),
      );
      await expect(client.downloadStaffMedia(MEDIA_ID)).resolves.toEqual({
        kind: 'FORBIDDEN',
        code: 'INSUFFICIENT_SCOPE',
      });
    });

    it('maps 5xx and transport failures to RETRYABLE without leaking the ref', async () => {
      request.mockReturnValueOnce(
        throwError(() => httpError(503, bytesStream(Buffer.from('oops')))),
      );
      const http5xx = await client.downloadStaffMedia(MEDIA_ID);
      expect(http5xx).toMatchObject({ kind: 'RETRYABLE', cause: 'http_5xx' });
      request.mockReturnValueOnce(
        throwError(() => transportError('ECONNABORTED')),
      );
      const timeout = await client.downloadStaffMedia(MEDIA_ID);
      expect(timeout).toMatchObject({ kind: 'RETRYABLE', cause: 'timeout' });
      expectNoPhone([http5xx, timeout]);
    });

    it.each([
      ['not a uuid', 'media-1', undefined],
      ['a path traversal', '../secret', undefined],
      ['maxBytes 0', MEDIA_ID, 0],
      ['maxBytes over 10 MiB', MEDIA_ID, STAFF_MEDIA_MAX_BYTES + 1],
      ['fractional maxBytes', MEDIA_ID, 1.5],
    ])('rejects %s locally before any request', async (_n, id, maxBytes) => {
      const result = await client.downloadStaffMedia(id, { maxBytes });
      expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
    });

    it('reports a temp-file failure as LOCAL_IO_ERROR without echoing the path', async () => {
      tmpdirSpy.mockReturnValue(join(dir, 'does-not-exist'));
      request.mockReturnValue(
        of(response(bytesStream(Buffer.from('abc')), 200, mediaHeaders())),
      );
      const result = await client.downloadStaffMedia(MEDIA_ID);
      expect(result).toEqual({ kind: 'LOCAL_IO_ERROR' });
    });
  });
});

import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fsPromises, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import {
  MEDIA_MAX_BYTES,
  type MirrorMessageInput,
  type MirrorStatusInput,
} from '../domain/dtos/conversation-mirror.dto';
import { mediaIdempotencyKey } from '../domain/uuid-v5';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const PHONE = '5215512345678';
const REF = `wa:${PHONE}`;
const KEY = mediaIdempotencyKey('meta-media-1');
const MEDIA_ID = '0b3f1c1e-8a53-4d6f-9c1b-2a4e5f6a7b8c';

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const text = (n: number, id = `wamid.IN${n}`): MirrorMessageInput => ({
  waMessageId: id,
  direction: 'IN',
  type: 'TEXT',
  text: `hola ${n}`,
  providerTimestamp: iso(-2000),
  observedAt: iso(-1000),
});
const status = (n: number): MirrorStatusInput => ({
  providerMessageId: `wamid.OUT${n}`,
  status: 'DELIVERED',
  occurredAt: iso(-1000),
});

const response = (data: unknown, statusCode = 200) => ({
  data,
  status: statusCode,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
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

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('conversation mirror client (mocked HTTP)', () => {
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
  const sent = () => request.mock.calls[0][0];

  describe('mirrorMessages', () => {
    const ack = {
      accepted: [{ waMessageId: 'wamid.IN1', messageId: 'm1', seq: 1 }],
      duplicates: ['wamid.IN2'],
    };

    it('posts one batch to the URL-encoded ref with the literal :batch and only contract keys', async () => {
      request.mockReturnValue(of(response(ack)));
      const message = {
        ...text(1),
        author: 'CUSTOMER' as const,
        tenantId: 'x',
        seq: 9,
      } as MirrorMessageInput;
      await expect(client.mirrorMessages(REF, [message])).resolves.toEqual({
        kind: 'ok',
        ...ack,
      });
      expect(request).toHaveBeenCalledTimes(1);
      const config = sent();
      expect(config.method).toBe('POST');
      expect(config.url).toBe(
        `/chatbot-api/conversations/wa%3A${PHONE}/messages:batch`,
      );
      expect(config.baseURL).toBe('https://example.invalid');
      expect(config.headers).toMatchObject({
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
      });
      expect(config.headers).not.toHaveProperty('X-Idempotency-Key');
      expect(config.data).toEqual({
        messages: [
          {
            waMessageId: 'wamid.IN1',
            direction: 'IN',
            author: 'CUSTOMER',
            type: 'TEXT',
            text: 'hola 1',
            providerTimestamp: message.providerTimestamp,
            observedAt: message.observedAt,
          },
        ],
      });
    });

    it('sends media, UNSUPPORTED kind and OUT template messages', async () => {
      request.mockReturnValue(of(response({ accepted: [], duplicates: [] })));
      const base = { providerTimestamp: iso(-10), observedAt: iso(-5) };
      await client.mirrorMessages(REF, [
        {
          waMessageId: 'a',
          direction: 'IN',
          type: 'IMAGE',
          mediaId: MEDIA_ID,
          text: 'mi foto',
          ...base,
        },
        {
          waMessageId: 'b',
          direction: 'IN',
          type: 'AUDIO',
          mediaId: MEDIA_ID,
          ...base,
        },
        {
          waMessageId: 'c',
          direction: 'IN',
          type: 'UNSUPPORTED',
          kind: 'VIDEO',
          ...base,
        },
        {
          waMessageId: 'd',
          direction: 'OUT',
          type: 'TEMPLATE',
          text: 'plantilla',
          ...base,
        },
      ]);
      expect(
        (sent().data as { messages: { type: string }[] }).messages.map(
          (m) => m.type,
        ),
      ).toEqual(['IMAGE', 'AUDIO', 'UNSUPPORTED', 'TEMPLATE']);
    });

    it('accepts 50 messages and 4096 emoji, applies a bounded timeout and never retries', async () => {
      request.mockReturnValue(of(response({ accepted: [], duplicates: [] })));
      const emoji = '😀'.repeat(4096);
      const messages = Array.from({ length: 50 }, (_, i) => ({
        ...text(i),
        text: emoji,
      }));
      await expect(client.mirrorMessages(REF, messages)).resolves.toMatchObject(
        { kind: 'ok' },
      );
      expect(sent().timeout).toBeGreaterThan(0);
    });

    it.each([
      ['empty list', () => [] as MirrorMessageInput[]],
      ['duplicate waMessageId', () => [text(1, 'same'), text(2, 'same')]],
      ['bad waMessageId', () => [text(1, 'has space')]],
      ['text over 4096', () => [{ ...text(1), text: 'a'.repeat(4097) }]],
      ['blank TEXT', () => [{ ...text(1), text: '   ' }]],
      ['TEXT without text', () => [{ ...text(1), text: undefined }]],
      [
        'UNSUPPORTED with text',
        () => [{ ...text(1), type: 'UNSUPPORTED' as const }],
      ],
      ['IMAGE without mediaId', () => [{ ...text(1), type: 'IMAGE' as const }]],
      [
        'IMAGE with bad mediaId',
        () => [{ ...text(1), type: 'IMAGE' as const, mediaId: 'nope' }],
      ],
      ['TEXT with mediaId', () => [{ ...text(1), mediaId: MEDIA_ID }]],
      ['kind on TEXT', () => [{ ...text(1), kind: 'VIDEO' as const }]],
      ['TEMPLATE inbound', () => [{ ...text(1), type: 'TEMPLATE' as const }]],
      [
        'STAFF author',
        () => [
          { ...text(1), author: 'STAFF' } as unknown as MirrorMessageInput,
        ],
      ],
      ['author mismatch', () => [{ ...text(1), author: 'BOT' as const }]],
      [
        'SYSTEM type',
        () => [{ ...text(1), type: 'SYSTEM' } as unknown as MirrorMessageInput],
      ],
      [
        'bad direction',
        () => [
          { ...text(1), direction: 'SIDE' } as unknown as MirrorMessageInput,
        ],
      ],
      [
        'timestamp without zone',
        () => [{ ...text(1), providerTimestamp: '2026-11-12T10:00:00' }],
      ],
      [
        'timestamp before 2020',
        () => [{ ...text(1), observedAt: '2019-12-31T23:59:59Z' }],
      ],
      [
        'timestamp too far ahead',
        () => [{ ...text(1), providerTimestamp: iso(10 * 60_000) }],
      ],
    ])('rejects locally without a request: %s', async (_name, build) => {
      const result = await client.mirrorMessages(REF, build());
      expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
    });

    it('answers BATCH_TOO_LARGE locally over 50 so the caller splits', async () => {
      const messages = Array.from({ length: 51 }, (_, i) => text(i));
      await expect(client.mirrorMessages(REF, messages)).resolves.toEqual({
        kind: 'BATCH_TOO_LARGE',
        limit: 50,
        local: true,
      });
      expect(request).not.toHaveBeenCalled();
    });

    it.each(['', 'wa:521 55', 'wa:5215/12', 'a'.repeat(201)])(
      'rejects an out-of-contract conversationRef without echoing it (%#)',
      async (ref) => {
        const result = await client.mirrorMessages(ref, [text(1)]);
        expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
        expect(JSON.stringify(result)).not.toContain(ref || '\u0000');
        expect(request).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        400,
        apiError(400, 'VALIDATION_ERROR', { message: 'bad body' }),
        { kind: 'VALIDATION_ERROR', message: 'bad body', local: false },
      ],
      [401, apiError(401, 'UNAUTHORIZED'), { kind: 'UNAUTHORIZED' }],
      [
        403,
        apiError(403, 'INSUFFICIENT_SCOPE'),
        { kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' },
      ],
      [
        403,
        apiError(403, 'FORBIDDEN'),
        { kind: 'FORBIDDEN', code: 'FORBIDDEN' },
      ],
      [
        409,
        apiError(409, 'MESSAGE_ID_CONFLICT'),
        { kind: 'MESSAGE_ID_CONFLICT' },
      ],
      [
        413,
        apiError(413, 'BATCH_TOO_LARGE', { limit: 50 }),
        { kind: 'BATCH_TOO_LARGE', limit: 50, local: false },
      ],
      [413, apiError(413, 'BODY_TOO_LARGE'), { kind: 'BODY_TOO_LARGE' }],
      [422, apiError(422, 'MEDIA_NOT_FOUND'), { kind: 'MEDIA_NOT_FOUND' }],
      [
        422,
        apiError(422, 'MEDIA_TYPE_MISMATCH'),
        { kind: 'MEDIA_TYPE_MISMATCH' },
      ],
      [
        500,
        apiError(500, 'INTERNAL'),
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 500,
          retryAfterSeconds: null,
        },
      ],
      [
        503,
        {},
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 503,
          retryAfterSeconds: null,
        },
      ],
      [
        404,
        apiError(404, 'NOPE'),
        { kind: 'UNEXPECTED', status: 404, code: 'NOPE' },
      ],
      [
        409,
        apiError(409, 'OTHER'),
        { kind: 'UNEXPECTED', status: 409, code: 'OTHER' },
      ],
    ])('maps HTTP %i %j', async (statusCode, body, expected) => {
      request.mockReturnValue(throwError(() => httpError(statusCode, body)));
      await expect(client.mirrorMessages(REF, [text(1)])).resolves.toEqual(
        expected,
      );
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('parses Retry-After seconds on 429 (and null when absent)', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(429, apiError(429, 'RATE_LIMITED'), {
            'retry-after': '17',
          }),
        ),
      );
      await expect(client.mirrorMessages(REF, [text(1)])).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 17,
      });
      request.mockReturnValueOnce(
        throwError(() => httpError(429, apiError(429, 'RATE_LIMITED'))),
      );
      await expect(client.mirrorMessages(REF, [text(1)])).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: null,
      });
    });

    it('treats timeouts and network failures as retryable without throwing', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          Object.assign(new Error(`timeout calling ${REF}`), {
            code: 'ECONNABORTED',
          }),
        ),
      );
      await expect(client.mirrorMessages(REF, [text(1)])).resolves.toEqual({
        kind: 'RETRYABLE',
        cause: 'timeout',
        status: null,
        retryAfterSeconds: null,
      });
      request.mockReturnValueOnce(
        throwError(() =>
          Object.assign(new Error(`connect ECONNREFUSED ${REF}`), {
            code: 'ECONNREFUSED',
          }),
        ),
      );
      await expect(client.mirrorMessages(REF, [text(1)])).resolves.toEqual({
        kind: 'RETRYABLE',
        cause: 'network',
        status: null,
        retryAfterSeconds: null,
      });
    });

    it('reports a malformed 200 body as UNEXPECTED instead of acking', async () => {
      request.mockReturnValue(of(response({ accepted: 'nope' })));
      await expect(client.mirrorMessages(REF, [text(1)])).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 200,
        code: null,
      });
    });

    it('never leaks the conversationRef or phone in any result', async () => {
      const outcomes = [
        throwError(() => httpError(400, apiError(400, 'VALIDATION_ERROR'))),
        throwError(() => httpError(500)),
        throwError(() =>
          Object.assign(new Error(`x ${REF}`), { code: 'ETIMEDOUT' }),
        ),
        throwError(() => httpError(404, {})),
      ];
      for (const outcome of outcomes) {
        request.mockReturnValueOnce(outcome);
        const result = await client.mirrorMessages(REF, [text(1)]);
        expect(JSON.stringify(result)).not.toContain(PHONE);
      }
    });
  });

  describe('recordMessageStatuses', () => {
    it('posts one statuses batch with contract keys only', async () => {
      request.mockReturnValue(
        of(response({ applied: 1, ignored: 1, unknown: ['wamid.X'] })),
      );
      const input = {
        ...status(1),
        errorCode: '131047',
        extra: 1,
      } as MirrorStatusInput;
      await expect(client.recordMessageStatuses([input])).resolves.toEqual({
        kind: 'ok',
        applied: 1,
        ignored: 1,
        unknown: ['wamid.X'],
      });
      expect(sent().method).toBe('POST');
      expect(sent().url).toBe('/chatbot-api/messages/statuses:batch');
      expect(sent().data).toEqual({
        statuses: [
          {
            providerMessageId: 'wamid.OUT1',
            status: 'DELIVERED',
            occurredAt: input.occurredAt,
            errorCode: '131047',
          },
        ],
      });
    });

    it('accepts 100 statuses and answers BATCH_TOO_LARGE locally over 100', async () => {
      request.mockReturnValue(
        of(response({ applied: 0, ignored: 0, unknown: [] })),
      );
      await expect(
        client.recordMessageStatuses(
          Array.from({ length: 100 }, (_, i) => status(i)),
        ),
      ).resolves.toMatchObject({ kind: 'ok' });
      await expect(
        client.recordMessageStatuses(
          Array.from({ length: 101 }, (_, i) => status(i)),
        ),
      ).resolves.toEqual({ kind: 'BATCH_TOO_LARGE', limit: 100, local: true });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['empty', () => [] as MirrorStatusInput[]],
      [
        'QUEUED status',
        () => [
          { ...status(1), status: 'QUEUED' } as unknown as MirrorStatusInput,
        ],
      ],
      ['bad id', () => [{ ...status(1), providerMessageId: 'a b' }]],
      [
        'errorCode over 64',
        () => [{ ...status(1), errorCode: 'e'.repeat(65) }],
      ],
      [
        'occurredAt missing zone',
        () => [{ ...status(1), occurredAt: '2026-11-12T10:00:00' }],
      ],
      [
        'occurredAt in the future',
        () => [{ ...status(1), occurredAt: iso(3_600_000) }],
      ],
    ])('rejects locally without a request: %s', async (_name, build) => {
      await expect(
        client.recordMessageStatuses(build()),
      ).resolves.toMatchObject({
        kind: 'VALIDATION_ERROR',
        local: true,
      });
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      [
        400,
        apiError(400, 'VALIDATION_ERROR'),
        { kind: 'VALIDATION_ERROR', message: 'fixed text', local: false },
      ],
      [401, apiError(401, 'UNAUTHORIZED'), { kind: 'UNAUTHORIZED' }],
      [
        403,
        apiError(403, 'INSUFFICIENT_SCOPE'),
        { kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' },
      ],
      [
        413,
        apiError(413, 'BATCH_TOO_LARGE', { limit: 100 }),
        { kind: 'BATCH_TOO_LARGE', limit: 100, local: false },
      ],
      [
        502,
        {},
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 502,
          retryAfterSeconds: null,
        },
      ],
    ])('maps HTTP %i', async (statusCode, body, expected) => {
      request.mockReturnValue(throwError(() => httpError(statusCode, body)));
      await expect(client.recordMessageStatuses([status(1)])).resolves.toEqual(
        expected,
      );
    });

    it('maps 429 with Retry-After and a malformed 200', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(429, apiError(429, 'RATE_LIMITED'), { 'retry-after': '5' }),
        ),
      );
      await expect(client.recordMessageStatuses([status(1)])).resolves.toEqual({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 5,
      });
      request.mockReturnValueOnce(of(response({ applied: 1 })));
      await expect(client.recordMessageStatuses([status(1)])).resolves.toEqual({
        kind: 'UNEXPECTED',
        status: 200,
        code: null,
      });
    });

    it('treats a timeout as retryable', async () => {
      request.mockReturnValue(
        throwError(() => Object.assign(new Error('t'), { code: 'ETIMEDOUT' })),
      );
      await expect(
        client.recordMessageStatuses([status(1)]),
      ).resolves.toMatchObject({
        kind: 'RETRYABLE',
        cause: 'timeout',
      });
    });
  });

  describe('uploadMedia', () => {
    const uploaded = {
      mediaId: MEDIA_ID,
      mimeType: 'image/jpeg',
      sizeBytes: 5,
      sha256: 'ab'.repeat(32),
    };
    const stream = (...chunks: string[]) =>
      Readable.from(chunks.map((c) => Buffer.from(c)));

    it('streams a multipart body with one file part, the sha256 field, the key header and a bounded timeout', async () => {
      request.mockReturnValue(of(response(uploaded, 201)));
      const sha = createHash('sha256').update('helloworld').digest('hex');
      await expect(
        client.uploadMedia({
          stream: stream('hello', 'world'),
          sizeBytes: 10,
          filename: 'foto "x".jpg',
          sha256: sha,
          idempotencyKey: KEY,
        }),
      ).resolves.toEqual({ kind: 'ok', created: true, ...uploaded });
      expect(request).toHaveBeenCalledTimes(1);
      const config = sent();
      expect(config.method).toBe('POST');
      expect(config.url).toBe('/chatbot-api/media');
      expect(config.headers).toMatchObject({
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
        'X-Idempotency-Key': KEY,
      });
      expect(config.timeout).toBeGreaterThan(10_000);
      expect(config.maxRedirects).toBe(0);
      // S1: a stream is handed to the transport, never a buffered body.
      expect(config.data).toBeInstanceOf(Readable);
      const headers = config.headers as Record<string, string | number>;
      const contentType = String(headers['Content-Type']);
      expect(contentType).toMatch(/^multipart\/form-data; boundary=\S+$/);
      const body = await drain(config.data as Readable);
      expect(Number(headers['Content-Length'])).toBe(body.length);
      const boundary = contentType.split('boundary=')[1];
      const raw = body.toString('latin1');
      expect(raw.match(/name="file"/g)).toHaveLength(1);
      expect(raw.match(/Content-Disposition/g)).toHaveLength(2);
      expect(raw).toContain(`name="sha256"\r\n\r\n${sha}\r\n`);
      expect(raw).toContain('filename="foto _x_.jpg"');
      expect(raw).toContain('\r\n\r\nhelloworld\r\n');
      expect(raw.endsWith(`--${boundary}--\r\n`)).toBe(true);
    });

    it('omits Content-Length for a stream of unknown size and the sha256 part when not given', async () => {
      request.mockReturnValue(of(response(uploaded, 200)));
      await expect(
        client.uploadMedia({ stream: stream('abc'), idempotencyKey: KEY }),
      ).resolves.toEqual({ kind: 'ok', created: false, ...uploaded });
      expect(sent().headers).not.toHaveProperty('Content-Length');
      const raw = (await drain(sent().data as Readable)).toString('latin1');
      expect(raw).not.toContain('name="sha256"');
      expect(raw).toContain('filename="media"');
    });

    it('streams a file path from disk (a Readable, sized by stat, never read whole)', async () => {
      request.mockReturnValue(of(response(uploaded, 201)));
      const path = join(__dirname, '../../../package.json');
      const bytes = readFileSync(path);
      const readFileSpy = jest.spyOn(fsPromises, 'readFile');
      await client.uploadMedia({ filePath: path, idempotencyKey: KEY });
      expect(readFileSpy).not.toHaveBeenCalled();
      const config = sent();
      expect(config.data).toBeInstanceOf(Readable);
      const body = await drain(config.data as Readable);
      expect(
        Number((config.headers as Record<string, unknown>)['Content-Length']),
      ).toBe(body.length);
      expect(body.includes(bytes)).toBe(true);
      readFileSpy.mockRestore();
    });

    it('rejects a missing file path locally without echoing it', async () => {
      const result = await client.uploadMedia({
        filePath: `/nonexistent/${PHONE}.jpg`,
        idempotencyKey: KEY,
      });
      expect(result).toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(JSON.stringify(result)).not.toContain(PHONE);
      expect(request).not.toHaveBeenCalled();
    });

    it('answers MEDIA_TOO_LARGE locally when stat reports over 10 MiB', async () => {
      const statSpy = jest.spyOn(fsPromises, 'stat').mockResolvedValue({
        size: MEDIA_MAX_BYTES + 1,
        isFile: () => true,
      } as never);
      await expect(
        client.uploadMedia({ filePath: 'big.bin', idempotencyKey: KEY }),
      ).resolves.toEqual({ kind: 'MEDIA_TOO_LARGE', local: true });
      statSpy.mockRestore();
      expect(request).not.toHaveBeenCalled();
    });

    it('answers MEDIA_TOO_LARGE locally for a declared oversize stream and aborts a lying one mid-stream', async () => {
      await expect(
        client.uploadMedia({
          stream: stream('x'),
          sizeBytes: MEDIA_MAX_BYTES + 1,
          idempotencyKey: KEY,
        }),
      ).resolves.toEqual({ kind: 'MEDIA_TOO_LARGE', local: true });
      expect(request).not.toHaveBeenCalled();

      let pulled = 0;
      const endless = new Readable({
        read() {
          pulled += 1;
          this.push(Buffer.alloc(1024 * 1024));
        },
      });
      request.mockImplementation((config) =>
        throwError(() => {
          // The transport consumes the body; the cap error surfaces there.
          void drain(config.data as Readable).catch(() => undefined);
          return Object.assign(new Error('aborted'), { code: 'ERR_STREAM' });
        }),
      );
      const result = client.uploadMedia({
        stream: endless,
        idempotencyKey: KEY,
      });
      await expect(result).resolves.toBeDefined();
      expect(pulled).toBeLessThan(40);
    });

    it.each([
      ['empty key', ''],
      ['uppercase key', KEY.toUpperCase()],
      ['not a uuid', 'media-1'],
    ])('rejects a bad idempotency key locally: %s', async (_name, key) => {
      await expect(
        client.uploadMedia({ stream: stream('a'), idempotencyKey: key }),
      ).resolves.toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      ['neither source', {}],
      ['both sources', { filePath: 'a', stream: Readable.from([]) }],
      ['malformed sha256', { stream: Readable.from([]), sha256: 'ABC' }],
      ['empty sized stream', { stream: Readable.from([]), sizeBytes: 0 }],
    ])('rejects locally: %s', async (_name, extra) => {
      await expect(
        client.uploadMedia({ idempotencyKey: KEY, ...extra }),
      ).resolves.toMatchObject({ kind: 'VALIDATION_ERROR', local: true });
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      [
        400,
        apiError(400, 'VALIDATION_ERROR', { message: 'sha256 mismatch' }),
        {
          kind: 'VALIDATION_ERROR',
          message: 'sha256 mismatch',
          local: false,
          shaSent: true,
        },
      ],
      [401, apiError(401, 'UNAUTHORIZED'), { kind: 'UNAUTHORIZED' }],
      [
        403,
        apiError(403, 'INSUFFICIENT_SCOPE'),
        { kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' },
      ],
      [
        409,
        apiError(409, 'IDEMPOTENCY_CONFLICT'),
        { kind: 'IDEMPOTENCY_CONFLICT' },
      ],
      [
        413,
        apiError(413, 'MEDIA_TOO_LARGE'),
        { kind: 'MEDIA_TOO_LARGE', local: false },
      ],
      [
        415,
        apiError(415, 'MEDIA_TYPE_NOT_ALLOWED'),
        { kind: 'MEDIA_TYPE_NOT_ALLOWED' },
      ],
      [
        500,
        {},
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 500,
          retryAfterSeconds: null,
        },
      ],
      [
        418,
        apiError(418, 'TEAPOT'),
        { kind: 'UNEXPECTED', status: 418, code: 'TEAPOT' },
      ],
    ])('maps HTTP %i', async (statusCode, body, expected) => {
      request.mockReturnValue(throwError(() => httpError(statusCode, body)));
      await expect(
        client.uploadMedia({
          stream: stream('a'),
          sha256: 'cd'.repeat(32),
          idempotencyKey: KEY,
        }),
      ).resolves.toEqual(expected);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('maps 503 MEDIA_STORAGE_FAILED with its Retry-After, and 429 with Retry-After', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(503, apiError(503, 'MEDIA_STORAGE_FAILED'), {
            'retry-after': '5',
          }),
        ),
      );
      await expect(
        client.uploadMedia({ stream: stream('a'), idempotencyKey: KEY }),
      ).resolves.toEqual({
        kind: 'MEDIA_STORAGE_FAILED',
        retryAfterSeconds: 5,
      });
      request.mockReturnValueOnce(
        throwError(() =>
          httpError(429, apiError(429, 'RATE_LIMITED'), {
            'retry-after': '30',
          }),
        ),
      );
      await expect(
        client.uploadMedia({ stream: stream('a'), idempotencyKey: KEY }),
      ).resolves.toEqual({ kind: 'RATE_LIMITED', retryAfterSeconds: 30 });
    });

    it('marks a 400 without a sha256 as not a sha mismatch', async () => {
      request.mockReturnValue(
        throwError(() => httpError(400, apiError(400, 'VALIDATION_ERROR'))),
      );
      await expect(
        client.uploadMedia({ stream: stream('a'), idempotencyKey: KEY }),
      ).resolves.toMatchObject({ kind: 'VALIDATION_ERROR', shaSent: false });
    });

    it('treats timeouts as retryable and a malformed 201 as UNEXPECTED', async () => {
      request.mockReturnValueOnce(
        throwError(() =>
          Object.assign(new Error('t'), { code: 'ECONNABORTED' }),
        ),
      );
      await expect(
        client.uploadMedia({ stream: stream('a'), idempotencyKey: KEY }),
      ).resolves.toMatchObject({ kind: 'RETRYABLE', cause: 'timeout' });
      request.mockReturnValueOnce(of(response({ mediaId: 1 }, 201)));
      await expect(
        client.uploadMedia({ stream: stream('a'), idempotencyKey: KEY }),
      ).resolves.toEqual({ kind: 'UNEXPECTED', status: 201, code: null });
    });
  });
});

describe('uploadMedia over a real HTTP socket', () => {
  let server: Server;
  let captured: { headers: Record<string, unknown>; body: Buffer } | null;
  let client: ChatbotApiHttpClient;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        captured = { headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            mediaId: MEDIA_ID,
            mimeType: 'application/pdf',
            sizeBytes: captured.body.length,
            sha256: 'ab'.repeat(32),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    client = new ChatbotApiHttpClient(
      new HttpService(),
      new ConfigService({
        chatbotApi: {
          baseUrl: `http://127.0.0.1:${port}`,
          serviceKey: 'svc_test',
          branchId: 'branch',
        },
      }),
      jest.fn().mockResolvedValue(undefined),
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ['filePath', 'file'],
    ['stream without a size (chunked)', 'stream'],
  ])(
    'delivers the exact bytes as a single file part: %s',
    async (_name, mode) => {
      captured = null;
      const path = join(__dirname, '../../../package.json');
      const bytes = readFileSync(path);
      const result = await client.uploadMedia(
        mode === 'file'
          ? { filePath: path, idempotencyKey: KEY }
          : { stream: Readable.from([bytes]), idempotencyKey: KEY },
      );
      expect(result).toMatchObject({
        kind: 'ok',
        created: true,
        mediaId: MEDIA_ID,
      });
      expect(captured).not.toBeNull();
      const { headers, body } = captured!;
      expect(headers['x-idempotency-key']).toBe(KEY);
      expect(headers['content-type']).toMatch(
        /^multipart\/form-data; boundary=/,
      );
      const raw = body.toString('latin1');
      expect(raw.match(/name="file"/g)).toHaveLength(1);
      expect(body.includes(bytes)).toBe(true);
    },
  );
});

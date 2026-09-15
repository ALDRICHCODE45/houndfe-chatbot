/** WU6D2/WU6E1 capability metadata+stream controller tests (design "Reviewer
 *  access"): an isolated Nest/Supertest module proves the transport mapping of
 *  the WU6D1 closed authorization result for HEAD plus the WU6E1 GET streaming
 *  (exact bytes, safe headers, Range, disconnect, post-header stream failure)
 *  and abort/suppression/listener paths; the authorization matrix itself is
 *  WU6D1-owned. Local mocks only. */
import { PassThrough, Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CapabilityService } from '../application/capability.service';
import { ReceiptCapabilityAuthorizerService } from '../application/receipt-capability-authorizer.service';
import {
  OBJECT_STORAGE_PORT,
  ObjectStorageError,
  type ObjectStoragePort,
} from '../domain/object-storage.port';
import {
  CAPABILITY_RETRY_AFTER_SECONDS as RETRY,
  ReceiptMediaAccessController,
} from './receipt-media-access.controller';

const KEY = Buffer.alloc(32, 7);
const UUID = '00000000-0000-4000-8000-000000000000';
const OBJECT_KEY = `receipts/${UUID}`;
const ISSUER = new CapabilityService(new Map([['1', KEY]]), '1');
const VALID_TOKEN = ISSUER.issue(UUID).token;
const NOT_FOUND = new ObjectStorageError('OBJECT_STORAGE', 'OBJECT_NOT_FOUND');
const NETWORK_FAILURE = new ObjectStorageError(
  'OBJECT_STORAGE',
  'NETWORK_FAILURE',
);
const AUTHORIZED = { kind: 'authorized', objectKey: OBJECT_KEY };
const META = {
  byteCount: 1234,
  mimeType: 'image/jpeg',
  etag: 'etag-value',
  versionId: 'ver-value',
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const GET_STREAM = (mime: string, bytes: Buffer) => ({
  stream: Readable.from([bytes]),
  byteCount: bytes.length,
  mimeType: mime,
  etag: 'etag-value',
  versionId: 'ver-value',
});
const SAFE_HEADERS = {
  'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
  'cross-origin-resource-policy': 'cross-origin',
};

const buildApp = async () => {
  const authorizer = { authorize: jest.fn() };
  const storage = { head: jest.fn(), getStream: jest.fn() };
  const responses: Response[] = [];
  const moduleRef = await Test.createTestingModule({
    controllers: [ReceiptMediaAccessController],
    providers: [
      { provide: ReceiptCapabilityAuthorizerService, useValue: authorizer },
      { provide: OBJECT_STORAGE_PORT, useValue: storage },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  // Captures live server responses for streaming-lifecycle assertions.
  app.use((_req: unknown, res: Response, next: () => void) => {
    responses.push(res);
    next();
  });
  await app.init();
  return { app, authorizer, storage, responses };
};

type Harness = Awaited<ReturnType<typeof buildApp>>;
type HeadCall = { key?: string; abortSignal: AbortSignal };
type GetCall = { key?: string; abortSignal: AbortSignal };

const unavailableAuth = (h: Harness) =>
  h.authorizer.authorize.mockResolvedValue({ kind: 'unavailable' });
const rejectingAuth = (h: Harness) =>
  h.authorizer.authorize.mockRejectedValue(new Error('SECRET_DB_DETAIL'));
const failStorage = (error: unknown) => (h: Harness) =>
  h.storage.head.mockRejectedValue(error);
const failGetStream = (error: unknown) => (h: Harness) =>
  h.storage.getStream.mockRejectedValue(error);

const denialShape = (res: request.Response) => ({
  status: res.status,
  body: res.text ?? '',
  csp: res.headers['content-security-policy'],
  nosniff: res.headers['x-content-type-options'],
  referrer: res.headers['referrer-policy'],
  cacheControl: res.headers['cache-control'],
  corp: res.headers['cross-origin-resource-policy'],
});

describe('ReceiptMediaAccessController (WU6D2 HEAD-only)', () => {
  let harness: Harness;

  beforeEach(async () => (harness = await buildApp()));
  afterEach(async () => harness.app.close());

  const admit = (head: Record<string, unknown> = META): void => {
    harness.authorizer.authorize.mockResolvedValue(AUTHORIZED);
    harness.storage.head.mockResolvedValue(head);
  };

  const admitGet = (mime = 'image/jpeg', bytes: Buffer = JPEG): void => {
    harness.authorizer.authorize.mockResolvedValue(AUTHORIZED);
    harness.storage.getStream.mockResolvedValue(GET_STREAM(mime, bytes));
  };

  const headUrl = (token = VALID_TOKEN, headers: Record<string, string> = {}) =>
    request(harness.app.getHttpServer() as App)
      .head(`/media/receipts/${token}`)
      .set(headers);

  const getUrl = (token = VALID_TOKEN, headers: Record<string, string> = {}) =>
    request(harness.app.getHttpServer() as App)
      .get(`/media/receipts/${token}`)
      .set(headers);

  const makeRes = () => {
    const listeners: Array<() => void> = [];
    const res = {
      once: jest.fn((_ev: string, fn: () => void) => listeners.push(fn)),
      off: jest.fn(),
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
      emitClose: (): void => listeners.forEach((fn) => fn()),
    };
    return { res, listeners };
  };

  const callDirect = async (
    method: 'head' | 'get',
    token: string,
    res: ReturnType<typeof makeRes>['res'],
  ) => {
    const controller = new ReceiptMediaAccessController(
      harness.authorizer as unknown as ReceiptCapabilityAuthorizerService,
      harness.storage as unknown as ObjectStoragePort,
    );
    if (method === 'get')
      await controller.get({ headers: {} } as never, res as never, token);
    else await controller.head({ headers: {} } as never, res as never, token);
    return res;
  };

  it.each<[string, string, Buffer]>([
    ['image/jpeg', 'receipt.jpg', JPEG],
    ['image/png', 'receipt.png', PNG],
  ])(
    'GET %s streams the exact bytes with the safe headers',
    async (mime, name, bytes) => {
      admitGet(mime, bytes);
      const res = await getUrl();
      expect(res.status).toBe(200);
      expect(res.body).toEqual(bytes);
      expect(res.headers).toMatchObject({
        ...SAFE_HEADERS,
        'content-type': mime,
        'content-length': String(bytes.length),
        'content-disposition': `inline; filename="${name}"`,
      });
      expect(res.headers.etag).toBeUndefined();
      expect(harness.authorizer.authorize).toHaveBeenCalledWith(VALID_TOKEN);
      expect(harness.storage.getStream).toHaveBeenCalledTimes(1);
      const call = (
        harness.storage.getStream.mock.calls as [GetCall][]
      )[0]?.[0];
      expect(call?.key).toBe(OBJECT_KEY);
      expect(call?.abortSignal).toBeInstanceOf(AbortSignal);
    },
  );

  it.each([
    ['image/jpeg', 'receipt.jpg'],
    ['image/png', 'receipt.png'],
  ])('HEAD %s returns the exact safe metadata headers', async (mime, name) => {
    admit({ ...META, mimeType: mime });
    const res = await headUrl();
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      ...SAFE_HEADERS,
      'content-type': mime,
      'content-length': '1234',
      'content-disposition': `inline; filename="${name}"`,
    });
    expect(res.headers.etag).toBeUndefined();
    expect(res.text ?? '').toBe('');
    expect(harness.authorizer.authorize).toHaveBeenCalledWith(VALID_TOKEN);
    expect(harness.storage.head).toHaveBeenCalledTimes(1);
    const call = (harness.storage.head.mock.calls as [HeadCall][])[0]?.[0];
    expect(call?.key).toBe(OBJECT_KEY);
    expect(call?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('authorization precedes Range: a denial with Range is 404, not 416', async () => {
    admit();
    harness.authorizer.authorize.mockResolvedValue({ kind: 'denied' });
    const res = await headUrl(VALID_TOKEN, { range: 'bytes=0-' });
    expect(res.status).toBe(404);
    expect(res.text ?? '').toBe('');
    expect(res.headers['retry-after']).toBeUndefined();
    expect(harness.storage.head).not.toHaveBeenCalled();
  });

  it('gives a denial and a missing object one indistinguishable empty 404', async () => {
    admit();
    harness.authorizer.authorize.mockResolvedValue({ kind: 'denied' });
    const denied = denialShape(await headUrl());
    harness.authorizer.authorize.mockResolvedValue(AUTHORIZED);
    harness.storage.head.mockRejectedValue(NOT_FOUND);
    expect(denied).toEqual(denialShape(await headUrl()));
  });

  it('GET gives a denial and a missing object one indistinguishable empty 404', async () => {
    admitGet();
    harness.authorizer.authorize.mockResolvedValue({ kind: 'denied' });
    const denied = denialShape(await getUrl());
    expect(denied).toEqual(denialShape(await headUrl()));
    harness.authorizer.authorize.mockResolvedValue(AUTHORIZED);
    harness.storage.getStream.mockRejectedValue(NOT_FOUND);
    expect(denied).toEqual(denialShape(await getUrl()));
    expect(harness.storage.getStream).toHaveBeenCalledTimes(1);
  });

  it('denied GET with Range is 404, not 416, with no getStream call', async () => {
    admitGet();
    harness.authorizer.authorize.mockResolvedValue({ kind: 'denied' });
    const res = await getUrl(VALID_TOKEN, { range: 'bytes=0-' });
    expect(res.status).toBe(404);
    expect(res.text ?? '').toBe('');
    expect(res.headers['retry-after']).toBeUndefined();
    expect(harness.storage.getStream).not.toHaveBeenCalled();
  });

  it('returns 416 for an authorized GET Range without any getStream call', async () => {
    admitGet();
    const res = await getUrl(VALID_TOKEN, { range: 'bytes=0-' });
    expect(res.status).toBe(416);
    expect(res.text ?? '').toBe('');
    expect(harness.storage.getStream).not.toHaveBeenCalled();
  });

  it.each([
    ['closed unavailable result', unavailableAuth, false],
    ['unexpected authorizer rejection', rejectingAuth, false],
    ['provider storage failure', failStorage(NETWORK_FAILURE), true],
    ['generic storage failure', failStorage(new Error('boom')), true],
  ])(
    'a %s returns the empty 503 with the fixed Retry-After',
    async (_l, drive, touches) => {
      admit();
      drive(harness);
      const res = await headUrl();
      expect(res.status).toBe(503);
      expect(res.text ?? '').toBe('');
      expect(res.headers['retry-after']).toBe(String(RETRY));
      expect(res.headers.etag).toBeUndefined();
      if (!touches) expect(harness.storage.head).not.toHaveBeenCalled();
      expect(JSON.stringify(res.headers) + res.text).not.toContain(
        'SECRET_DB_DETAIL',
      );
    },
  );

  it('returns 416 for an authorized Range without any storage call', async () => {
    admit();
    const res = await headUrl(VALID_TOKEN, { range: 'bytes=0-' });
    expect(res.status).toBe(416);
    expect(res.text ?? '').toBe('');
    expect(harness.storage.head).not.toHaveBeenCalled();
  });

  it.each([
    ['closed unavailable result', unavailableAuth, false],
    ['unexpected authorizer rejection', rejectingAuth, false],
    ['getStream provider failure', failGetStream(NETWORK_FAILURE), true],
    ['generic getStream failure', failGetStream(new Error('boom')), true],
  ])(
    'GET a %s returns the empty 503 with the fixed Retry-After',
    async (_l, drive, touches) => {
      admitGet();
      drive(harness);
      const res = await getUrl();
      expect(res.status).toBe(503);
      expect(res.text ?? '').toBe('');
      expect(res.headers['retry-after']).toBe(String(RETRY));
      expect(res.headers.etag).toBeUndefined();
      if (!touches) expect(harness.storage.getStream).not.toHaveBeenCalled();
      expect(JSON.stringify(res.headers) + res.text).not.toContain(
        'SECRET_DB_DETAIL',
      );
    },
  );

  it('carries no token, object, or provider detail on failure responses', async () => {
    admit();
    harness.storage.head.mockRejectedValue(NETWORK_FAILURE);
    const unavailable = await headUrl();
    harness.authorizer.authorize.mockResolvedValue({ kind: 'denied' });
    const denied = await headUrl();
    const secrets = [VALID_TOKEN.toLowerCase(), OBJECT_KEY];
    for (const res of [unavailable, denied]) {
      expect(res.text ?? '').toBe('');
      const headers = JSON.stringify(res.headers).toLowerCase();
      for (const secret of [...secrets, 'etag-value', 'ver-value']) {
        expect(headers).not.toContain(secret);
      }
    }
  });

  it('disconnect during authorization resolution suppresses storage/response', async () => {
    admit();
    let settle: (value: unknown) => void = () => {};
    harness.authorizer.authorize.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { res, listeners } = makeRes();
    const pending = callDirect('head', VALID_TOKEN, res);
    await new Promise(setImmediate);
    res.emitClose();
    settle(AUTHORIZED);
    await pending;
    expect(harness.storage.head).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(res.off).toHaveBeenCalledWith('close', listeners[0]);
  });

  it('disconnect during an authorizer rejection suppresses storage/response', async () => {
    admit();
    let rejectAuth: (error: unknown) => void = () => {};
    harness.authorizer.authorize.mockImplementation(
      () => new Promise((_resolve, reject) => (rejectAuth = reject)),
    );
    const { res, listeners } = makeRes();
    const pending = callDirect('head', VALID_TOKEN, res);
    await new Promise(setImmediate);
    res.emitClose();
    rejectAuth(new Error('late rejection'));
    await pending;
    expect(harness.storage.head).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(res.off).toHaveBeenCalledWith('close', listeners[0]);
  });

  it('disconnect aborts the exact storage signal and removes the listener', async () => {
    admit();
    let settle: (value: unknown) => void = () => {};
    harness.storage.head.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { res, listeners } = makeRes();
    const pending = callDirect('head', VALID_TOKEN, res);
    await new Promise(setImmediate);
    const [args] = harness.storage.head.mock.calls as [HeadCall][];
    const signal = args?.[0]?.abortSignal;
    res.emitClose();
    expect(signal?.aborted).toBe(true);
    settle({ ...META, versionId: null });
    await pending;
    expect(res.end).not.toHaveBeenCalled();
    expect(res.off).toHaveBeenCalledWith('close', listeners[0]);
  });

  it('removes the close listener after a successful response', async () => {
    admit();
    const { res, listeners } = makeRes();
    await callDirect('head', VALID_TOKEN, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.off).toHaveBeenCalledWith('close', listeners[0]);
  });

  it('GET: disconnect during authorization suppresses getStream/response', async () => {
    admitGet();
    let settle: (value: unknown) => void = () => {};
    harness.authorizer.authorize.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { res, listeners } = makeRes();
    const pending = callDirect('get', VALID_TOKEN, res);
    await new Promise(setImmediate);
    res.emitClose();
    settle(AUTHORIZED);
    await pending;
    expect(harness.storage.getStream).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(res.off).toHaveBeenCalledWith('close', listeners[0]);
  });

  it('GET: disconnect during getStream aborts the exact signal and suppresses', async () => {
    admitGet();
    let settle: (value: unknown) => void = () => {};
    harness.storage.getStream.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { res, listeners } = makeRes();
    const pending = callDirect('get', VALID_TOKEN, res);
    await new Promise(setImmediate);
    const [args] = harness.storage.getStream.mock.calls as [GetCall][];
    res.emitClose();
    expect(args?.[0]?.abortSignal.aborted).toBe(true);
    settle(GET_STREAM('image/jpeg', JPEG));
    await pending;
    expect(res.end).not.toHaveBeenCalled();
    expect(res.off).toHaveBeenCalledWith('close', listeners[0]);
  });

  it('disconnect while GET streaming aborts the signal and destroys the stream', async () => {
    admitGet();
    const stream = new PassThrough();
    harness.storage.getStream.mockResolvedValue({
      ...GET_STREAM('image/jpeg', JPEG),
      stream,
    });
    const client = getUrl();
    const pending = expect(client).rejects.toThrow();
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    client.abort();
    await pending;
    // Waits for the controller's abort-driven destroy; jest fails the
    // test at its timeout if the lifecycle never settles.
    await new Promise((resolve) => stream.once('close', resolve));
    const [args] = harness.storage.getStream.mock.calls as [GetCall][];
    expect(args?.[0]?.abortSignal.aborted).toBe(true);
    expect(stream.destroyed).toBe(true);
    expect(harness.responses.at(-1)?.listenerCount('close')).toBe(0);
  });

  it('post-header async GET stream failure destroys the response without a 503', async () => {
    admitGet();
    const stream = new PassThrough();
    harness.storage.getStream.mockResolvedValue({
      ...GET_STREAM('image/jpeg', JPEG),
      stream,
    });
    const pending = expect(getUrl()).rejects.toThrow();
    await new Promise(setImmediate);
    stream.write('abc');
    await new Promise(setImmediate);
    stream.destroy(new Error('late stream failure'));
    await pending;
    const res = harness.responses.at(-1);
    expect(res?.headersSent).toBe(true);
    expect(res?.destroyed).toBe(true);
    expect(res?.getHeader('retry-after')).toBeUndefined();
  });

  it('pre-header acquired-stream error returns a clean empty 503 and cleans up', async () => {
    admitGet();
    const stream = new PassThrough();
    let settleGet: (value: unknown) => void = () => {};
    harness.storage.getStream.mockImplementation(
      () => new Promise((resolve) => (settleGet = resolve)),
    );
    const pending = Promise.resolve(getUrl());
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    settleGet({ ...GET_STREAM('image/jpeg', JPEG), stream });
    await new Promise(setImmediate);
    const live = harness.responses.at(-1);
    const offSpy = live ? jest.spyOn(live, 'off') : null;
    stream.destroy(new Error('pre-header acquired-stream failure'));
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.text ?? '').toBe('');
    expect(res.headers['retry-after']).toBe(String(RETRY));
    expect(res.headers['content-type']).toBeUndefined();
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['content-length']).toBe('0');
    const headers = JSON.stringify(res.headers).toLowerCase();
    for (const secret of [VALID_TOKEN.toLowerCase(), OBJECT_KEY])
      expect(headers).not.toContain(secret);
    for (const name of ['"etag"', 'etag-value', 'ver-value'])
      expect(headers).not.toContain(name);
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
    expect(offSpy).toHaveBeenCalledWith('close', expect.any(Function));
  });
});

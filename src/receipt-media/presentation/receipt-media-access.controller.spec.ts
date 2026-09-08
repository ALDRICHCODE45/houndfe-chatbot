/** WU6D2 HEAD-only capability metadata controller tests (design "Reviewer
 *  access"): an isolated Nest/Supertest module proves the transport mapping of
 *  the WU6D1 closed authorization result plus abort/suppression/listener
 *  paths; the authorization matrix itself is WU6D1-owned. Local mocks only. */
import { Test } from '@nestjs/testing';
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
const ISSUER = new CapabilityService(new Map([[1, KEY]]), 1);
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
const SAFE_HEADERS = {
  'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
  'cross-origin-resource-policy': 'cross-origin',
};

const buildApp = async () => {
  const authorizer = { authorize: jest.fn() };
  const storage = { head: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    controllers: [ReceiptMediaAccessController],
    providers: [
      { provide: ReceiptCapabilityAuthorizerService, useValue: authorizer },
      { provide: OBJECT_STORAGE_PORT, useValue: storage },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, authorizer, storage };
};

type Harness = Awaited<ReturnType<typeof buildApp>>;
type HeadCall = { key?: string; abortSignal: AbortSignal };

const unavailableAuth = (h: Harness) =>
  h.authorizer.authorize.mockResolvedValue({ kind: 'unavailable' });
const rejectingAuth = (h: Harness) =>
  h.authorizer.authorize.mockRejectedValue(new Error('SECRET_DB_DETAIL'));
const failStorage = (error: unknown) => (h: Harness) =>
  h.storage.head.mockRejectedValue(error);

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

  const headUrl = (token = VALID_TOKEN, headers: Record<string, string> = {}) =>
    request(harness.app.getHttpServer() as App)
      .head(`/media/receipts/${token}`)
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
    token: string,
    res: ReturnType<typeof makeRes>['res'],
  ) => {
    const controller = new ReceiptMediaAccessController(
      harness.authorizer as unknown as ReceiptCapabilityAuthorizerService,
      harness.storage as unknown as ObjectStoragePort,
    );
    await controller.head({ headers: {} } as never, res as never, token);
    return res;
  };

  it('serves no GET route and performs no authorization or storage', async () => {
    admit();
    const res = await request(harness.app.getHttpServer() as App).get(
      `/media/receipts/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(404);
    expect(harness.authorizer.authorize).not.toHaveBeenCalled();
    expect(harness.storage.head).not.toHaveBeenCalled();
  });

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
    const pending = callDirect(VALID_TOKEN, res);
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
    const pending = callDirect(VALID_TOKEN, res);
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
    const pending = callDirect(VALID_TOKEN, res);
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
    await callDirect(VALID_TOKEN, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.off).toHaveBeenCalledWith('close', listeners[0]);
  });
});

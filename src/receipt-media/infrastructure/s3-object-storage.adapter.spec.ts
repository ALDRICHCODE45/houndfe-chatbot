/** WU5A1 + WU5A2a + WU5A2b spec: neutral private object-storage port +
 *  one-shot private S3 PutObject — exact composition, safe errors,
 *  caller-reserved key reuse, streamed integrity, abort registration before
 *  pipeline flow, structured-field failure taxonomy with deterministic
 *  retryable/cleanupPending flags, fail-closed reads, required distinct
 *  signal types, CLEANUP_PENDING incl. cleanup-abort during successful
 *  delete. get/head/delete are WU5B. Fakes only. */
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import * as port from '../domain/object-storage.port';
import {
  isCanonicalObjectKey,
  newObjectKey,
  ObjectStorageError,
} from '../domain/object-storage.port';
import { S3ObjectStorageAdapter } from './s3-object-storage.adapter';

const BUCKET = 'private-bucket';
const KEY = 'receipts/123e4567-e89b-42d3-a456-426614174000';
const CFG = {
  endpoint: 'https://s3.internal',
  region: 'us-east-1',
  bucket: BUCKET,
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
  forcePathStyle: true,
};
const LEAKY = /private-bucket|s3\.internal|receipts\/|image\/|hello|raw/i;

const digest = (s: string) => createHash('sha256').update(s).digest();
const stream = (s: string) => Readable.from([Buffer.from(s)]);
const aborted = () => AbortSignal.abort();
const boom = (props: Record<string, unknown> = {}) =>
  Object.assign(new Error('boom'), props);
const sourceOf = (b: unknown) => (b as { source?: unknown }).source;
const listenerCount = (s: AbortSignal) => getEventListeners(s, 'abort').length;
const putInput = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  content: stream('hello'),
  byteCount: 5,
  mimeType: 'image/jpeg' as const,
  sha256: digest('hello'),
  abortSignal: new AbortController().signal,
  cleanupSignal: new AbortController().signal,
  ...over,
});
type PutInput = ReturnType<typeof putInput>;
const callPut = (
  adapter: S3ObjectStorageAdapter,
  input: PutInput,
): Promise<unknown> => {
  const asPort: port.ObjectStoragePort = adapter;
  return asPort.put(input);
};

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function makeAdapter(put?: (cmd: Cmd) => unknown, drain = true) {
  const sent: { cmd: Cmd; opts?: { abortSignal?: AbortSignal } }[] = [];
  const send = jest.fn(
    async (cmd: Cmd, opts?: { abortSignal?: AbortSignal }) => {
      sent.push({ cmd, opts });
      if (drain && cmd.input.Body)
        for await (const c of cmd.input.Body as AsyncIterable<unknown>) void c;
      return await (put ? put(cmd) : { ETag: '"etag-1"', VersionId: 'v-1' });
    },
  );
  return {
    sent,
    adapter: new S3ObjectStorageAdapter(CFG, {
      send,
    } as unknown as Pick<S3Client, 'send'>),
  };
}

const expectCode = async (
  p: Promise<unknown>,
  code: string,
  retryable?: boolean,
) => {
  const e = (await p.catch((x: unknown) => x)) as ObjectStorageError;
  expect(e).toBeInstanceOf(ObjectStorageError);
  expect(e).toMatchObject({ category: 'OBJECT_STORAGE', code });
  expect(e.message).toBe(`receipt-media:OBJECT_STORAGE/${code}`);
  expect(e.cause).toBeUndefined();
  expect(e.message).not.toMatch(LEAKY);
  expect(JSON.stringify(e)).not.toMatch(LEAKY);
  if (retryable !== undefined) {
    const flags = e as unknown as {
      retryable?: unknown;
      cleanupPending?: unknown;
    };
    expect(flags.retryable).toBe(retryable);
    expect(flags.cleanupPending).toBe(code === 'CLEANUP_PENDING');
  }
  return e;
};

const expectDelete = (
  sent: { cmd: Cmd; opts?: { abortSignal?: AbortSignal } }[],
  input: PutInput,
) => {
  expect(sent).toHaveLength(2);
  expect(sent[1].cmd).toBeInstanceOf(DeleteObjectCommand);
  expect(sent[1].cmd.input).toEqual({ Bucket: BUCKET, Key: input.key });
  expect(sent[1].opts?.abortSignal).toBe(input.cleanupSignal);
};

describe('WU5A1 object-storage port', () => {
  it('keeps the domain port AWS-free and exposes a Symbol token', () => {
    expect(typeof (port as Record<string, unknown>).OBJECT_STORAGE_PORT).toBe(
      'symbol',
    );
    expect(
      readFileSync(join(__dirname, '../domain/object-storage.port.ts'), 'utf8'),
    ).not.toContain('@aws-sdk');
  });

  it('carries deterministic retryable/cleanupPending flags per fixed code', () => {
    const flags: [string, boolean, boolean][] = [
      ['OBJECT_KEY_INVALID', false, false],
      ['REQUEST_INVALID', false, false],
      ['RESPONSE_INVALID', false, false],
      ['ABORTED', true, false],
      ['HTTP_RETRYABLE', true, false],
      ['HTTP_PERMANENT', false, false],
      ['NETWORK_FAILURE', true, false],
      ['CLEANUP_PENDING', true, true],
      ['PERMANENT_FAILURE', false, false],
      ['OBJECT_NOT_FOUND', false, false],
    ];
    for (const [code, retryable, cleanupPending] of flags) {
      const e = new port.ObjectStorageError('OBJECT_STORAGE', code as never);
      const projected = e as unknown as {
        retryable?: unknown;
        cleanupPending?: unknown;
      };
      expect(projected.retryable).toBe(retryable);
      expect(projected.cleanupPending).toBe(cleanupPending);
      expect(e.message).toBe(`receipt-media:OBJECT_STORAGE/${code}`);
      expect(e.cause).toBeUndefined();
    }
  });

  it('requires distinct abortSignal and cleanupSignal at the type boundary', () => {
    type Req<K extends keyof port.PutObjectInput> =
      undefined extends port.PutObjectInput[K] ? false : true;
    const upload: Req<'abortSignal'> = true;
    const cleanup: Req<'cleanupSignal'> = true;
    expect(upload && cleanup).toBe(true);
  });

  it('generates random canonical non-PII uuid-v4 keys', () => {
    const [a, b] = [newObjectKey(), newObjectKey()];
    expect(a).not.toBe(b);
    for (const k of [a, b]) {
      expect(isCanonicalObjectKey(k)).toBe(true);
      expect(isCanonicalObjectKey(k.toUpperCase())).toBe(false);
    }
  });
});

describe('WU5A1 S3 adapter', () => {
  it('constructs a private S3Client from the injected config', async () => {
    const { client } = new S3ObjectStorageAdapter(CFG) as unknown as {
      client: {
        config: {
          credentials: () => Promise<{
            accessKeyId: string;
            secretAccessKey: string;
          }>;
          region: () => Promise<string>;
          endpoint: () => Promise<{ hostname: string; protocol: string }>;
          forcePathStyle: boolean;
        };
      };
    };
    await expect(client.config.credentials()).resolves.toMatchObject({
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    });
    await expect(client.config.region()).resolves.toBe('us-east-1');
    await expect(client.config.endpoint()).resolves.toMatchObject({
      hostname: 's3.internal',
      protocol: 'https:',
    });
    expect(client.config.forcePathStyle).toBe(true);
  });

  it('sends one private one-shot PutObject with the exact composition', async () => {
    const { adapter, sent } = makeAdapter();
    const input = putInput();
    await expect(callPut(adapter, input)).resolves.toEqual({
      etag: '"etag-1"',
      versionId: 'v-1',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBeInstanceOf(PutObjectCommand);
    expect(sent[0].cmd.input).toMatchObject({
      Bucket: BUCKET,
      Key: KEY,
      ContentType: 'image/jpeg',
      ContentLength: 5,
      ChecksumSHA256: digest('hello').toString('base64'),
    });
    expect(sourceOf(sent[0].cmd.input.Body)).toBe(input.content);
    expect(sent[0].cmd.input.ACL).toBeUndefined();
    expect(sent[0].opts).toEqual({ abortSignal: input.abortSignal });
    expect(sent[0].opts?.abortSignal).toBe(input.abortSignal);
    expect(sent.some((s) => /delete/i.test(s.cmd.constructor.name))).toBe(
      false,
    );
  });

  it('composes a successful private PNG PutObject identically', async () => {
    const { adapter, sent } = makeAdapter();
    const input = putInput({ mimeType: 'image/png' });
    await expect(callPut(adapter, input)).resolves.toEqual({
      etag: '"etag-1"',
      versionId: 'v-1',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBeInstanceOf(PutObjectCommand);
    expect(sent[0].cmd.input).toMatchObject({
      Bucket: BUCKET,
      Key: KEY,
      ContentType: 'image/png',
      ContentLength: 5,
      ChecksumSHA256: digest('hello').toString('base64'),
    });
    expect(sourceOf(sent[0].cmd.input.Body)).toBe(input.content);
    expect(sent[0].cmd.input.ACL).toBeUndefined();
  });

  it('accepts the exact 1 and 10_485_760 byte boundaries with evidence', async () => {
    for (const byteCount of [1, 10_485_760]) {
      const bytes =
        byteCount === 1 ? Buffer.from('h') : Buffer.alloc(byteCount, 0x61);
      const { adapter, sent } = makeAdapter();
      const input = putInput({
        byteCount,
        content: Readable.from([bytes]),
        sha256: createHash('sha256').update(bytes).digest(),
      });
      await expect(callPut(adapter, input)).resolves.toEqual({
        etag: '"etag-1"',
        versionId: 'v-1',
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].cmd).toBeInstanceOf(PutObjectCommand);
      expect(sent[0].cmd.input).toMatchObject({
        Bucket: BUCKET,
        Key: KEY,
        ContentType: 'image/jpeg',
        ContentLength: byteCount,
        ChecksumSHA256: input.sha256.toString('base64'),
      });
      expect(sourceOf(sent[0].cmd.input.Body)).toBe(input.content);
      expect(sent.some((s) => /delete/i.test(s.cmd.constructor.name))).toBe(
        false,
      );
    }
  });

  it('returns a nullable VersionId and requires a non-empty ETag', async () => {
    const ok = makeAdapter(() => ({ ETag: '"e-2"' }));
    await expect(callPut(ok.adapter, putInput())).resolves.toEqual({
      etag: '"e-2"',
      versionId: null,
    });
    for (const etag of [undefined, '']) {
      const bad = makeAdapter(() => ({ ETag: etag }));
      const input = putInput();
      await expectCode(callPut(bad.adapter, input), 'RESPONSE_INVALID');
      expectDelete(bad.sent, input);
    }
  });

  it('reuses the caller-reserved key on a safe retry and never generates keys', async () => {
    const { adapter, sent } = makeAdapter();
    for (let i = 0; i < 2; i++) await callPut(adapter, putInput());
    expect(sent.map((s) => s.cmd.input.Key)).toEqual([KEY, KEY]);
  });

  it('rejects invalid input before any send with fixed safe errors', async () => {
    const { adapter, sent } = makeAdapter();
    const bad: [Record<string, unknown>, string][] = [
      [{ key: 'receipts/not-a-uuid' }, 'OBJECT_KEY_INVALID'],
      [{ mimeType: 'image/gif' }, 'REQUEST_INVALID'],
      [{ byteCount: 0 }, 'REQUEST_INVALID'],
      [{ byteCount: 1.5 }, 'REQUEST_INVALID'],
      [{ byteCount: 10_485_761 }, 'REQUEST_INVALID'],
      [{ sha256: Buffer.alloc(31) }, 'REQUEST_INVALID'],
      [{ sha256: Buffer.alloc(33) }, 'REQUEST_INVALID'],
    ];
    for (const [over, code] of bad)
      await expectCode(callPut(adapter, putInput(over)), code);
    expect(sent).toEqual([]);
  });
});

describe('WU5A2a integrity, abort registration, and compensation', () => {
  const gatedAdapter = () =>
    makeAdapter((cmd) => {
      const body = cmd.input.Body as Readable | undefined;
      if (!body) return { ETag: '"etag-1"', VersionId: 'v-1' };
      return new Promise((_, reject) => {
        body.once('error', reject);
        body.once('close', reject);
      });
    }, false);

  it('rejects aliased, missing, and pre-aborted upload/cleanup signals before any send', async () => {
    const { adapter, sent } = makeAdapter();
    const alias = new AbortController().signal;
    const cases: [Record<string, unknown>, string, boolean?][] = [
      [{ abortSignal: alias, cleanupSignal: alias }, 'REQUEST_INVALID'],
      [{ cleanupSignal: aborted() }, 'REQUEST_INVALID'],
      [{ cleanupSignal: undefined }, 'REQUEST_INVALID'],
      [{ abortSignal: undefined }, 'REQUEST_INVALID'],
      [{ abortSignal: aborted() }, 'ABORTED', true],
    ];
    for (const [over, code, retryable] of cases)
      await expectCode(callPut(adapter, putInput(over)), code, retryable);
    expect(sent).toEqual([]);
  });

  it('fails closed on truthy malformed upload/cleanup signals before any send or listener registration', async () => {
    const { adapter, sent } = makeAdapter();
    const throwAborted = () => ({
      get aborted(): boolean {
        throw new Error('signal-fault');
      },
    });
    const trap = new Proxy(
      {},
      {
        get: () => {
          throw new Error('proxy-fault');
        },
      },
    );
    const cases: [Record<string, unknown>, string][] = [
      [{ abortSignal: { aborted: false } }, 'REQUEST_INVALID'],
      [{ abortSignal: { aborted: true } }, 'REQUEST_INVALID'],
      [{ abortSignal: throwAborted() }, 'REQUEST_INVALID'],
      [{ abortSignal: trap }, 'REQUEST_INVALID'],
      [{ cleanupSignal: { aborted: false } }, 'REQUEST_INVALID'],
      [{ cleanupSignal: { aborted: true } }, 'REQUEST_INVALID'],
      [{ cleanupSignal: throwAborted() }, 'REQUEST_INVALID'],
      [{ cleanupSignal: trap }, 'REQUEST_INVALID'],
    ];
    for (const [over, code] of cases)
      await expectCode(callPut(adapter, putInput(over)), code);
    expect(sent).toEqual([]);
  });

  it('fails closed on forged callable-looking methods, shifting method getters, and delayed/stateful aborted accessors before any send', async () => {
    const { adapter, sent } = makeAdapter();
    const throwsOnAdd = () => ({
      aborted: false,
      addEventListener() {
        throw new Error('add-fault');
      },
      removeEventListener() {},
    });
    const shiftingGetter = () => {
      let reads = 0;
      return {
        get aborted(): boolean {
          return false;
        },
        get addEventListener() {
          if (++reads === 1) return () => undefined;
          throw new Error('shifted-method-getter');
        },
        removeEventListener() {},
      };
    };
    const delayedAborted = () => {
      let reads = 0;
      return {
        get aborted(): boolean {
          if (++reads === 1) return false;
          throw new Error('delayed-abort-fault');
        },
        addEventListener() {},
        removeEventListener() {},
      };
    };
    const protoSpoof = (): unknown => Object.create(AbortSignal.prototype);
    const cases: Record<string, unknown>[] = [
      { abortSignal: throwsOnAdd() },
      { cleanupSignal: throwsOnAdd() },
      { abortSignal: shiftingGetter() },
      { cleanupSignal: shiftingGetter() },
      { abortSignal: delayedAborted() },
      { cleanupSignal: delayedAborted() },
      { abortSignal: protoSpoof() },
      { cleanupSignal: protoSpoof() },
    ];
    for (const over of cases)
      await expectCode(callPut(adapter, putInput(over)), 'REQUEST_INVALID');
    expect(sent).toEqual([]);
  });

  it('rejects a Proxy around a genuine AbortSignal that spoofs aborted and listener methods before any send', async () => {
    const { adapter, sent } = makeAdapter();
    const calls: string[] = [];
    const spoofingProxy = (real: AbortSignal): AbortSignal =>
      new Proxy(real, {
        get(target, prop) {
          if (prop === 'aborted') return false;
          if (prop === 'addEventListener')
            return () => {
              calls.push('add');
            };
          if (prop === 'removeEventListener')
            return () => {
              calls.push('remove');
            };
          const v: unknown = Reflect.get(target, prop, target);
          return typeof v === 'function'
            ? (v as () => unknown).bind(target)
            : v;
        },
      });
    const uploadProxy = spoofingProxy(new AbortController().signal);
    const cleanupProxy = spoofingProxy(new AbortController().signal);
    expect(uploadProxy instanceof AbortSignal).toBe(true);
    expect((uploadProxy as { aborted: boolean }).aborted).toBe(false);
    await expectCode(
      callPut(adapter, putInput({ abortSignal: uploadProxy })),
      'REQUEST_INVALID',
    );
    await expectCode(
      callPut(adapter, putInput({ cleanupSignal: cleanupProxy })),
      'REQUEST_INVALID',
    );
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('classifies upload failures from structured fields only and compensates', async () => {
    const cases: [Record<string, unknown>, string, boolean][] = [
      [{}, 'PERMANENT_FAILURE', false],
      [{ message: 'go away', stack: 'at x' }, 'PERMANENT_FAILURE', false],
      [{ $metadata: { httpStatusCode: 400 } }, 'HTTP_PERMANENT', false],
      [{ $metadata: { httpStatusCode: 404 } }, 'HTTP_PERMANENT', false],
      [{ $metadata: { httpStatusCode: 100 } }, 'HTTP_PERMANENT', false],
      [{ $metadata: { httpStatusCode: 418 } }, 'HTTP_PERMANENT', false],
      [{ $metadata: { httpStatusCode: 599 } }, 'HTTP_RETRYABLE', true],
      [{ $metadata: { httpStatusCode: 600 } }, 'PERMANENT_FAILURE', false],
      [
        { $metadata: { httpStatusCode: 600 }, name: 'NetworkingError' },
        'PERMANENT_FAILURE',
        false,
      ],
      [{ $metadata: { httpStatusCode: 408 } }, 'HTTP_RETRYABLE', true],
      [{ $metadata: { httpStatusCode: 429 } }, 'HTTP_RETRYABLE', true],
      [{ $metadata: { httpStatusCode: 500 } }, 'HTTP_RETRYABLE', true],
      [{ $metadata: { httpStatusCode: 503 } }, 'HTTP_RETRYABLE', true],
      [{ $metadata: { httpStatusCode: '400' } }, 'PERMANENT_FAILURE', false],
      [{ $metadata: {} }, 'PERMANENT_FAILURE', false],
      [{ $metadata: {}, name: 'NetworkingError' }, 'PERMANENT_FAILURE', false],
      [
        { $metadata: null, name: 'NetworkingError' },
        'PERMANENT_FAILURE',
        false,
      ],
      [
        { $metadata: { httpStatusCode: '400' }, code: 'ECONNRESET' },
        'PERMANENT_FAILURE',
        false,
      ],
      [{ name: 'NetworkingError' }, 'NETWORK_FAILURE', true],
      [{ name: 'TimeoutError' }, 'NETWORK_FAILURE', true],
      [{ code: 'ECONNRESET' }, 'NETWORK_FAILURE', true],
      [{ code: 'ETIMEDOUT' }, 'NETWORK_FAILURE', true],
      [{ name: 'Unknown' }, 'PERMANENT_FAILURE', false],
      [{ code: 'EPERM' }, 'PERMANENT_FAILURE', false],
    ];
    for (const [props, code, retryable] of cases) {
      const { adapter, sent } = makeAdapter((cmd) => {
        if (/put/i.test(cmd.constructor.name)) throw boom(props);
      });
      const input = putInput();
      await expectCode(callPut(adapter, input), code, retryable);
      expectDelete(sent, input);
    }
  });

  it('never leaks a throwing structured-field accessor and fail-closes present-but-invalid HTTP metadata', async () => {
    const throwGet = (o: Record<string, unknown>, key: string) => {
      Object.defineProperty(o, key, {
        get: () => {
          throw new Error('accessor-fault');
        },
      });
      return o;
    };
    const err = (base: Record<string, unknown> = {}) =>
      Object.assign(new Error('boom'), base);
    const net = { name: 'NetworkingError' };
    const badMeta = throwGet({}, 'httpStatusCode');
    const cases: [() => unknown, string, boolean][] = [
      [() => throwGet(err(net), '$metadata'), 'PERMANENT_FAILURE', false],
      [() => err({ ...net, $metadata: badMeta }), 'PERMANENT_FAILURE', false],
      [() => throwGet(err(), 'name'), 'PERMANENT_FAILURE', false],
      [() => throwGet(err(), 'code'), 'PERMANENT_FAILURE', false],
      [
        () => throwGet(err({ code: 'ECONNRESET' }), 'name'),
        'NETWORK_FAILURE',
        true,
      ],
    ];
    for (const [make, code, retryable] of cases) {
      const { adapter, sent } = makeAdapter((cmd) => {
        if (/put/i.test(cmd.constructor.name)) throw make();
      });
      const input = putInput();
      await expectCode(callPut(adapter, input), code, retryable);
      expectDelete(sent, input);
    }
  });

  it('fails overflow/underflow/hash-mismatch as permanent and compensates', async () => {
    const cases: Record<string, unknown>[] = [
      { byteCount: 5, content: stream('hello!'), sha256: digest('hello!') },
      { byteCount: 5, content: stream('hel'), sha256: digest('hel') },
      { sha256: digest('jello') },
    ];
    for (const over of cases) {
      const { adapter, sent } = makeAdapter();
      const input = putInput(over);
      await expectCode(callPut(adapter, input), 'PERMANENT_FAILURE');
      expectDelete(sent, input);
      expect(input.content.destroyed).toBe(true);
    }
  });

  it('maps a real mid-stream caller abort to ABORTED and compensates', async () => {
    const ctrl = new AbortController();
    let reads = 0;
    const content = new Readable({
      read() {
        if (++reads === 2) queueMicrotask(() => ctrl.abort());
        else this.push(Buffer.from('h'));
      },
    });
    const input = putInput({
      content,
      byteCount: 3,
      sha256: digest('hhh'),
      abortSignal: ctrl.signal,
    });
    const { adapter, sent } = makeAdapter();
    await expectCode(callPut(adapter, input), 'ABORTED', true);
    expectDelete(sent, input);
  });

  it('maps a post-send abort to ABORTED and compensates', async () => {
    const ctrl = new AbortController();
    const { adapter, sent } = makeAdapter(() => {
      ctrl.abort();
      return { ETag: '"etag-1"', VersionId: 'v-1' };
    });
    const input = putInput({ abortSignal: ctrl.signal });
    await expectCode(callPut(adapter, input), 'ABORTED', true);
    expectDelete(sent, input);
  });

  it('catches an abort fired synchronously when pipeline flow starts', async () => {
    const ctrl = new AbortController();
    let reads = 0;
    const content = new Readable({
      read() {
        if (++reads === 1) ctrl.abort();
      },
    });
    const input = putInput({
      content,
      byteCount: 5,
      sha256: digest('hello'),
      abortSignal: ctrl.signal,
    });
    const { adapter, sent } = makeAdapter();
    await expectCode(callPut(adapter, input), 'ABORTED');
    expectDelete(sent, input);
    expect(content.destroyed).toBe(true);
    expect(listenerCount(input.abortSignal)).toBe(0);
  });

  it('tears down a stalled source when the caller aborts a body-gated send', async () => {
    const content = new Readable({ read: () => undefined });
    const ctrl = new AbortController();
    const { adapter, sent } = gatedAdapter();
    const input = putInput({
      content,
      byteCount: 5,
      sha256: digest('hello'),
      abortSignal: ctrl.signal,
    });
    queueMicrotask(() => ctrl.abort());
    await expectCode(callPut(adapter, input), 'ABORTED');
    expectDelete(sent, input);
    expect(content.destroyed).toBe(true);
  });

  it('tears down a genuinely stalled source on failure and settles without unhandled rejections', async () => {
    const content = new Readable({ read: () => undefined });
    const input = putInput({ content });
    const { adapter, sent } = makeAdapter((cmd) => {
      if (/put/i.test(cmd.constructor.name)) throw boom();
    }, false);
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on('unhandledRejection', onRejection);
    try {
      await expectCode(callPut(adapter, input), 'PERMANENT_FAILURE');
      expectDelete(sent, input);
      expect(content.destroyed).toBe(true);
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
      expect(listenerCount(input.abortSignal)).toBe(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('maps a source-stream failure to the fixed generic failure with teardown', async () => {
    const content = new Readable({
      read() {
        this.destroy(boom());
      },
    });
    const input = putInput({ content });
    const { adapter, sent } = makeAdapter();
    await expectCode(callPut(adapter, input), 'PERMANENT_FAILURE');
    expectDelete(sent, input);
    expect(content.destroyed).toBe(true);
  });

  it('maps cleanup failure or aborted cleanup to CLEANUP_PENDING hiding both failures', async () => {
    const { adapter, sent } = makeAdapter((cmd) => {
      if (/put/i.test(cmd.constructor.name))
        throw boom({ $metadata: { httpStatusCode: 503 } });
      throw boom({ $metadata: { httpStatusCode: 400 } });
    });
    const e = await expectCode(
      callPut(adapter, putInput()),
      'CLEANUP_PENDING',
      true,
    );
    expect((e as { cleanupPending?: unknown }).cleanupPending).toBe(true);
    expect(sent).toHaveLength(2);
    const cleanupCtrl = new AbortController();
    const mid = makeAdapter((cmd) => {
      if (/put/i.test(cmd.constructor.name)) {
        cleanupCtrl.abort();
        throw boom({ $metadata: { httpStatusCode: 503 } });
      }
      throw boom({ $metadata: { httpStatusCode: 400 } });
    });
    const e2 = await expectCode(
      callPut(mid.adapter, putInput({ cleanupSignal: cleanupCtrl.signal })),
      'CLEANUP_PENDING',
      true,
    );
    expect((e2 as { cleanupPending?: unknown }).cleanupPending).toBe(true);
    expect(mid.sent).toHaveLength(1);
  });

  it('maps a cleanup abort during a successful compensation to fixed CLEANUP_PENDING', async () => {
    const cleanupCtrl = new AbortController();
    const { adapter, sent } = makeAdapter((cmd) => {
      if (/put/i.test(cmd.constructor.name))
        throw boom({ $metadata: { httpStatusCode: 400 } });
      cleanupCtrl.abort();
      return {};
    });
    const input = putInput({ cleanupSignal: cleanupCtrl.signal });
    await expectCode(callPut(adapter, input), 'CLEANUP_PENDING', true);
    expectDelete(sent, input);
  });

  it('preserves the original classified failure when compensation succeeds', async () => {
    const cases: [Record<string, unknown>, string, boolean][] = [
      [{ $metadata: { httpStatusCode: 429 } }, 'HTTP_RETRYABLE', true],
      [{ code: 'ECONNRESET' }, 'NETWORK_FAILURE', true],
      [{ $metadata: { httpStatusCode: 400 } }, 'HTTP_PERMANENT', false],
      [{}, 'PERMANENT_FAILURE', false],
    ];
    for (const [props, code, retryable] of cases) {
      const { adapter, sent } = makeAdapter((cmd) => {
        if (/put/i.test(cmd.constructor.name)) throw boom(props);
      });
      const input = putInput();
      await expectCode(callPut(adapter, input), code, retryable);
      expectDelete(sent, input);
    }
  });

  it('keeps exact signals, removes listeners, and never deletes on success', async () => {
    const signal = new AbortController().signal;
    const input = putInput({ abortSignal: signal });
    const { adapter, sent } = makeAdapter();
    await expect(callPut(adapter, input)).resolves.toMatchObject({
      etag: '"etag-1"',
    });
    expect(listenerCount(signal)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].opts?.abortSignal).toBe(signal);
    expect(input.content.destroyed).toBe(true);
  });
});

describe('WU5B1a2 S3 adapter getStream', () => {
  const getResponse = (over: Record<string, unknown> = {}) => ({
    Body: Readable.from([Buffer.from('hello')]),
    ContentLength: 5,
    ContentType: 'image/jpeg',
    ETag: '"etag-1"',
    VersionId: 'v-1',
    ...over,
  });
  const getInput = (over: Record<string, unknown> = {}) => ({
    key: KEY,
    abortSignal: new AbortController().signal,
    ...over,
  });
  type GetInput = ReturnType<typeof getInput>;
  const callGet = (
    adapter: S3ObjectStorageAdapter,
    input: GetInput,
  ): Promise<unknown> => {
    const asPort: port.ObjectStoragePort = adapter;
    return asPort.getStream(input);
  };

  it('sends one private GetObject and streams the internal safe result, never the provider body', async () => {
    const body = Readable.from([Buffer.from('hello')]);
    const { adapter, sent } = makeAdapter(() => ({
      ...getResponse(),
      Body: body,
    }));
    const input = getInput();
    const result = (await callGet(adapter, input)) as {
      stream: Readable;
      byteCount: number;
      mimeType: string;
      etag: string;
      versionId: string | null;
    };
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBeInstanceOf(GetObjectCommand);
    expect(sent[0].cmd.input).toEqual({ Bucket: BUCKET, Key: KEY });
    expect(sent[0].cmd.input.ACL).toBeUndefined();
    expect(sent[0].opts).toEqual({ abortSignal: input.abortSignal });
    expect(result.byteCount).toBe(5);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.etag).toBe('"etag-1"');
    expect(result.versionId).toBe('v-1');
    expect(result.stream).not.toBe(body);
    expect((await result.stream.toArray()).toString()).toBe('hello');
    expect(listenerCount(input.abortSignal)).toBe(0);
  });

  it('rejects invalid signal/key and pre-abort before any send', async () => {
    const { adapter, sent } = makeAdapter();
    const spoof = new Proxy(new AbortController().signal, {
      get: (t, p) => {
        const v: unknown = Reflect.get(t, p, t);
        return typeof v === 'function' ? (v as () => unknown).bind(t) : v;
      },
    });
    const cases: [Record<string, unknown>, string, boolean?][] = [
      [{ key: 'receipts/not-a-uuid' }, 'OBJECT_KEY_INVALID'],
      [{ abortSignal: undefined }, 'REQUEST_INVALID'],
      [{ abortSignal: { aborted: false } }, 'REQUEST_INVALID'],
      [{ abortSignal: spoof }, 'REQUEST_INVALID'],
      [{ abortSignal: aborted() }, 'ABORTED', true],
    ];
    for (const [over, code, retryable] of cases)
      await expectCode(callGet(adapter, getInput(over)), code, retryable);
    expect(sent).toEqual([]);
  });

  it('maps a failed abort-listener registration to REQUEST_INVALID before any send', async () => {
    const original =
      // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; restored in finally
      EventTarget.prototype.addEventListener;
    let settle: (value: unknown) => void = () => undefined;
    const outcome = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const send = jest.fn();
    jest.isolateModules(() => {
      (
        EventTarget.prototype as unknown as Record<string, unknown>
      ).addEventListener = () => {
        throw new Error('add-fault');
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module evaluation is required so the adapter re-captures the patched native listener seam
        const freshModule = require('./s3-object-storage.adapter') as {
          S3ObjectStorageAdapter: typeof S3ObjectStorageAdapter;
        };
        const adapter = new freshModule.S3ObjectStorageAdapter(CFG, {
          send,
        });
        (adapter as port.ObjectStoragePort)
          .getStream(getInput())
          .then(settle, settle);
      } finally {
        EventTarget.prototype.addEventListener = original;
      }
    });
    expect(await outcome).toMatchObject({
      category: 'OBJECT_STORAGE',
      code: 'REQUEST_INVALID',
      message: 'receipt-media:OBJECT_STORAGE/REQUEST_INVALID',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('lets a caller abort win over provider rejection and over a resolved response', async () => {
    const responds: (() => unknown)[] = [
      () => {
        throw boom({ $metadata: { httpStatusCode: 404 } });
      },
      () => getResponse(),
    ];
    for (const respond of responds) {
      const ctrl = new AbortController();
      const { adapter } = makeAdapter(() => {
        ctrl.abort();
        return respond();
      });
      await expectCode(
        callGet(adapter, getInput({ abortSignal: ctrl.signal })),
        'ABORTED',
        true,
      );
    }
  });

  it('maps exact structured 404 to nonretryable OBJECT_NOT_FOUND and keeps the taxonomy', async () => {
    const { adapter, sent } = makeAdapter(() => {
      throw boom({ $metadata: { httpStatusCode: 404 } });
    });
    const e = await expectCode(
      callGet(adapter, getInput()),
      'OBJECT_NOT_FOUND',
      false,
    );
    expect((e as { cleanupPending?: unknown }).cleanupPending).toBe(false);
    expect(sent).toHaveLength(1);
    const cases: [Record<string, unknown>, string, boolean?][] = [
      [{ $metadata: { httpStatusCode: '404' } }, 'PERMANENT_FAILURE'],
      [{ $metadata: {} }, 'PERMANENT_FAILURE'],
      [{ name: 'NetworkingError' }, 'NETWORK_FAILURE'],
      [{ $metadata: { httpStatusCode: 400 } }, 'HTTP_PERMANENT', false],
      [{ $metadata: { httpStatusCode: 503 } }, 'HTTP_RETRYABLE', true],
      [{}, 'PERMANENT_FAILURE', false],
      [{ code: 'ECONNRESET' }, 'NETWORK_FAILURE', true],
    ];
    for (const [props, code, retryable] of cases) {
      const next = makeAdapter(() => {
        throw boom(props);
      });
      await expectCode(callGet(next.adapter, getInput()), code, retryable);
    }
  });

  it('rejects Proxy and prototype-only response fields with zero trap or getter execution', async () => {
    let traps = 0;
    // Plain send (no jest.fn): jest-mock bookkeeping would itself read a
    // property of the returned proxy, so the zero-trap assertion needs an
    // un-instrumented return path.
    const sent: unknown[] = [];
    const proxyAdapter = new S3ObjectStorageAdapter(CFG, {
      send: (cmd: Cmd) => {
        sent.push(cmd);
        const response = new Proxy(getResponse(), {
          get: (t, p) => {
            // The JS promise-resolution protocol itself reads `.then` once
            // when the fake send's promise settles; that lookup is runtime,
            // not adapter code, so it is exempt from the zero-trap count.
            if (p !== 'then') traps++;
            const value: unknown = Reflect.get(t, p, t);
            return value;
          },
        });
        return Promise.resolve(response);
      },
    });
    await expectCode(callGet(proxyAdapter, getInput()), 'RESPONSE_INVALID');
    expect(traps).toBe(0);
    expect(sent).toHaveLength(1);
    let getterCalls = 0;
    const proto = {
      get ContentType(): string {
        getterCalls++;
        return 'image/jpeg';
      },
      get Body(): Readable {
        getterCalls++;
        return Readable.from(['x']);
      },
    };
    const protoAdapter = makeAdapter(() => Object.create(proto));
    await expectCode(
      callGet(protoAdapter.adapter, getInput()),
      'RESPONSE_INVALID',
    );
    expect(getterCalls).toBe(0);
  });

  it('rejects own accessor fields without invocation and destroys bodies under malformed metadata', async () => {
    let calls = 0;
    const accessorResponse = {
      get ContentType(): string {
        calls++;
        return 'image/jpeg';
      },
      Body: Readable.from(['x']),
      ContentLength: 1,
      ETag: '"e"',
    };
    const accessor = makeAdapter(() => accessorResponse);
    await expectCode(callGet(accessor.adapter, getInput()), 'RESPONSE_INVALID');
    expect(calls).toBe(0);
    const cases: Record<string, unknown>[] = [
      { ContentLength: '5' },
      { ContentType: 'image/gif' },
      { ETag: '' },
      { VersionId: 42 },
    ];
    for (const over of cases) {
      const body = Readable.from([Buffer.from('hello')]);
      const { adapter } = makeAdapter(() => ({
        ...getResponse(),
        Body: body,
        ...over,
      }));
      await expectCode(callGet(adapter, getInput()), 'RESPONSE_INVALID');
      expect(body.destroyed).toBe(true);
    }
  });
});

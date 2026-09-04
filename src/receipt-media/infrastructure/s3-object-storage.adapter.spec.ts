/** WU5A1 + WU5A2a spec: neutral private object-storage port + one-shot
 *  private S3 PutObject — exact composition, safe errors, caller-reserved
 *  key reuse, streamed integrity, abort registration before pipeline flow,
 *  and compensation on distinct upload/cleanup signals. Detailed taxonomy
 *  and CLEANUP_PENDING are WU5A2b; get/head/delete are WU5B. Fakes only. */
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
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

const expectCode = async (p: Promise<unknown>, code: string) => {
  const e = (await p.catch((x: unknown) => x)) as ObjectStorageError;
  expect(e).toBeInstanceOf(ObjectStorageError);
  expect(e).toMatchObject({ category: 'OBJECT_STORAGE', code });
  expect(e.message).toBe(`receipt-media:OBJECT_STORAGE/${code}`);
  expect(e.cause).toBeUndefined();
  expect(e.message).not.toMatch(LEAKY);
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
    const cases: [Record<string, unknown>, string][] = [
      [{ abortSignal: alias, cleanupSignal: alias }, 'REQUEST_INVALID'],
      [{ cleanupSignal: aborted() }, 'REQUEST_INVALID'],
      [{ cleanupSignal: undefined }, 'REQUEST_INVALID'],
      [{ abortSignal: undefined }, 'REQUEST_INVALID'],
      [{ abortSignal: aborted() }, 'ABORTED'],
    ];
    for (const [over, code] of cases)
      await expectCode(callPut(adapter, putInput(over)), code);
    expect(sent).toEqual([]);
  });

  it('maps generic SDK rejections to the fixed generic failure and compensates', async () => {
    for (const props of [
      {},
      { $metadata: { httpStatusCode: 400 } },
      { name: 'NetworkingError' },
    ]) {
      const { adapter, sent } = makeAdapter((cmd) => {
        if (/put/i.test(cmd.constructor.name)) throw boom(props);
      });
      const input = putInput();
      await expectCode(callPut(adapter, input), 'PERMANENT_FAILURE');
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
    await expectCode(callPut(adapter, input), 'ABORTED');
    expectDelete(sent, input);
  });

  it('maps a post-send abort to ABORTED and compensates', async () => {
    const ctrl = new AbortController();
    const { adapter, sent } = makeAdapter(() => {
      ctrl.abort();
      return { ETag: '"etag-1"', VersionId: 'v-1' };
    });
    const input = putInput({ abortSignal: ctrl.signal });
    await expectCode(callPut(adapter, input), 'ABORTED');
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

  it('stays fail-closed when compensation fails or the cleanup signal aborts', async () => {
    const { adapter, sent } = makeAdapter(() => {
      throw boom();
    });
    await expectCode(callPut(adapter, putInput()), 'PERMANENT_FAILURE');
    expect(sent).toHaveLength(2);
    const cleanupCtrl = new AbortController();
    const mid = makeAdapter((cmd) => {
      if (/put/i.test(cmd.constructor.name)) {
        cleanupCtrl.abort();
        throw boom();
      }
      throw boom();
    });
    await expectCode(
      callPut(mid.adapter, putInput({ cleanupSignal: cleanupCtrl.signal })),
      'PERMANENT_FAILURE',
    );
    expect(mid.sent).toHaveLength(1);
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

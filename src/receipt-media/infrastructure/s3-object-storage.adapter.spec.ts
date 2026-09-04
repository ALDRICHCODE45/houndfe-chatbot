/** WU5A1 spec: neutral private object-storage port + one-shot private S3
 *  PutObject — injected credentials, exact key/length/checksum/signal
 *  composition, safe input/response errors, and caller-reserved key reuse on
 *  a safe retry. Abort/failure classification and compensation are WU5A2;
 *  get/head/delete are WU5B. Fakes only; no network. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
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
const putInput = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  content: stream('hello'),
  byteCount: 5,
  mimeType: 'image/jpeg' as const,
  sha256: digest('hello'),
  abortSignal: new AbortController().signal,
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

function makeAdapter(put?: (cmd: Cmd) => unknown) {
  const sent: { cmd: Cmd; opts?: { abortSignal?: AbortSignal } }[] = [];
  const send = jest.fn(
    async (cmd: Cmd, opts?: { abortSignal?: AbortSignal }) => {
      sent.push({ cmd, opts });
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
    expect(sent[0].cmd.input.Body).toBe(input.content);
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
    expect(sent[0].cmd.input.Body).toBe(input.content);
    expect(sent[0].cmd.input.ACL).toBeUndefined();
  });

  it('accepts the exact 1 and 10_485_760 byte boundaries with evidence', async () => {
    for (const byteCount of [1, 10_485_760]) {
      const { adapter, sent } = makeAdapter();
      const input = putInput({ byteCount });
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
      expect(sent[0].cmd.input.Body).toBe(input.content);
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
      await expectCode(callPut(bad.adapter, putInput()), 'RESPONSE_INVALID');
      expect(bad.sent).toHaveLength(1);
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

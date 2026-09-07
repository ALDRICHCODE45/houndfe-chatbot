import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { SafeObjectReadStreamError } from './safe-object-read-stream';
import { RECEIPT_MAX_BYTES } from '../domain/receipt-media.types';
import {
  assembleSafeObjectReadResult,
  type SafeObjectReadFields,
} from './safe-object-read-result';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const source = () => new Readable({ read() {} });
const fields = (
  over: Partial<SafeObjectReadFields> = {},
): SafeObjectReadFields => ({
  body: source(),
  byteCount: 3,
  mimeType: 'image/jpeg',
  etag: '"e"',
  versionId: null,
  abortSignal: new AbortController().signal,
  ...over,
});
const expectInvalid = (over: Partial<SafeObjectReadFields> = {}) => {
  const result = assembleSafeObjectReadResult(fields(over));
  expect(result).toEqual({ ok: false, reason: 'RESPONSE_INVALID' });
  return result;
};
const bodyListeners = (body: Readable) =>
  ['data', 'end', 'error', 'close'].map(
    (e) => getEventListeners(body, e).length,
  );

describe('assembleSafeObjectReadResult', () => {
  it('streams guarded content for both MIME types with null or string versions', async () => {
    for (const mimeType of ['image/jpeg', 'image/png'] as const)
      for (const versionId of [null, 'v-1'] as const) {
        const body = source();
        const result = assembleSafeObjectReadResult(
          fields({ body, mimeType, versionId }),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        expect(result.value).toEqual({
          stream: expect.anything() as unknown,
          byteCount: 3,
          mimeType,
          etag: '"e"',
          versionId,
        });
        const chunks: Buffer[] = [];
        result.value.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        const ended = new Promise<void>((resolve) =>
          result.value.stream.once('end', resolve),
        );
        body.push(Buffer.from('ab'));
        body.push(null);
        await ended;
        expect(Buffer.concat(chunks).toString()).toBe('ab');
        expect(bodyListeners(body)).toEqual([0, 0, 0, 0]);
      }
  });

  it('returns only the internal stream and safe primitives, never the original body', () => {
    const body = source();
    const result = assembleSafeObjectReadResult(fields({ body }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.stream).not.toBe(body);
    expect(Object.keys(result.value).sort()).toEqual([
      'byteCount',
      'etag',
      'mimeType',
      'stream',
      'versionId',
    ]);
    expect(result.value).not.toHaveProperty('body');
  });

  it('fails closed on invalid bodies and signals with zero attacker access', () => {
    let attacker = 0;
    const tracked = <T extends object>(target: T): T =>
      new Proxy(target, {
        get: () => {
          attacker += 1;
          return undefined;
        },
        getPrototypeOf: () => {
          attacker += 1;
          return null;
        },
      });
    expectInvalid({ body: {} });
    expectInvalid({ body: tracked(source()) });
    expectInvalid({ abortSignal: {} });
    expectInvalid({ abortSignal: tracked(new AbortController().signal) });
    expect(attacker).toBe(0);
    // A genuine signal with a hostile own `aborted` accessor still passes the
    // guard via the captured native prototype getter (accessor never invoked).
    let reads = 0;
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'aborted', {
      get: () => {
        reads += 1;
        return true;
      },
    });
    const body = source();
    expect(
      assembleSafeObjectReadResult(
        fields({ body, abortSignal: controller.signal }),
      ).ok,
    ).toBe(true);
    expect(reads).toBe(0);
  });

  it('destroys the guarded body without an error when only the signal is invalid', () => {
    const body = source();
    expectInvalid({ body, abortSignal: { aborted: false } });
    expect(body.destroyed).toBe(true);
  });

  it('destroys the body without an error on a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const body = source();
    const errors: unknown[] = [];
    body.once('error', (error: unknown) => errors.push(error));
    expect(
      assembleSafeObjectReadResult(
        fields({ body, abortSignal: controller.signal }),
      ),
    ).toEqual({ ok: false, reason: 'ABORTED' });
    await tick();
    expect(body.destroyed).toBe(true);
    expect(errors).toEqual([]);
    expect(() => body.destroy(new Error('provider secret'))).not.toThrow();
    expect(() => body.push('late')).not.toThrow();
    expect(bodyListeners(body)).toEqual([0, 0, 1, 0]);
  });

  it('accepts only exact metadata boundaries and destroys on every invalid (table)', async () => {
    const cases: [
      string,
      Partial<SafeObjectReadFields>,
      'ok' | 'RESPONSE_INVALID',
    ][] = [
      ['byteCount=1', { byteCount: 1 }, 'ok'],
      [`byteCount=max`, { byteCount: RECEIPT_MAX_BYTES }, 'ok'],
      ['byteCount=0', { byteCount: 0 }, 'RESPONSE_INVALID'],
      [
        'byteCount=max+1',
        { byteCount: RECEIPT_MAX_BYTES + 1 },
        'RESPONSE_INVALID',
      ],
      ['byteCount=1.5', { byteCount: 1.5 }, 'RESPONSE_INVALID'],
      ['byteCount="3"', { byteCount: '3' }, 'RESPONSE_INVALID'],
      ['byteCount=NaN', { byteCount: Number.NaN }, 'RESPONSE_INVALID'],
      ['byteCount=null', { byteCount: null }, 'RESPONSE_INVALID'],
      ['mime=png', { mimeType: 'image/png' }, 'ok'],
      ['mime=gif', { mimeType: 'image/gif' }, 'RESPONSE_INVALID'],
      ['mime=upper', { mimeType: 'IMAGE/JPEG' }, 'RESPONSE_INVALID'],
      ['mime=padded', { mimeType: ' image/jpeg' }, 'RESPONSE_INVALID'],
      ['mime=empty', { mimeType: '' }, 'RESPONSE_INVALID'],
      ['mime=null', { mimeType: null }, 'RESPONSE_INVALID'],
      ['etag=short', { etag: 'x' }, 'ok'],
      ['etag=empty', { etag: '' }, 'RESPONSE_INVALID'],
      ['etag=number', { etag: 5 }, 'RESPONSE_INVALID'],
      ['version=string', { versionId: 'abc' }, 'ok'],
      ['version=undefined', { versionId: undefined }, 'ok'],
      ['version=empty', { versionId: '' }, 'RESPONSE_INVALID'],
      ['version=number', { versionId: 7 }, 'RESPONSE_INVALID'],
    ];
    for (const [label, over, expected] of cases) {
      const body = source();
      const result = assembleSafeObjectReadResult(fields({ body, ...over }));
      if (expected === 'ok') {
        expect({ label, ok: result.ok }).toEqual({ label, ok: true });
        if (!result.ok) throw new Error(label);
        const done = new Promise<void>((resolve) =>
          result.value.stream.once('end', resolve),
        );
        result.value.stream.resume();
        body.push(null);
        await done;
      } else {
        expect({ label, result, destroyed: body.destroyed }).toEqual({
          label,
          result: { ok: false, reason: 'RESPONSE_INVALID' },
          destroyed: true,
        });
      }
    }
  });

  it('maps initial and setup lifecycle failures to safe reasons with cleanup', async () => {
    const destroyed = source();
    destroyed.destroy();
    expectInvalid({ body: destroyed });

    const ended = source();
    ended.push(null);
    ended.resume();
    await tick();
    expectInvalid({ body: ended });

    const closed = source();
    closed.on('newListener', (event: string) => {
      if (event === 'close') closed.destroy();
    });
    expectInvalid({ body: closed });
    await tick();
    expect(closed.destroyed).toBe(true);

    const controller = new AbortController();
    const raced = source();
    raced.on('newListener', (event: string) => {
      if (event === 'error') controller.abort();
    });
    expect(
      assembleSafeObjectReadResult(
        fields({ body: raced, abortSignal: controller.signal }),
      ),
    ).toEqual({ ok: false, reason: 'ABORTED' });
    await tick();
    expect(raced.destroyed).toBe(true);
    for (const body of [destroyed, ended, closed, raced])
      expect(bodyListeners(body)).toEqual([0, 0, 0, 0]);
  });

  it('projects a post-return abort race through the lifecycle with fixed errors', async () => {
    const body = source();
    const controller = new AbortController();
    const result = assembleSafeObjectReadResult(
      fields({ body, abortSignal: controller.signal }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const failure = new Promise<Error>((resolve) =>
      result.value.stream.once('error', resolve),
    );
    controller.abort();
    const error = await failure;
    expect(error).toBeInstanceOf(SafeObjectReadStreamError);
    expect(error).toMatchObject({ code: 'ABORTED' });
    await tick();
    expect(body.destroyed).toBe(true);
    expect(bodyListeners(body)).toEqual([0, 0, 0, 0]);
  });

  it('returns reason-only failures with no raw causes and no AWS imports', () => {
    const result = expectInvalid({ etag: 5 });
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
    expect('cause' in result).toBe(false);
    const source = readFileSync(
      join(__dirname, 'safe-object-read-result.ts'),
      'utf8',
    );
    expect(/aws/i.test(source)).toBe(false);
  });
});

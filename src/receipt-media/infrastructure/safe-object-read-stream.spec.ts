import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import {
  guardObjectReadBody,
  guardObjectReadSignal,
  type GuardedObjectReadBody,
  type GuardedObjectReadSignal,
} from './safe-object-read-guards';
import {
  createSafeObjectReadStream,
  SafeObjectReadStreamError,
} from './safe-object-read-stream';
const body = (source: Readable, over: Partial<GuardedObjectReadBody> = {}) => ({
  ...guardObjectReadBody(source)!,
  ...over,
});
const signal = (controller = new AbortController()) =>
  [controller, guardObjectReadSignal(controller.signal)!] as const;
const listeners = (source: Readable, controller?: AbortController) => [
  ...['data', 'end', 'error', 'close'].map(
    (event) => getEventListeners(source, event).length,
  ),
  controller ? getEventListeners(controller.signal, 'abort').length : 0,
];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const clean = (source: Readable, controller?: AbortController) =>
  expect(listeners(source, controller)).toEqual([0, 0, 0, 0, 0]);
const open = (
  guarded: GuardedObjectReadBody,
  signal?: GuardedObjectReadSignal,
) => {
  const result = createSafeObjectReadStream(guarded, signal);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected open stream');
  return result.stream;
};
const expectError = async (stream: Readable, code: string) => {
  const error = await new Promise<Error>((resolve) =>
    stream.once('error', resolve),
  );
  expect(error).toBeInstanceOf(SafeObjectReadStreamError);
  expect(error).toMatchObject({ code });
  expect(error.message).toBe(`receipt-media:SAFE_OBJECT_READ_STREAM/${code}`);
  expect(error.cause).toBeUndefined();
};
describe('createSafeObjectReadStream', () => {
  it('bridges Buffer, Uint8Array, and string chunks through an internal stream', async () => {
    const source = new Readable({ read() {} });
    const stream = open(body(source));
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) => stream.once('end', resolve));
    source.push(Buffer.from('a'));
    source.push(new Uint8Array([98]));
    source.push('c');
    source.push(null);
    await ended;
    expect(Buffer.concat(chunks).toString()).toBe('abc');
    expect(listeners(source)).toEqual([0, 0, 0, 0, 0]);
  });
  it('rejects initial destroyed/ended bodies and pre-aborted signals before flow', () => {
    const destroyed = new Readable({ read() {} });
    const ended = new Readable({ read() {} });
    const aborted = new Readable({ read() {} });
    const controller = new AbortController();
    destroyed.destroy();
    controller.abort();
    const reject = (
      source: Readable,
      guarded: GuardedObjectReadBody,
      reason: string,
      guardedSignal?: GuardedObjectReadSignal,
    ) => {
      const result = createSafeObjectReadStream(guarded, guardedSignal);
      expect(result).toEqual({ ok: false, reason });
      expect(source.readableFlowing).not.toBe(true);
    };
    reject(destroyed, body(destroyed), 'SOURCE_UNAVAILABLE');
    reject(
      ended,
      body(ended, { initialState: { destroyed: false, readableEnded: true } }),
      'SOURCE_UNAVAILABLE',
    );
    reject(aborted, body(aborted), 'ABORTED', signal(controller)[1]);
  });
  it('fails first error-listener registration and every setup fault safely', async () => {
    for (const [failure, reason] of [
      ['pause', 'PAUSE_FAILED'],
      ['listener', 'REGISTRATION_FAILED'],
      ['signal', 'REGISTRATION_FAILED'],
      ['resume', 'RESUME_FAILED'],
      ['close', 'SOURCE_TERMINATED'],
      ['end', 'SOURCE_TERMINATED'],
      ['abort', 'ABORTED'],
    ] as const) {
      const source = new Readable({ read() {} });
      const [controller, guardedSignal] = signal();
      let destroys = 0;
      const native = body(source);
      const guarded: GuardedObjectReadBody = {
        ...native,
        addListener: (event, listener) => {
          if (failure === 'listener' && event === 'error') return false;
          const added = native.addListener(event, listener);
          if (event === 'close' && failure === 'close') listener();
          if (event === 'close' && failure === 'end') source.emit('end');
          return added;
        },
        pause: () => failure !== 'pause' && native.pause(),
        resume: () => failure !== 'resume' && native.resume(),
        destroy: (error?: Error) => {
          destroys++;
          expect(error).toBeUndefined();
          return native.destroy();
        },
      };
      const rejectedSignal: GuardedObjectReadSignal = {
        ...guardedSignal,
        addAbortListener: (listener) => {
          if (failure === 'signal') return false;
          const added = guardedSignal.addAbortListener(listener);
          if (failure === 'abort') controller.abort();
          return added;
        },
      };
      expect(createSafeObjectReadStream(guarded, rejectedSignal)).toEqual({
        ok: false,
        reason,
      });
      await tick();
      expect(destroys).toBe(1);
      expect(source.destroyed).toBe(true);
      expect(source.readableFlowing).not.toBe(true);
      clean(source, controller);
      if (failure === 'listener') {
        expect(() =>
          source.destroy(new Error('provider secret')),
        ).not.toThrow();
        expect(source.push(Buffer.from('late'))).toBe(false);
        await tick();
        clean(source, controller);
      }
    }
  });
  it('projects raw source failures, premature close, and invalid chunks to fixed errors', async () => {
    const empty = (objectMode = false) =>
      new Readable({ objectMode, read() {} });
    const cases: [Readable, (source: Readable) => void, string][] = [
      [
        empty(),
        (source) => source.destroy(new Error('provider secret')),
        'SOURCE_ERROR',
      ],
      [empty(), (source) => source.destroy(), 'SOURCE_CLOSED'],
      [
        empty(true),
        (source) => source.push({ raw: 'provider' }),
        'INVALID_CHUNK',
      ],
    ];
    for (const [source, trigger, code] of cases) {
      const stream = open(body(source));
      const errors: Error[] = [];
      stream.on('error', (error: Error) => errors.push(error));
      const expected = expectError(stream, code);
      trigger(source);
      await expected;
      await tick();
      expect(errors).toHaveLength(1);
      clean(source);
    }
  });
  it('aborts after return and consumer destruction with fixed errors and complete cleanup', async () => {
    for (const mode of ['abort', 'consumer'] as const) {
      const source = new Readable({ read() {} });
      const [controller, guardedSignal] = signal();
      const stream = open(body(source), guardedSignal);
      const expected = expectError(
        mode === 'abort' ? stream : source,
        mode === 'abort' ? 'ABORTED' : 'CONSUMER_CLOSED',
      );
      if (mode === 'abort') controller.abort();
      else stream.destroy();
      await expected;
      await tick();
      expect(source.destroyed).toBe(true);
      clean(source, controller);
    }
  });
  it('owns one backpressure cycle and fails closed on repeated data', async () => {
    for (const failure of ['none', 'pause', 'resume', 'repeat'] as const) {
      const source = new Readable({ read() {} });
      let pauses = 0;
      let resumes = 0;
      const guarded = body(source, {
        pause: () => {
          pauses++;
          return (
            (pauses === 1 || failure !== 'pause') &&
            guardObjectReadBody(source)!.pause()
          );
        },
        resume: () =>
          ++resumes === 1 || failure !== 'resume'
            ? guardObjectReadBody(source)!.resume()
            : false,
      });
      const stream = open(guarded);
      if (failure === 'repeat') {
        const expected = expectError(stream, 'SOURCE_ERROR');
        source.emit('data', Buffer.alloc(64 * 1024));
        expect(getEventListeners(stream, 'drain')).toHaveLength(1);
        source.emit('data', Buffer.alloc(1));
        await expected;
        expect([pauses, resumes]).toEqual([2, 1]);
      } else {
        source.push(Buffer.alloc(64 * 1024));
        if (failure === 'pause') await expectError(stream, 'SOURCE_ERROR');
        else {
          const done =
            failure === 'resume'
              ? expectError(stream, 'SOURCE_ERROR')
              : new Promise<void>((resolve) => stream.once('end', resolve));
          stream.resume();
          source.push(null);
          await done;
        }
      }
      await tick();
      expect(resumes).toBe(failure === 'pause' || failure === 'repeat' ? 1 : 2);
      clean(source);
    }
  });
});

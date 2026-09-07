/** WU5B1a0a1 spec: provider-neutral genuine-AbortSignal guard foundation for
 *  WU5B private object reads. Fail-closed boundary only — no body, readable,
 *  lifecycle, or getStream behavior. Fakes and node:events accounting only;
 *  no AWS/network/storage access.
 *  WU5B1a0a2a1 spec (R3): trusted-provider structural body boundary — an
 *  own data-descriptor `_readableState` is required; NOT an unforgeable
 *  brand (a sufficiently forged structural object passes by design).
 *  WU5B1a0a2a2 spec: trusted-provider Readable state snapshots — the body
 *  guard exposes `initialState` (immutable entry snapshot) and
 *  `readState()` (fresh dynamic snapshot) using module-captured native
 *  `Readable.prototype` `destroyed`/`readableEnded` getters; structural
 *  revalidation runs before EVERY read. Fail-closed boundary only — no
 *  listener/flow/resume/destroy operations, lifecycle, getStream,
 *  HeadObject, or AWS surface. Fakes and node:events accounting only. The
 *  body guard binding is intentionally optional so the RED run fails only
 *  the new tests against unchanged production. */
import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  guardObjectReadSignal,
  type GuardedObjectReadSignal,
} from './safe-object-read-guards';

type ObjectReadBodyState = {
  readonly destroyed: boolean;
  readonly readableEnded: boolean;
};
type GuardedBody = {
  readonly body: Readable;
  readonly initialState: ObjectReadBodyState;
  readState(): ObjectReadBodyState | null;
};
const guardsModule: Record<string, unknown> = jest.requireActual(
  './safe-object-read-guards',
);
const guardObjectReadBody = guardsModule.guardObjectReadBody as
  | ((value: unknown) => GuardedBody | null)
  | undefined;

const abortCount = (s: AbortSignal) => getEventListeners(s, 'abort').length;

/** Defines recording own accessors that must never be read by the guard;
 *  returns the invocation log. */
const poison = (
  obj: Record<string, unknown> | AbortSignal,
  props: string[],
  value?: unknown,
) => {
  const hits: string[] = [];
  for (const p of props)
    Object.defineProperty(obj, p, {
      configurable: true,
      get: () => {
        hits.push(p);
        if (value !== undefined) return value;
        return p === 'aborted' ? false : () => {};
      },
    });
  return hits;
};

describe('guardObjectReadSignal', () => {
  it('fails closed on every non-signal shape', () => {
    const shapes: unknown[] = [
      undefined,
      null,
      true,
      1,
      'x',
      {},
      [],
      () => {},
      Symbol('s'),
    ];
    for (const v of shapes) expect(guardObjectReadSignal(v)).toBeNull();
  });

  it('accepts a genuine non-aborted signal with exact identity, no listeners, no side effects', () => {
    const c = new AbortController();
    const g = guardObjectReadSignal(c.signal);
    expect(g!.signal).toBe(c.signal);
    expect(g!.aborted).toBe(false);
    expect(abortCount(c.signal)).toBe(0);
  });

  it('represents a pre-aborted genuine signal safely for the caller decision', () => {
    const s = AbortSignal.abort();
    const g = guardObjectReadSignal(s);
    expect(g!.signal).toBe(s);
    expect(g!.aborted).toBe(true);
  });

  it('rejects a Proxy before any instanceof evaluation or trap run', () => {
    let traps = 0;
    const p = new Proxy(new AbortController().signal, {
      getPrototypeOf: () => {
        traps++;
        return AbortSignal.prototype;
      },
      get: () => {
        traps++;
        return undefined;
      },
    });
    expect(guardObjectReadSignal(p)).toBeNull();
    expect(traps).toBe(0);
  });

  it('fails closed on a prototype spoof that passes instanceof', () => {
    expect(
      guardObjectReadSignal(Object.create(AbortSignal.prototype)),
    ).toBeNull();
  });

  it('fails closed on duck-typed lookalikes without invoking attacker accessors', () => {
    const lookalike: Record<string, unknown> = {};
    const hits = poison(lookalike, [
      'aborted',
      'addEventListener',
      'removeEventListener',
    ]);
    expect(guardObjectReadSignal(lookalike)).toBeNull();
    expect(hits).toEqual([]);
  });

  it('fails closed on callable-looking forged methods', () => {
    const forged: Record<string, unknown> = {
      aborted: false,
      addEventListener: () => {
        throw new Error('attacker');
      },
      removeEventListener: () => {},
    };
    expect(guardObjectReadSignal(forged)).toBeNull();
  });

  it('reads native aborted once; lying/changing own shadowed accessors are never invoked', () => {
    const c = new AbortController();
    const hits = poison(c.signal, ['aborted'], true);
    const g = guardObjectReadSignal(c.signal);
    expect(g!.signal).toBe(c.signal);
    expect(g!.aborted).toBe(false);
    expect(hits).toEqual([]);
  });

  it('uses captured native listener ops; throwing shadowed add/remove are never invoked', () => {
    const c = new AbortController();
    const calls: string[] = [];
    Object.defineProperty(c.signal, 'addEventListener', {
      configurable: true,
      value: () => {
        calls.push('add');
      },
    });
    Object.defineProperty(c.signal, 'removeEventListener', {
      configurable: true,
      value: () => {
        calls.push('remove');
      },
    });
    const g = guardObjectReadSignal(c.signal)!;
    const l = () => {};
    expect(g.addAbortListener(l)).toBe(true);
    expect(abortCount(c.signal)).toBe(1);
    g.removeAbortListener(l);
    expect(abortCount(c.signal)).toBe(0);
    expect(calls).toEqual([]);
  });

  it('addAbortListener reports native failure without throwing and unwinds to zero listeners', () => {
    const c = new AbortController();
    const g = guardObjectReadSignal(c.signal)!;
    expect(g.addAbortListener(123 as unknown as () => void)).toBe(false);
    expect(abortCount(c.signal)).toBe(0);
    const ok = () => {};
    expect(g.addAbortListener(ok)).toBe(true);
    expect(abortCount(c.signal)).toBe(1);
  });

  it('invokes a registered listener exactly once when the signal aborts', () => {
    const c = new AbortController();
    const g = guardObjectReadSignal(c.signal)!;
    let n = 0;
    expect(g.addAbortListener(() => n++)).toBe(true);
    expect(abortCount(c.signal)).toBe(1);
    c.abort();
    expect(n).toBe(1);
    expect(abortCount(c.signal)).toBe(0);
  });

  it('removeAbortListener removes cleanly and conceals native removal failures', () => {
    const c = new AbortController();
    const g = guardObjectReadSignal(c.signal)!;
    const l = () => {};
    expect(g.addAbortListener(l)).toBe(true);
    expect(() =>
      g.removeAbortListener(123 as unknown as () => void),
    ).not.toThrow();
    g.removeAbortListener(l);
    expect(abortCount(c.signal)).toBe(0);
  });

  it('rejects a non-Proxy value with a Proxy anywhere in its prototype chain before any trap or property access', () => {
    let traps = 0;
    const protoProxy = new Proxy(AbortSignal.prototype, {
      getPrototypeOf: (t) => {
        traps++;
        return Reflect.getPrototypeOf(t);
      },
      get: (t, p) => {
        traps++;
        return Reflect.get(t, p) as unknown;
      },
    });
    const immediate = Object.create(protoProxy) as object;
    const ancestor = Object.create(
      Object.create(protoProxy) as object,
    ) as object;
    for (const v of [immediate, ancestor]) {
      expect(guardObjectReadSignal(v)).toBeNull();
      expect(traps).toBe(0);
    }
  });

  it('add failure unwinds a partially registered native listener; abort never fires it', () => {
    const original: (
      this: EventTarget,
      type: string,
      listener: () => void,
      options?: { once: boolean },
    ) => void =
      // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach of the pristine native add for the seam fixture
      EventTarget.prototype.addEventListener;
    const c = new AbortController();
    let fired = 0;
    const spy = jest.spyOn(
      EventTarget.prototype,
      'addEventListener',
    ) as unknown as jest.Mock;
    spy.mockImplementation(function (this: EventTarget, ...args: unknown[]) {
      original.apply(this, args as Parameters<typeof original>);
      throw new Error('post-registration failure');
    });
    try {
      const holder: { guarded: GuardedObjectReadSignal | null } = {
        guarded: null,
      };
      jest.isolateModules(() => {
        const mod = jest.requireActual<
          typeof import('./safe-object-read-guards')
        >('./safe-object-read-guards');
        holder.guarded = mod.guardObjectReadSignal(c.signal);
      });
      expect(holder.guarded).not.toBeNull();
      expect(
        holder.guarded!.addAbortListener(() => {
          fired++;
        }),
      ).toBe(false);
      expect(abortCount(c.signal)).toBe(0);
      c.abort();
      expect(fired).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('triangulation: invalid inputs are indistinguishably null with zero side effects; re-guarding is independent', () => {
    const c = new AbortController();
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      Object.create(AbortSignal.prototype),
      new Proxy(c.signal, {}),
    ];
    for (const v of invalid) {
      expect(guardObjectReadSignal(v)).toBeNull();
      expect(abortCount(c.signal)).toBe(0);
    }
    const g1 = guardObjectReadSignal(c.signal)!;
    const g2 = guardObjectReadSignal(c.signal)!;
    const l1 = () => {};
    const l2 = () => {};
    expect(g1.addAbortListener(l1)).toBe(true);
    expect(g2.addAbortListener(l2)).toBe(true);
    expect(abortCount(c.signal)).toBe(2);
    g1.removeAbortListener(l1);
    g2.removeAbortListener(l2);
    expect(abortCount(c.signal)).toBe(0);
  });
});

/** Genuine subclass whose own shadowed state accessors and operations are
 *  hostile: throwing/changing/counting and never to be invoked by the guard. */
class HostileBody extends Readable {
  counts: Record<
    | 'destroyed'
    | 'readableEnded'
    | 'on'
    | 'off'
    | 'resume'
    | 'destroy'
    | 'pipe',
    number
  > = {
    destroyed: 0,
    readableEnded: 0,
    on: 0,
    off: 0,
    resume: 0,
    destroy: 0,
    pipe: 0,
  };

  constructor() {
    super({ read() {} });
    Object.defineProperty(this, 'destroyed', {
      configurable: true,
      get: () => {
        this.counts.destroyed++;
        throw new Error('attacker');
      },
    });
    Object.defineProperty(this, 'readableEnded', {
      configurable: true,
      get: () => {
        this.counts.readableEnded++;
        return this.counts.readableEnded > 3;
      },
    });
    const bomb = (key: 'on' | 'off' | 'resume' | 'destroy' | 'pipe') => {
      this.counts[key]++;
      throw new Error('attacker');
    };
    Object.defineProperty(this, 'on', {
      configurable: true,
      value: () => bomb('on'),
    });
    Object.defineProperty(this, 'off', {
      configurable: true,
      value: () => bomb('off'),
    });
    Object.defineProperty(this, 'resume', {
      configurable: true,
      value: () => bomb('resume'),
    });
    Object.defineProperty(this, 'destroy', {
      configurable: true,
      value: () => bomb('destroy'),
    });
    Object.defineProperty(this, 'pipe', {
      configurable: true,
      value: (dest: never) => {
        bomb('pipe');
        return dest;
      },
    });
  }
}

describe('guardObjectReadBody', () => {
  it('fails closed on every non-body shape', () => {
    const shapes: unknown[] = [
      undefined,
      null,
      true,
      1,
      'x',
      {},
      [],
      () => {},
      Symbol('s'),
    ];
    for (const v of shapes) expect(guardObjectReadBody!(v)).toBeNull();
  });

  it('accepts an active paused genuine Readable with exact identity and no listener or flow side effects', () => {
    const r = new Readable({ read() {} });
    const events = ['data', 'readable', 'end', 'close', 'error'] as const;
    const before = events.map((e) => getEventListeners(r, e).length);
    const g = guardObjectReadBody!(r);
    expect(g!.body).toBe(r);
    expect(events.map((e) => getEventListeners(r, e).length)).toEqual(before);
    expect(r.readableFlowing).toBeNull();
    expect(r.readableEnded).toBe(false);
    expect(r.destroyed).toBe(false);
  });

  it('accepts a genuine already-destroyed Readable with exact identity', () => {
    const r = new Readable({ read() {} });
    r.destroy();
    expect(r.destroyed).toBe(true);
    const g = guardObjectReadBody!(r);
    expect(g!.body).toBe(r);
  });

  it('accepts a genuine already-ended Readable with exact identity', async () => {
    const r = new Readable({
      read() {
        this.push(null);
      },
      autoDestroy: false,
    });
    r.resume();
    await finished(r);
    expect(r.readableEnded).toBe(true);
    const g = guardObjectReadBody!(r);
    expect(g!.body).toBe(r);
  });

  it('rejects a direct Proxy before any instanceof evaluation or trap run', () => {
    let traps = 0;
    const p = new Proxy(new Readable({ read() {} }), {
      getPrototypeOf: () => {
        traps++;
        return Readable.prototype;
      },
      get: () => {
        traps++;
        return undefined;
      },
    });
    expect(guardObjectReadBody!(p)).toBeNull();
    expect(traps).toBe(0);
  });

  it('rejects a non-Proxy value with a Proxy anywhere in its prototype chain before any trap or property access', () => {
    let traps = 0;
    const protoProxy = new Proxy(Readable.prototype, {
      getPrototypeOf: (t) => {
        traps++;
        return Reflect.getPrototypeOf(t);
      },
      get: (t, p) => {
        traps++;
        return Reflect.get(t, p) as unknown;
      },
    });
    const immediate = Object.create(protoProxy) as object;
    const ancestor = Object.create(
      Object.create(protoProxy) as object,
    ) as object;
    for (const v of [immediate, ancestor]) {
      expect(guardObjectReadBody!(v)).toBeNull();
      expect(traps).toBe(0);
    }
  });

  it('fails closed on a prototype spoof that passes instanceof', () => {
    expect(guardObjectReadBody!(Object.create(Readable.prototype))).toBeNull();
  });

  it('WU5B1a0a2a1-R3 RED→GREEN: a hostile own _readableState accessor fails closed with zero invocation; hostile state/flow shadows are never read', () => {
    const hostile: object = Object.create(Readable.prototype) as object;
    const hits = poison(hostile as Record<string, unknown>, [
      '_readableState',
      'readable',
      'destroyed',
      'readableFinished',
      'pipe',
      'on',
      'resume',
    ]);
    expect(guardObjectReadBody!(hostile)).toBeNull();
    expect(hits).toEqual([]);
  });

  it('fails closed on duck-typed lookalikes without invoking attacker accessors', () => {
    const lookalike: Record<string, unknown> = {};
    const hits: string[] = [];
    for (const p of [
      'readable',
      'destroyed',
      'readableEnded',
      'on',
      'off',
      'resume',
      'destroy',
      'pipe',
    ])
      Object.defineProperty(lookalike, p, {
        configurable: true,
        get: () => {
          hits.push(p);
          return p === 'readable' || p === 'readableEnded';
        },
      });
    expect(guardObjectReadBody!(lookalike)).toBeNull();
    expect(hits).toEqual([]);
  });

  it('accepts a hostile genuine subclass that shadows state and operations; attacker counters stay zero', () => {
    const h = new HostileBody();
    const g = guardObjectReadBody!(h);
    expect(g!.body).toBe(h);
    for (const count of Object.values(h.counts)) expect(count).toBe(0);
  });

  it('WU5B1a0a2a1-R3: trusted structural boundary — own data-descriptor _readableState required; forged data passes by design (not an unforgeable brand)', () => {
    const real = new Readable({ read() {} });
    const stateProto: object = Object.getPrototypeOf(
      Object.getOwnPropertyDescriptor(real, '_readableState')!.value as object,
    ) as object;
    const rejected: unknown[] = [
      new Proxy(real, {}), // Proxy state
      Object.create(new Proxy(stateProto, {})) as object, // Proxy link in state prototype chain
      null, // null state
      7, // primitive state
    ];
    for (const state of rejected) {
      const r = new Readable({ read() {} });
      Object.defineProperty(r, '_readableState', {
        configurable: true,
        value: state,
      });
      expect(guardObjectReadBody!(r)).toBeNull();
    }
    expect(rejected.length).toBe(4);
    // Trusted-provider structural boundary, NOT an unforgeable brand:
    // a sufficiently forged plain-data _readableState carrying valid
    // boolean internal fields passes by design (WU5B1a0a2a2 refined the
    // forged fixture to carry the booleans the trusted snapshot reads:
    // destroyed + endEmitted, the field behind the native readableEnded
    // getter in this runtime).
    const forged = new Readable({ read() {} });
    Object.defineProperty(forged, '_readableState', {
      configurable: true,
      value: { readable: false, destroyed: false, endEmitted: false },
    });
    expect(guardObjectReadBody!(forged)!.body).toBe(forged);
  });

  it('guarding pushes no data, adds no listener, resumes or destroys nothing', () => {
    const r = new Readable({
      read() {
        this.push('x');
      },
    });
    const events = ['data', 'readable', 'end', 'close', 'error'] as const;
    const before = events.map((e) => getEventListeners(r, e).length);
    expect(guardObjectReadBody!(r)).not.toBeNull();
    expect(events.map((e) => getEventListeners(r, e).length)).toEqual(before);
    expect(r.readableFlowing).toBeNull();
    expect(r.readableEnded).toBe(false);
    expect(r.destroyed).toBe(false);
    const hostile = new HostileBody();
    expect(guardObjectReadBody!(hostile)).not.toBeNull();
    for (const count of Object.values(hostile.counts)) expect(count).toBe(0);
  });

  it('WU5B1a0a2a2: exposes the exact snapshot surface {body, initialState, readState}; no operation/lifecycle surface', () => {
    const g = guardObjectReadBody!(new Readable({ read() {} }))!;
    expect(Object.keys(g)).toEqual(['body', 'initialState', 'readState']);
    expect(typeof (g as unknown as { readState: unknown }).readState).toBe(
      'function',
    );
    const surface = g as unknown as Record<string, unknown>;
    for (const absent of [
      'on',
      'off',
      'resume',
      'destroy',
      'addBodyListener',
      'removeBodyListener',
      'getStream',
      'headObject',
    ])
      expect(surface[absent]).toBeUndefined();
  });

  it('WU5B1a0a2a2 RED→GREEN: initialState snapshots an active body as false/false with exact identity, fresh plain readState, and zero side effects', () => {
    const r = new Readable({ read() {} });
    const events = ['data', 'readable', 'end', 'close', 'error'] as const;
    const before = events.map((e) => getEventListeners(r, e).length);
    const g = guardObjectReadBody!(r);
    expect(g!.body).toBe(r);
    expect(g!.initialState).toEqual({ destroyed: false, readableEnded: false });
    const s1 = g!.readState();
    expect(s1).toEqual({ destroyed: false, readableEnded: false });
    expect(Object.getPrototypeOf(s1!)).toBe(Object.prototype);
    expect(g!.readState()).not.toBe(s1);
    expect(events.map((e) => getEventListeners(r, e).length)).toEqual(before);
    expect(r.readableFlowing).toBeNull();
  });

  it('WU5B1a0a2a2: already-destroyed entry snapshots {destroyed:true, readableEnded:false}', () => {
    const d = new Readable({ read() {} });
    d.destroy();
    expect(d.destroyed).toBe(true);
    expect(d.readableEnded).toBe(false);
    const g = guardObjectReadBody!(d)!;
    expect(g.body).toBe(d);
    expect(g.initialState).toEqual({ destroyed: true, readableEnded: false });
    expect(g.readState()).toEqual({ destroyed: true, readableEnded: false });
  });

  it('WU5B1a0a2a2: already-ended entry snapshots {destroyed:false, readableEnded:true}', async () => {
    const r = new Readable({
      read() {
        this.push(null);
      },
      autoDestroy: false,
    });
    r.resume();
    await finished(r);
    expect(r.readableEnded).toBe(true);
    expect(r.destroyed).toBe(false);
    const g = guardObjectReadBody!(r)!;
    expect(g.body).toBe(r);
    expect(g.initialState).toEqual({ destroyed: false, readableEnded: true });
  });

  it('WU5B1a0a2a2: dynamic transition to ended then destroyed while initialState stays unchanged; snapshots independent and plain', async () => {
    const r = new Readable({
      read() {
        this.push(null);
      },
      autoDestroy: false,
    });
    const g = guardObjectReadBody!(r)!;
    expect(g.initialState).toEqual({ destroyed: false, readableEnded: false });
    const initial = g.initialState;
    r.resume();
    await finished(r);
    const ended = g.readState();
    expect(ended).toEqual({ destroyed: false, readableEnded: true });
    expect(g.initialState).toEqual({ destroyed: false, readableEnded: false });
    expect(ended).not.toBe(initial);
    expect(Object.getPrototypeOf(ended)).toBe(Object.prototype);
    r.destroy();
    const destroyed = g.readState();
    expect(destroyed).toEqual({ destroyed: true, readableEnded: true });
    expect(g.initialState).toEqual({ destroyed: false, readableEnded: false });
    expect(g.readState()).not.toBe(destroyed);
    expect(Object.getPrototypeOf(destroyed!)).toBe(Object.prototype);
  });

  it('WU5B1a0a2a2: own destroyed/readableEnded shadow accessors are never invoked by entry capture or readState', () => {
    const h = new HostileBody();
    const g = guardObjectReadBody!(h)!;
    expect(g.body).toBe(h);
    expect(g.initialState).toEqual({ destroyed: false, readableEnded: false });
    expect(g.readState()).toEqual({ destroyed: false, readableEnded: false });
    for (const count of Object.values(h.counts)) expect(count).toBe(0);
  });

  it('WU5B1a0a2a2: post-guard _readableState accessor substitution fails readState closed with zero getter calls', () => {
    const r = new Readable({ read() {} });
    const g = guardObjectReadBody!(r)!;
    const hits = poison(r as unknown as Record<string, unknown>, [
      '_readableState',
    ]);
    expect(g.readState()).toBeNull();
    expect(hits).toEqual([]);
    expect(g.initialState).toEqual({ destroyed: false, readableEnded: false });
  });

  it('WU5B1a0a2a2: post-guard Proxy state value or prototype mutation fails readState closed with zero traps', () => {
    let traps = 0;
    const trapHandler = {
      get: () => {
        traps++;
        return undefined;
      },
      getPrototypeOf: (t: object) => {
        traps++;
        return Reflect.getPrototypeOf(t);
      },
    };
    const r = new Readable({ read() {} });
    const g = guardObjectReadBody!(r)!;
    Object.defineProperty(r, '_readableState', {
      configurable: true,
      value: new Proxy({}, trapHandler),
    });
    expect(g.readState()).toBeNull();
    expect(traps).toBe(0);
    const r2 = new Readable({ read() {} });
    const g2 = guardObjectReadBody!(r2)!;
    const r2Proto: object = Object.getPrototypeOf(r2) as object;
    Object.setPrototypeOf(r2, new Proxy(r2Proto, trapHandler));
    expect(g2.readState()).toBeNull();
    expect(traps).toBe(0);
    expect(g2.initialState).toEqual({
      destroyed: false,
      readableEnded: false,
    });
  });

  it('WU5B1a0a2a2: non-boolean trusted internal state fields fail the entry snapshot closed', () => {
    const r = new Readable({ read() {} });
    const state = Object.getOwnPropertyDescriptor(r, '_readableState')!
      .value as object;
    Object.defineProperty(state, 'destroyed', {
      configurable: true,
      value: 'corrupted',
    });
    expect(guardObjectReadBody!(r)).toBeNull();
  });

  it('WU5B1a0a2a2: trusted internal state-field failure after entry fails readState closed without leaking', () => {
    const r = new Readable({ read() {} });
    const g = guardObjectReadBody!(r)!;
    const state = Object.getOwnPropertyDescriptor(r, '_readableState')!
      .value as object;
    Object.defineProperty(state, 'destroyed', {
      configurable: true,
      value: 1,
    });
    expect(g.readState()).toBeNull();
    const r2 = new Readable({ read() {} });
    const g2 = guardObjectReadBody!(r2)!;
    const state2 = Object.getOwnPropertyDescriptor(r2, '_readableState')!
      .value as object;
    Object.defineProperty(state2, 'endEmitted', {
      configurable: true,
      get() {
        throw new Error('internal boom');
      },
    });
    expect(g2.readState()).toBeNull();
    expect(g2.initialState).toEqual({
      destroyed: false,
      readableEnded: false,
    });
  });

  it('triangulation: invalid inputs are indistinguishably null with zero side effects; re-guarding preserves identity', () => {
    const r = new Readable({ read() {} });
    const invalid: unknown[] = [
      undefined,
      null,
      0,
      'x',
      {},
      Object.create(Readable.prototype),
      new Proxy(r, {}),
    ];
    for (const v of invalid) {
      expect(guardObjectReadBody!(v)).toBeNull();
      expect(r.destroyed).toBe(false);
      expect(r.readableFlowing).toBeNull();
    }
    const g1 = guardObjectReadBody!(r)!;
    const g2 = guardObjectReadBody!(r)!;
    expect(g1.body).toBe(r);
    expect(g2.body).toBe(r);
    expect(g1).not.toBe(g2);
  });
});

/** WU5B1a0a1 spec: provider-neutral genuine-AbortSignal guard foundation for
 *  WU5B private object reads. Fail-closed boundary only — no body, readable,
 *  lifecycle, or getStream behavior. Fakes and node:events accounting only;
 *  no AWS/network/storage access. */
import { getEventListeners } from 'node:events';
import {
  guardObjectReadSignal,
  type GuardedObjectReadSignal,
} from './safe-object-read-guards';

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

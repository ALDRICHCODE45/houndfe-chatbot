/** WU5B1a0a1: provider-neutral genuine-AbortSignal guard foundation for WU5B
 *  private object reads (GetObject/HeadObject). Fail-closed boundary: only
 *  genuine platform AbortSignal instances are trusted; proxies are rejected
 *  by the `util.types.isProxy` brand gate checked BEFORE any property access
 *  (including `instanceof`, so proxy `getPrototypeOf` traps cannot run); the
 *  native `aborted` getter and EventTarget listener methods are captured once
 *  from the prototypes and invoked with the validated signal as receiver, so
 *  attacker-shadowed or spoofed instance properties are never dynamically
 *  read or invoked. Proxy rejection is chain-wide: because `isProxy` is
 *  shallow, every prototype-chain link is first proven non-Proxy (trap-count
 *  0, using only the captured native `Object.getPrototypeOf`) BEFORE any
 *  brand check, so `instanceof` never walks a Proxy and no trap can run. `aborted` is read exactly once at guard entry; later
 *  abort detection is the caller's, via the guarded listener. Listener add is
 *  fail-closed (reports failure, never throws; a failed native add leaves zero
 *  listeners) and removal failures are swallowed so teardown can never
 *  override a safe result. Raw errors, messages, stacks, and causes are never
 *  retained. Guarding alone adds no listeners and causes no side effects.
 *  WU5B1a0a2a1 (R3): trusted-provider structural body boundary — an own
 *  `_readableState` DATA descriptor (captured non-invoking
 *  `Object.getOwnPropertyDescriptor`) whose value is non-null, non-Proxy,
 *  with a Proxy-free prototype chain; accessor descriptors are rejected
 *  without invocation. NOT an unforgeable brand: a sufficiently forged
 *  structural `_readableState` passes by design. No helper or state
 *  getter runs, so hostile own accessors and readable/destroyed/
 *  readableFinished/pipe/on shadows are never read; guarding adds no
 *  listener, starts no flow, resumes/destroys nothing, and exposes only
 *  the exact body identity. No lifecycle or getStream behavior here. */
import { Readable } from 'node:stream';
import { types as utilTypes } from 'node:util';

/** Any non-primitive value; prototype links are genuinely shapeless (bare `object` params are barred). */
type NonNullObject = object;
const NATIVE_GET_PROTOTYPE_OF: (target: NonNullObject) => NonNullObject | null =
  Object.getPrototypeOf;

export interface GuardedObjectReadSignal {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  addAbortListener(listener: () => void): boolean;
  removeAbortListener(listener: () => void): void;
}

/** Prototype-captured native operations: the genuine `aborted` getter and
 *  EventTarget listener methods are captured once and invoked with the
 *  validated signal as receiver. These captured operations bypass
 *  attacker-shadowed instance properties but do not by themselves reject
 *  proxies — the fail-closed `utilTypes.isProxy` gate is the proxy rejection. */
const NATIVE_ABORTED_GETTER: ((this: AbortSignal) => boolean) | undefined =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated signal receiver
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const NATIVE_ADD_LISTENER: (
  this: EventTarget,
  type: string,
  listener: () => void,
  options?: { once: boolean },
) => void =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated signal receiver
  EventTarget.prototype.addEventListener;
const NATIVE_REMOVE_LISTENER: (
  this: EventTarget,
  type: string,
  listener: () => void,
  options?: { once?: boolean; capture?: boolean },
) => void =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated signal receiver
  EventTarget.prototype.removeEventListener;

export function guardObjectReadSignal(
  value: unknown,
): GuardedObjectReadSignal | null {
  try {
    if (typeof value !== 'object' || value === null) return null;
    // Chain-wide proxy rejection BEFORE brand checking: each link is
    // proven non-Proxy first, then the captured native getPrototypeOf
    // runs only on that known non-Proxy link — zero traps, so the
    // instanceof below never walks a Proxy.
    let current: object | null = value;
    while (current !== null) {
      if (utilTypes.isProxy(current)) return null;
      current = NATIVE_GET_PROTOTYPE_OF(current);
    }
    if (!(value instanceof AbortSignal)) return null;
    if (typeof NATIVE_ABORTED_GETTER !== 'function') return null;
    const aborted = NATIVE_ABORTED_GETTER.call(value);
    if (typeof aborted !== 'boolean') return null;
    return {
      signal: value,
      aborted,
      addAbortListener: (listener) => {
        try {
          NATIVE_ADD_LISTENER.call(value, 'abort', listener, { once: true });
          return true;
        } catch {
          try {
            NATIVE_REMOVE_LISTENER.call(value, 'abort', listener, {
              once: true,
            });
          } catch {
            /* fail-closed: unwind failure stays concealed */
          }
          return false;
        }
      },
      removeAbortListener: (listener) => {
        try {
          NATIVE_REMOVE_LISTENER.call(value, 'abort', listener);
        } catch {
          /* fail-closed: removal failure never overrides a safe teardown */
        }
      },
    };
  } catch {
    return null;
  }
}

/** Captured non-invoking own-descriptor read for the trusted structural
 *  body boundary (trusted AWS-SDK structural check, not an unforgeable
 *  brand; accessor descriptors are rejected without invocation). */
const NATIVE_GET_OWN_PROPERTY_DESCRIPTOR: typeof Object.getOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;

export interface GuardedObjectReadBody {
  readonly body: Readable;
}

export function guardObjectReadBody(
  value: unknown,
): GuardedObjectReadBody | null {
  try {
    if (typeof value !== 'object' || value === null) return null;
    // Chain-wide proxy rejection BEFORE brand checking, reused from the
    // verified signal guard: every prototype-chain link is proven non-Proxy
    // first (trap-count 0), so the instanceof below never walks a Proxy.
    let current: object | null = value;
    while (current !== null) {
      if (utilTypes.isProxy(current)) return null;
      current = NATIVE_GET_PROTOTYPE_OF(current);
    }
    if (!(value instanceof Readable)) return null;
    // Trusted structural boundary, fail-closed: require an OWN
    // `_readableState` DATA descriptor whose value is a non-null,
    // non-Proxy object with a Proxy-free prototype chain. Accessor
    // descriptors are rejected without invocation; no helper, helper
    // getter, or state getter ever runs, so hostile own
    // readable/destroyed/readableFinished/pipe/on shadows are never read
    // and no flow/listener/resume/destroy is caused. NOT an unforgeable
    // brand: a sufficiently forged structural object passes by design.
    if (typeof NATIVE_GET_OWN_PROPERTY_DESCRIPTOR !== 'function') return null;
    const desc = NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value, '_readableState');
    if (desc === undefined) return null;
    if (desc.get !== undefined || desc.set !== undefined) return null;
    const stateValue: unknown = desc.value;
    if (typeof stateValue !== 'object' || stateValue === null) return null;
    if (utilTypes.isProxy(stateValue)) return null;
    let stateLink: object | null = stateValue;
    while (stateLink !== null) {
      if (utilTypes.isProxy(stateLink)) return null;
      stateLink = NATIVE_GET_PROTOTYPE_OF(stateLink);
    }
    return { body: value };
  } catch {
    return null;
  }
}

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
 *  WU5B1a0a2a2 (trusted-provider Readable state snapshots): the body guard
 *  additionally captures an immutable entry snapshot (`initialState`) once
 *  and offers `readState()` fresh dynamic snapshots, using module-captured
 *  native `Readable.prototype` `destroyed`/`readableEnded` getters invoked
 *  with the validated body as receiver — body own shadow getters are never
 *  dynamically read. Because the boundary is explicitly trusted SDK
 *  structural (not unforgeable), internal ReadableState getters are
 *  trusted; but before EVERY state read the body chain is revalidated
 *  Proxy-free and the own `_readableState` DATA descriptor rechecked
 *  (non-null, Proxy-free object/prototype chain), preventing later
 *  accessor/proxy substitution from reaching the trusted getters. Exact
 *  booleans are required and a fresh plain snapshot is returned; every
 *  failure collapses to `null` with no raw error retained. The guard
 *  captures `initialState` once and returns null if it cannot. No
 *  resume/destroy/lifecycle/getStream behavior here.
 *  WU5B1a0a2a3 (trusted-provider body listeners): the body guard adds
 *  `addListener(event, listener): boolean` and `removeListener(event,
 *  listener): void` for exactly `data|end|error|close`. Module-captured
 *  native `Readable.prototype` `on`/`off` are invoked with the validated
 *  body receiver — hostile own on/off/pipe shadows are never read or
 *  invoked. Before EVERY operation the trusted structural validation is
 *  rerun (Proxy-free chain + own `_readableState` DATA descriptor) and
 *  runtime event/listener values are whitelisted/callability-checked
 *  fail-closed. Add failure tries the captured native off with the same
 *  args and returns false; every error is swallowed; removal failures are
 *  swallowed. No resume/destroy/lifecycle/getStream/AWS behavior and no
 *  raw error retention; `data` flow semantics are the caller's choice via
 *  the native add.
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
  /** Immutable entry snapshot captured exactly once at guard time. */
  readonly initialState: ObjectReadBodyState;
  /** Fresh dynamic snapshot; null on every failure. */
  readState(): ObjectReadBodyState | null;
  /** WU5B1a0a2a3: captured-native listener add for `data|end|error|close`;
   *  false on every failure, never throws, unwinds partial registration. */
  addListener(event: ObjectReadBodyListenEvent, listener: () => void): boolean;
  /** WU5B1a0a2a3: captured-native listener removal; never throws. */
  removeListener(event: ObjectReadBodyListenEvent, listener: () => void): void;
}

/** WU5B1a0a2a3: exact runtime listener-event whitelist for body listeners. */
export type ObjectReadBodyListenEvent = 'data' | 'end' | 'error' | 'close';

const BODY_LISTEN_EVENTS: readonly string[] = ['data', 'end', 'error', 'close'];
const isBodyListenEvent = (
  value: unknown,
): value is ObjectReadBodyListenEvent =>
  typeof value === 'string' && BODY_LISTEN_EVENTS.includes(value);

/** Module-captured native `Readable.prototype` listener ops, always invoked
 *  with the validated body receiver so hostile own on/off shadows are never
 *  dynamically read or invoked. */
type NativeBodyListenOp = (
  this: Readable,
  event: string,
  listener: () => void,
) => unknown;
// SAFETY: the EventEmitter on/off overload family is narrowed to the exact
// (event, listener) call shape used here; the narrowed signature matches the
// runtime overload actually resolved for these four string events.
const NATIVE_READABLE_ON: NativeBodyListenOp | undefined =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated body receiver
  Readable.prototype.on;
// SAFETY: same narrowing invariant as the captured on op above.
const NATIVE_READABLE_OFF: NativeBodyListenOp | undefined =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated body receiver
  Readable.prototype.off;

/** WU5B1a0a2a2 snapshot shape: plain, fresh, exact booleans only. */
export type ObjectReadBodyState = {
  readonly destroyed: boolean;
  readonly readableEnded: boolean;
};

/** Module-captured native `Readable.prototype` state getters, always
 *  invoked with the validated body as receiver so body own shadow getters
 *  are never dynamically read. */
const NATIVE_READABLE_DESTROYED_GETTER:
  | ((this: Readable) => boolean)
  | undefined =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated body receiver
  Object.getOwnPropertyDescriptor(Readable.prototype, 'destroyed')?.get;
const NATIVE_READABLE_ENDED_GETTER: ((this: Readable) => boolean) | undefined =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated body receiver
  Object.getOwnPropertyDescriptor(Readable.prototype, 'readableEnded')?.get;

/** Chain-wide proxy rejection (trap-count 0): every prototype-chain link is
 *  proven non-Proxy BEFORE any captured-native `getPrototypeOf` call. */
const isProxyFreePrototypeChain = (value: NonNullObject): boolean => {
  let current: object | null = value;
  while (current !== null) {
    if (utilTypes.isProxy(current)) return false;
    current = NATIVE_GET_PROTOTYPE_OF(current);
  }
  return true;
};

/** Trusted structural body boundary, revalidated before EVERY state read:
 *  an OWN `_readableState` DATA descriptor whose value is a non-null,
 *  non-Proxy object with a Proxy-free prototype chain; accessor
 *  descriptors are rejected without invocation. NOT an unforgeable brand. */
const hasTrustedReadableStateShape = (body: NonNullObject): boolean => {
  if (typeof NATIVE_GET_OWN_PROPERTY_DESCRIPTOR !== 'function') return false;
  const desc = NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(body, '_readableState');
  if (desc === undefined) return false;
  if (desc.get !== undefined || desc.set !== undefined) return false;
  const stateValue: unknown = desc.value;
  if (typeof stateValue !== 'object' || stateValue === null) return false;
  if (utilTypes.isProxy(stateValue)) return false;
  let stateLink: object | null = stateValue;
  while (stateLink !== null) {
    if (utilTypes.isProxy(stateLink)) return false;
    stateLink = NATIVE_GET_PROTOTYPE_OF(stateLink);
  }
  return true;
};

/** Reads one fresh trusted-provider state snapshot. Structural revalidation
 *  runs before EVERY read so later accessor/proxy substitution cannot reach
 *  the trusted internal getters; exact booleans are required; every
 *  failure — including trusted internal getter failures — collapses to
 *  null with no raw error, message, stack, or cause retained. Causes no
 *  listener, flow, resume, or destroy operation. */
const readTrustedBodyState = (body: Readable): ObjectReadBodyState | null => {
  try {
    if (typeof NATIVE_READABLE_DESTROYED_GETTER !== 'function') return null;
    if (typeof NATIVE_READABLE_ENDED_GETTER !== 'function') return null;
    if (!isProxyFreePrototypeChain(body)) return null;
    if (!hasTrustedReadableStateShape(body)) return null;
    const destroyed = NATIVE_READABLE_DESTROYED_GETTER.call(body);
    if (typeof destroyed !== 'boolean') return null;
    const readableEnded = NATIVE_READABLE_ENDED_GETTER.call(body);
    if (typeof readableEnded !== 'boolean') return null;
    return { destroyed, readableEnded };
  } catch {
    return null;
  }
};

export function guardObjectReadBody(
  value: unknown,
): GuardedObjectReadBody | null {
  try {
    if (typeof value !== 'object' || value === null) return null;
    // Chain-wide proxy rejection BEFORE brand checking, reused from the
    // verified signal guard: every prototype-chain link is proven non-Proxy
    // first (trap-count 0), so the instanceof below never walks a Proxy.
    if (!isProxyFreePrototypeChain(value)) return null;
    if (!(value instanceof Readable)) return null;
    // Trusted structural boundary, fail-closed: require an OWN
    // `_readableState` DATA descriptor (see hasTrustedReadableStateShape).
    // NOT an unforgeable brand: a sufficiently forged structural object
    // passes by design.
    if (!hasTrustedReadableStateShape(value)) return null;
    // WU5B1a0a2a2: capture the immutable entry snapshot exactly once; the
    // guard fails closed to null if the snapshot cannot be captured.
    const initialState = readTrustedBodyState(value);
    if (initialState === null) return null;
    return {
      body: value,
      initialState,
      readState: () => readTrustedBodyState(value),
      addListener: (event, listener) => {
        try {
          if (!isBodyListenEvent(event)) return false;
          if (typeof listener !== 'function') return false;
          if (
            typeof NATIVE_READABLE_ON !== 'function' ||
            typeof NATIVE_READABLE_OFF !== 'function'
          )
            return false;
          // Trusted structural revalidation before EVERY operation.
          if (!isProxyFreePrototypeChain(value)) return false;
          if (!hasTrustedReadableStateShape(value)) return false;
          NATIVE_READABLE_ON.call(value, event, listener);
          return true;
        } catch {
          try {
            // Unwind a partial registration with the same args; all
            // errors swallowed.
            if (
              isBodyListenEvent(event) &&
              typeof listener === 'function' &&
              typeof NATIVE_READABLE_OFF === 'function'
            )
              NATIVE_READABLE_OFF.call(value, event, listener);
          } catch {
            /* fail-closed: unwind failure stays concealed */
          }
          return false;
        }
      },
      removeListener: (event, listener) => {
        try {
          if (!isBodyListenEvent(event)) return;
          if (typeof listener !== 'function') return;
          if (typeof NATIVE_READABLE_OFF !== 'function') return;
          // Trusted structural revalidation before EVERY operation.
          if (!isProxyFreePrototypeChain(value)) return;
          if (!hasTrustedReadableStateShape(value)) return;
          NATIVE_READABLE_OFF.call(value, event, listener);
        } catch {
          /* fail-closed: removal failure never overrides safe teardown */
        }
      },
    };
  } catch {
    return null;
  }
}

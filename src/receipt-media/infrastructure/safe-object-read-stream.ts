import { PassThrough, type Readable } from 'node:stream';
import {
  guardObjectReadSignal,
  type GuardedObjectReadBody,
  type GuardedObjectReadSignal,
} from './safe-object-read-guards';
export type SafeObjectReadStreamSetupReason =
  | 'SOURCE_UNAVAILABLE'
  | 'ABORTED'
  | 'PAUSE_FAILED'
  | 'REGISTRATION_FAILED'
  | 'SOURCE_TERMINATED'
  | 'RESUME_FAILED';
export type SafeObjectReadStreamErrorCode =
  | 'SOURCE_ERROR'
  | 'SOURCE_CLOSED'
  | 'INVALID_CHUNK'
  | 'ABORTED'
  | 'CONSUMER_CLOSED';
export class SafeObjectReadStreamError extends Error {
  constructor(readonly code: SafeObjectReadStreamErrorCode) {
    super(`receipt-media:SAFE_OBJECT_READ_STREAM/${code}`);
  }
}
export type SafeObjectReadStreamResult =
  | { ok: true; stream: Readable }
  | { ok: false; reason: SafeObjectReadStreamSetupReason };
const unavailable = (body: GuardedObjectReadBody): boolean => {
  const state = body.readState();
  return state === null || state.destroyed || state.readableEnded;
};
const chunk = (value: unknown): Buffer | string | null => {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
  return value instanceof Uint8Array ? Buffer.from(value) : null;
};
export function createSafeObjectReadStream(
  body: GuardedObjectReadBody,
  signal?: GuardedObjectReadSignal,
): SafeObjectReadStreamResult {
  if (
    body.initialState.destroyed ||
    body.initialState.readableEnded ||
    unavailable(body)
  )
    return { ok: false, reason: 'SOURCE_UNAVAILABLE' };
  if (signal?.aborted) return { ok: false, reason: 'ABORTED' };
  if (!body.pause()) {
    body.destroy();
    return { ok: false, reason: 'PAUSE_FAILED' };
  }
  if (unavailable(body)) {
    body.destroy();
    return { ok: false, reason: 'SOURCE_TERMINATED' };
  }
  const output = new PassThrough();
  let complete = false;
  let terminal = false;
  let settingUp = true;
  let setupTerminated = false;
  let cleaned = false;
  let draining = false;
  let awaitingSourceTermination = false;
  const duringSetup = () => {
    if (!settingUp) return false;
    setupTerminated = true;
    return true;
  };
  const sourceTerminated = () => {
    if (!terminal) return false;
    cleanup();
    return true;
  };
  const onData = (value?: unknown) => {
    if (duringSetup() || terminal) return;
    if (draining) return fail('SOURCE_ERROR');
    const safeChunk = chunk(value);
    if (safeChunk === null) return fail('INVALID_CHUNK');
    if (!output.write(safeChunk)) {
      draining = true;
      output.once('drain', onDrain);
      if (!body.pause()) fail('SOURCE_ERROR');
    }
  };
  const onEnd = () => {
    if (duringSetup() || terminal) return;
    complete = true;
    output.end();
    cleanup();
  };
  const onError = () => {
    if (!duringSetup() && !sourceTerminated()) fail('SOURCE_ERROR', false);
  };
  const onClose = () => {
    if (duringSetup() || sourceTerminated()) return;
    if (!complete) fail('SOURCE_CLOSED', false);
  };
  const onAbort = () => {
    if (!duringSetup() && !terminal) fail('ABORTED');
  };
  const onDrain = () => {
    if (!draining) return;
    draining = false;
    if (!terminal && !body.resume()) fail('SOURCE_ERROR');
  };
  const onOutputClose = () => {
    if (!complete && !terminal) fail('CONSUMER_CLOSED');
    else if (!awaitingSourceTermination) cleanup();
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const [event, listener] of registrations)
      body.removeListener(event, listener);
    if (signal) signal.removeAbortListener(onAbort);
    if (draining) output.removeListener('drain', onDrain);
    output.removeListener('close', onOutputClose);
  };
  const fail = (code: SafeObjectReadStreamErrorCode, destroySource = true) => {
    if (terminal) return;
    terminal = true;
    const error = new SafeObjectReadStreamError(code);
    output.destroy(error);
    if (!destroySource) return cleanup();
    awaitingSourceTermination = true;
    if (!body.destroy(error)) cleanup();
  };
  const rejectSetup = (reason: SafeObjectReadStreamSetupReason) => {
    terminal = true;
    output.destroy();
    body.destroy();
    cleanup();
    return { ok: false as const, reason };
  };
  const registrations: ['error' | 'end' | 'close' | 'data', () => void][] = [
    ['error', onError],
    ['end', onEnd],
    ['close', onClose],
    ['data', onData],
  ];
  output.once('close', onOutputClose);
  for (const [event, listener] of registrations)
    if (!body.addListener(event, listener))
      return rejectSetup('REGISTRATION_FAILED');
  if (signal && !signal.addAbortListener(onAbort))
    return rejectSetup('REGISTRATION_FAILED');
  const currentSignal = signal ? guardObjectReadSignal(signal.signal) : null;
  if (
    (signal && (currentSignal === null || currentSignal.aborted)) ||
    setupTerminated ||
    unavailable(body)
  )
    return rejectSetup(
      currentSignal?.aborted ? 'ABORTED' : 'SOURCE_TERMINATED',
    );
  settingUp = false;
  if (!body.resume()) return rejectSetup('RESUME_FAILED');
  return { ok: true, stream: output };
}

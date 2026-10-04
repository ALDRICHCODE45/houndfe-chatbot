import { classifyExpirationApplication } from './expiration-application-policy';

/**
 * Pure, INACTIVE EXPIRATION application classification. Trusted caller supplies
 * `senderId`/`branchId`; the reservation is the original ACTIVE EXPIRATION
 * context and the decision is the current backend projection. No I/O, no send,
 * no ACK, no current-browsing inspection: changing what the customer browses
 * must never rebind this observation. `within_window` is descriptive only and
 * authorizes nothing; `expired` is not STALE or delivery evidence.
 */
const S = 'whatsapp:+5215500000001';
const B = 'sucursal-centro';
const OTHER = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SRC = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const DID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const RA = '2026-06-23T08:00:00.000Z';
const AB = '2026-06-24T08:00:00.000Z';

type Rec = Record<string, unknown>;

const intake = (o: Rec = {}) => ({
  sourceRequestId: SRC,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: VARIANT,
  ...o,
});
const reservation = (o: Rec = {}) => ({
  status: 'ACTIVE',
  route: 'EXPIRATION',
  senderId: S,
  requestKey: SRC,
  intake: intake(),
  ...o,
});
const snapshot = (o: Rec = {}) => ({
  branchId: B,
  branchName: 'Centro',
  productId: PRODUCT,
  productName: 'Croquetas',
  unit: 'PZA',
  variantId: VARIANT,
  variantName: 'Senior',
  variantOption: 'Tamaño',
  variantValue: '15 kg',
  ...o,
});
const decision = (o: Rec = {}) => ({
  id: DID,
  sourceRequestId: SRC,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: '2026-06-22T10:00:00.000Z',
  snapshot: snapshot(),
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
  ...o,
});
const provide = (o: Rec = {}) => ({
  action: 'PROVIDE_EXPIRATION_TEXT',
  expirationText: 'Vence 03/2027',
  resolvedAt: RA,
  ...o,
});
const unavailable = (o: Rec = {}) => ({
  action: 'REPORT_EXPIRATION_UNAVAILABLE',
  resolvedAt: RA,
  ...o,
});
const resolved = (resolution: Rec, o: Rec = {}) =>
  decision({
    status: 'RESOLVED',
    version: 2,
    resolution,
    applyBefore: AB,
    ...o,
  });
const input = (o: Rec = {}) => ({
  senderId: S,
  branchId: B,
  reservation: reservation(),
  backendDecisionId: DID,
  decision: resolved(provide()),
  now: RA,
  ...o,
});

const pending = { classification: 'pending' };
const within = { classification: 'within_window' };
const expired = { classification: 'expired' };
const heldInput = { classification: 'held', reason: 'malformed_input' };
const heldClock = { classification: 'held', reason: 'invalid_clock' };
const heldContext = { classification: 'held', reason: 'invalid_context' };
const heldBefore = {
  classification: 'held',
  reason: 'clock_before_resolution',
};

describe('classifyExpirationApplication', () => {
  it('classifies PENDING and both resolved actions inside the window', () => {
    expect(
      classifyExpirationApplication(input({ decision: decision() })),
    ).toEqual(pending);
    for (const resolution of [provide(), unavailable()]) {
      expect(
        classifyExpirationApplication(
          input({ decision: resolved(resolution) }),
        ),
      ).toEqual(within);
    }
  });

  it('enforces the half-open [resolvedAt, applyBefore) boundaries', () => {
    expect(classifyExpirationApplication(input({ now: RA }))).toEqual(within);
    expect(
      classifyExpirationApplication(input({ now: '2026-06-24T07:59:59.999Z' })),
    ).toEqual(within);
    expect(classifyExpirationApplication(input({ now: AB }))).toEqual(expired);
    expect(
      classifyExpirationApplication(input({ now: '2026-06-24T08:00:00.001Z' })),
    ).toEqual(expired);
    expect(
      classifyExpirationApplication(input({ now: '2026-06-23T07:59:59.999Z' })),
    ).toEqual(heldBefore);
  });

  it('holds a noncanonical or non-string clock fail-closed', () => {
    for (const now of [
      '',
      'x',
      '2026-06-23',
      '2026-06-23T08:00:00Z',
      '2026-06-23T08:00:00.000+00:00',
      '2026-06-23T08:00:00.000z',
      1,
      null,
      undefined,
      {},
    ]) {
      expect(classifyExpirationApplication(input({ now }))).toEqual(heldClock);
    }
  });

  it('holds every mismatched or foreign binding as invalid context', () => {
    for (const over of [
      { senderId: 'whatsapp:+5215500000999' },
      { branchId: OTHER },
      { backendDecisionId: OTHER },
      { backendDecisionId: DID.toUpperCase() },
      { backendDecisionId: null },
      { decision: resolved(provide(), { id: OTHER }) },
      { decision: decision({ sourceRequestId: OTHER }) },
      { reservation: reservation({ requestKey: OTHER }) },
      { reservation: reservation({ intake: intake({ productId: OTHER }) }) },
      {
        decision: resolved(provide(), {
          snapshot: snapshot({ productId: OTHER }),
        }),
      },
      { decision: decision({ snapshot: snapshot({ productId: OTHER }) }) },
      { reservation: reservation({ senderId: OTHER }) },
      { reservation: reservation({ requestKey: SRC.toUpperCase() }) },
      { reservation: 'absent' },
      { reservation: 'unknown' },
      { reservation: reservation({ status: 'CLOSED' }) },
      { reservation: reservation({ route: 'RESTOCK' }) },
      {
        reservation: reservation({ intake: { ...intake(), productId: 'bad' } }),
      },
      { reservation: reservation({ intake: { ...intake(), extra: 1 } }) },
      {
        decision: resolved(provide(), {
          snapshot: snapshot({ branchId: 'x' }),
        }),
      },
      { decision: null },
      { decision: {} },
      {
        decision: resolved(provide(), {
          applyBefore: '2026-06-24T09:00:00.000Z',
        }),
      },
      {
        decision: resolved(provide(), {
          applyBefore: '2026-06-24T07:59:59.999Z',
        }),
      },
    ]) {
      expect(classifyExpirationApplication(input(over))).toEqual(heldContext);
    }
  });

  it('binds a null variant exactly on both sides', () => {
    const simpleIntake = intake({ variantId: null });
    const simpleSnap = snapshot({
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    });
    const read = reservation({ intake: simpleIntake });
    expect(
      classifyExpirationApplication(
        input({
          reservation: read,
          decision: decision({ snapshot: simpleSnap }),
        }),
      ),
    ).toEqual(pending);
    // variant reservation vs simple decision, and the inverse, stay invalid.
    expect(
      classifyExpirationApplication(
        input({ reservation: read, decision: decision() }),
      ),
    ).toEqual(heldContext);
    expect(
      classifyExpirationApplication(
        input({ decision: decision({ snapshot: simpleSnap }) }),
      ),
    ).toEqual(heldContext);
  });

  it('preserves source casing instead of folding it', () => {
    const upper = SRC.toUpperCase();
    const read = reservation({
      requestKey: upper,
      intake: intake({ sourceRequestId: upper }),
    });
    expect(classifyExpirationApplication(input({ reservation: read }))).toEqual(
      heldContext,
    );
  });

  it('matches an opaque branch by exact bytes, holding padded variants', () => {
    const opaque = ' branch-9 ';
    const snap = snapshot({ branchId: opaque });
    expect(
      classifyExpirationApplication(
        input({ branchId: opaque, decision: decision({ snapshot: snap }) }),
      ),
    ).toEqual(pending);
    expect(
      classifyExpirationApplication(
        input({ branchId: 'branch-9', decision: decision({ snapshot: snap }) }),
      ),
    ).toEqual(heldContext);
    expect(
      classifyExpirationApplication(
        input({
          branchId: opaque,
          decision: decision({ snapshot: snapshot({ branchId: 'branch-9' }) }),
        }),
      ),
    ).toEqual(heldContext);
    expect(classifyExpirationApplication(input({ branchId: '   ' }))).toEqual(
      heldInput,
    );
  });

  it('fails closed on malformed, accessor, proxy and hostile inputs', () => {
    const accessor = {} as Rec;
    for (const [k, v] of Object.entries(input())) {
      Object.defineProperty(accessor, k, { get: () => v, enumerable: true });
    }
    const accessorIntake = Object.defineProperty({ ...intake() }, 'productId', {
      get: () => PRODUCT,
    });
    const hostileDecision = new Proxy(decision(), {
      ownKeys: () => {
        throw new Error('boom');
      },
    });
    for (const value of [
      undefined,
      null,
      {},
      { ...input(), extra: 1 },
      new Proxy(input(), { get: () => 'tampered' }),
      accessor,
      input({ reservation: reservation({ intake: accessorIntake }) }),
      input({ decision: hostileDecision }),
    ]) {
      expect(() => classifyExpirationApplication(value)).not.toThrow();
      expect(classifyExpirationApplication(value).classification).toBe('held');
    }
  });

  it('returns minimal classifications with no authority payload', () => {
    const out = classifyExpirationApplication(input());
    expect(out).toEqual(within);
    expect(JSON.stringify(out)).not.toMatch(
      /send|author|stale|ack|attempt|provider|deliver/i,
    );
  });
});

import { ExpirationApplicationClassifier } from './expiration-application-classifier';
import { ExpirationExistingDecisionService } from './expiration-existing-decision.service';

/**
 * INACTIVE EXPIRATION application composition. The REAL reader->GET service and
 * the REAL pure policy run together; only the reader/backend ports and the clock
 * are controlled. It samples the clock exactly once AFTER the GET await, so the
 * classification uses the post-latency instant, and it short-circuits held or
 * failed reads before the clock. Nothing here authorizes a send, ACK, STALE or
 * reservation change, and changed browsing must not rebind the original inquiry.
 */
const SENDER = 'whatsapp:+5215500000001';
const BRANCH = 'sucursal-centro';
const SRC = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const OTHER = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const AT = '2026-06-23T08:00:00.000Z';
const BEFORE = '2026-06-24T08:00:00.000Z';

type Over = Record<string, unknown>;
const intake = (o: Over = {}) => ({
  sourceRequestId: SRC,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: VARIANT,
  ...o,
});
const reservation = (o: Over = {}) => ({
  status: 'ACTIVE',
  route: 'EXPIRATION',
  senderId: SENDER,
  requestKey: SRC,
  intake: intake(),
  ...o,
});
const context = (o: Over = {}) => ({
  reservation: reservation(),
  backendDecisionId: ID,
  postAttemptedAt: '2026-06-23T07:58:00.000Z',
  receiptRecordedAt: '2026-06-23T07:59:00.000Z',
  ...o,
});
const snapshot = (o: Over = {}) => ({
  branchId: BRANCH,
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
const decision = (o: Over = {}) => ({
  id: ID,
  sourceRequestId: SRC,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: AT,
  snapshot: snapshot(),
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
  ...o,
});
const provided = (o: Over = {}) => ({
  action: 'PROVIDE_EXPIRATION_TEXT',
  expirationText: 'Vence 03/2027',
  resolvedAt: AT,
  ...o,
});
const notAvailable = (o: Over = {}) => ({
  action: 'REPORT_EXPIRATION_UNAVAILABLE',
  resolvedAt: AT,
  ...o,
});
const resolved = (resolution: unknown, o: Over = {}) =>
  decision({
    status: 'RESOLVED',
    version: 2,
    resolution,
    applyBefore: BEFORE,
    ...o,
  });

const pending = {
  stage: 'classified',
  classification: { classification: 'pending' },
};
const within = {
  stage: 'classified',
  classification: { classification: 'within_window' },
};
const expired = {
  stage: 'classified',
  classification: { classification: 'expired' },
};
const heldClock = {
  stage: 'classified',
  classification: { classification: 'held', reason: 'invalid_clock' },
};
const heldBefore = {
  stage: 'classified',
  classification: { classification: 'held', reason: 'clock_before_resolution' },
};
const queryHeld = { stage: 'query_held' };
const queryFailed = { stage: 'query_failed' };

interface SetupOptions {
  read?: unknown;
  decision?: unknown;
  branch?: string;
  failRead?: boolean;
  failGet?: boolean;
  now?: Date;
}

function setup(o: SetupOptions = {}) {
  const readRecordedForSender: jest.Mock = jest
    .fn()
    .mockResolvedValue(
      'read' in o ? o.read : { action: 'recorded', context: context() },
    );
  const getExpirationDecision: jest.Mock = jest
    .fn()
    .mockResolvedValue('decision' in o ? o.decision : decision());
  if (o.failRead) readRecordedForSender.mockRejectedValue(new Error('db'));
  if (o.failGet) getExpirationDecision.mockRejectedValue(new Error('GET'));
  const service = new ExpirationExistingDecisionService(
    { readRecordedForSender },
    { getExpirationDecision },
    o.branch ?? BRANCH,
  );
  const readSpy = jest.spyOn(service, 'readExistingDecision');
  const clock = jest.fn(() => o.now ?? new Date(AT));
  const classifier = new ExpirationApplicationClassifier(service, clock);
  return {
    classifier,
    service,
    readRecordedForSender,
    getExpirationDecision,
    readSpy,
    clock,
  };
}
const classify = (f: ReturnType<typeof setup>, senderId = SENDER) =>
  f.classifier.classify(senderId);

describe('ExpirationApplicationClassifier', () => {
  it('classifies pending and both resolved actions, one read and one GET', async () => {
    const f = setup();
    await expect(classify(f)).resolves.toEqual(pending);
    expect(f.readSpy).toHaveBeenCalledTimes(1);
    expect(f.readSpy).toHaveBeenCalledWith(SENDER);
    expect(f.readRecordedForSender).toHaveBeenCalledTimes(1);
    expect(f.getExpirationDecision).toHaveBeenCalledTimes(1);
    for (const resolution of [provided(), notAvailable()]) {
      await expect(
        classify(setup({ decision: resolved(resolution) })),
      ).resolves.toEqual(within);
    }
  });

  it.each<[string, string, unknown]>([
    ['resolvedAt inclusive', AT, within],
    ['applyBefore minus 1ms', '2026-06-24T07:59:59.999Z', within],
    ['applyBefore exclusive', BEFORE, expired],
    ['after applyBefore', '2026-06-24T08:00:00.001Z', expired],
    ['before resolution', '2026-06-23T07:59:59.999Z', heldBefore],
  ])(
    'enforces the half-open window for both actions (%s)',
    async (_label, now, expected) => {
      for (const resolution of [provided(), notAvailable()]) {
        const f = setup({
          decision: resolved(resolution),
          now: new Date(now),
        });
        await expect(classify(f)).resolves.toEqual(expected);
      }
    },
  );

  it.each<[string, SetupOptions]>([
    ['missing receipt', { read: { action: 'missing' } }],
    ['unknown receipt', { read: { action: 'unknown' } }],
    ['absent context', { read: { action: 'recorded', context: null } }],
    [
      'foreign sender',
      {
        read: {
          action: 'recorded',
          context: context({ reservation: reservation({ senderId: OTHER }) }),
        },
      },
    ],
    [
      'foreign requestKey',
      {
        read: {
          action: 'recorded',
          context: context({ reservation: reservation({ requestKey: OTHER }) }),
        },
      },
    ],
    [
      'malformed intake',
      {
        read: {
          action: 'recorded',
          context: context({
            reservation: reservation({ intake: intake({ productId: 'bad' }) }),
          }),
        },
      },
    ],
    [
      'noncanonical persisted id',
      {
        read: {
          action: 'recorded',
          context: context({ backendDecisionId: ID.toUpperCase() }),
        },
      },
    ],
  ])(
    'reports query_held with no GET and no clock for %s',
    async (_label, o) => {
      const f = setup(o);
      await expect(classify(f)).resolves.toEqual(queryHeld);
      expect(f.getExpirationDecision).not.toHaveBeenCalled();
      expect(f.clock).not.toHaveBeenCalled();
    },
  );

  it.each<[string, SetupOptions]>([
    ['foreign source', { decision: decision({ sourceRequestId: OTHER }) }],
    [
      'foreign product',
      { decision: decision({ snapshot: snapshot({ productId: OTHER }) }) },
    ],
    [
      'foreign variant',
      {
        decision: decision({
          snapshot: snapshot({ variantId: OTHER, variantName: 'Otra' }),
        }),
      },
    ],
    [
      'foreign branch',
      { decision: decision({ snapshot: snapshot({ branchId: 'otra' }) }) },
    ],
  ])(
    'reports query_held after the GET and never reads the clock for %s',
    async (_label, o) => {
      const f = setup(o);
      await expect(classify(f)).resolves.toEqual(queryHeld);
      expect(f.getExpirationDecision).toHaveBeenCalledTimes(1);
      expect(f.clock).not.toHaveBeenCalled();
    },
  );

  it.each<[string, SetupOptions]>([
    ['reader throw', { failRead: true }],
    ['backend throw', { failGet: true }],
    ['malformed decision', { decision: {} }],
    ['id mismatch', { decision: decision({ id: OTHER }) }],
  ])('reports query_failed with no clock for %s', async (_label, o) => {
    const f = setup(o);
    await expect(classify(f)).resolves.toEqual(queryFailed);
    expect(f.clock).not.toHaveBeenCalled();
  });

  it('reports classified held invalid_clock for invalid and throwing clocks', async () => {
    const invalid = setup({ now: new Date('not-a-date') });
    await expect(classify(invalid)).resolves.toEqual(heldClock);
    const throwing = setup();
    throwing.clock.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(classify(throwing)).resolves.toEqual(heldClock);
  });

  it('samples the clock once after the GET resolves and expires on the boundary', async () => {
    let getStarted = false;
    let resolveGet!: (value: unknown) => void;
    const getExpirationDecision: jest.Mock = jest.fn(
      () =>
        new Promise((resolve) => {
          getStarted = true;
          resolveGet = resolve;
        }),
    );
    const service = new ExpirationExistingDecisionService(
      {
        readRecordedForSender: jest
          .fn()
          .mockResolvedValue({ action: 'recorded', context: context() }),
      },
      { getExpirationDecision },
      BRANCH,
    );
    let now = new Date('2026-06-24T07:00:00.000Z');
    const clock = jest.fn(() => now);
    const classifier = new ExpirationApplicationClassifier(service, clock);
    const inFlight = classifier
      .classify(SENDER)
      .catch((error: unknown) => ({ rejected: error }));
    for (let tick = 0; tick < 10 && !getStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(getStarted).toBe(true);
    // The GET is pending and the clock has not been sampled yet.
    expect(clock).not.toHaveBeenCalled();
    now = new Date(BEFORE);
    resolveGet(resolved(provided()));
    await expect(inFlight).resolves.toEqual(expired);
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it('keeps the pre-await binding when the reader context mutates during the GET', async () => {
    const raw = context();
    const getExpirationDecision: jest.Mock = jest.fn(() => {
      raw.reservation.intake.productId = OTHER;
      raw.reservation.senderId = 'mutated';
      raw.backendDecisionId = OTHER;
      return Promise.resolve(decision());
    });
    const service = new ExpirationExistingDecisionService(
      {
        readRecordedForSender: jest
          .fn()
          .mockResolvedValue({ action: 'recorded', context: raw }),
      },
      { getExpirationDecision },
      BRANCH,
    );
    const classifier = new ExpirationApplicationClassifier(
      service,
      () => new Date(AT),
    );
    // The real service detaches/freezes the binding BEFORE the GET, so the policy
    // rebinds the ORIGINAL sender/product and still classifies the original
    // inquiry; the mutated browsing context is ignored and the GET id is the
    // persisted one. This also exercises the normalized-decision round-trip.
    await expect(classifier.classify(SENDER)).resolves.toEqual(pending);
    expect(getExpirationDecision).toHaveBeenCalledWith(ID);
  });

  it('classifies a null variant and an opaque configured branch byte-for-byte', async () => {
    const simple = context({
      reservation: reservation({ intake: intake({ variantId: null }) }),
    });
    const simpleSnap = snapshot({
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    });
    await expect(
      classify(
        setup({
          read: { action: 'recorded', context: simple },
          decision: decision({ snapshot: simpleSnap }),
        }),
      ),
    ).resolves.toEqual(pending);
    const opaque = 'sucursal:centro/01 ';
    await expect(
      classify(
        setup({
          branch: opaque,
          decision: decision({ snapshot: snapshot({ branchId: opaque }) }),
        }),
      ),
    ).resolves.toEqual(pending);
    // The service, not the policy, is the single owner of the branch binding:
    // a byte-for-byte mismatch is a fail-closed query_held with no clock read.
    await expect(
      classify(
        setup({
          branch: opaque,
          decision: decision({
            snapshot: snapshot({ branchId: 'sucursal:centro/01' }),
          }),
        }),
      ),
    ).resolves.toEqual(queryHeld);
  });

  it('returns a minimal, frozen stage union with no authority payload', async () => {
    const result = await classify(setup({ decision: resolved(provided()) }));
    expect(result).toEqual(within);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['classification', 'stage']);
    expect(JSON.stringify(result)).not.toMatch(
      /send|author|stale|ack|attempt|provider|deliver/i,
    );
  });

  it('does not mutate the reader context it classifies', async () => {
    const raw = context();
    await classify(setup({ read: { action: 'recorded', context: raw } }));
    expect(raw).toEqual(context());
  });
});

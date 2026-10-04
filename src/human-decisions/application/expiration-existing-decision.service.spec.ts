import {
  AuthError,
  ForbiddenError,
  RateLimitError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { ExpirationExistingDecisionService } from './expiration-existing-decision.service';

/**
 * INACTIVE EXPIRATION reader->GET composition (mocked ports: no DI/HTTP/DB/
 * runtime). It reads the recorded receipt, queries ONLY the persisted decision
 * id, and validates origin, branch, product and variant without folding bytes.
 * A RESOLVED past its deadline is still resolved: no send-eligibility claim.
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
const context = (o: Over = {}) => ({
  reservation: {
    status: 'ACTIVE',
    route: 'EXPIRATION',
    senderId: SENDER,
    requestKey: SRC,
    intake: intake(),
  },
  backendDecisionId: ID,
  ...o,
});
const binding = (o: { inlet?: Over; branch?: string; id?: string } = {}) => ({
  reservation: {
    status: 'ACTIVE',
    route: 'EXPIRATION',
    senderId: SENDER,
    requestKey: SRC,
    intake: intake(o.inlet),
  },
  backendDecisionId: o.id ?? ID,
  branchId: o.branch ?? BRANCH,
});
const bindingOf = (result: unknown) =>
  (result as { binding: ReturnType<typeof binding> }).binding;
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

function setup(
  o: {
    read?: unknown;
    decision?: unknown;
    branch?: string;
    failRead?: boolean;
  } = {},
) {
  const readRecordedForSender: jest.Mock = jest
    .fn()
    .mockResolvedValue(
      'read' in o ? o.read : { action: 'recorded', context: context() },
    );
  const getExpirationDecision: jest.Mock = jest
    .fn()
    .mockResolvedValue('decision' in o ? o.decision : decision());
  if (o.failRead) readRecordedForSender.mockRejectedValue(new Error('db'));
  return {
    service: new ExpirationExistingDecisionService(
      { readRecordedForSender },
      { getExpirationDecision },
      o.branch ?? BRANCH,
    ),
    readRecordedForSender,
    getExpirationDecision,
  };
}
const ask = (f: ReturnType<typeof setup>, senderId = SENDER) =>
  f.service.readExistingDecision(senderId);
const held = { outcome: 'held' };
const failed = { outcome: 'query_failed' };

describe('ExpirationExistingDecisionService', () => {
  it('reports pending from a validated GET keyed only by the persisted id', async () => {
    const f = setup();
    const result = await ask(f);
    expect(result).toEqual({
      outcome: 'pending',
      decision: decision(),
      binding: binding(),
    });
    const bound = bindingOf(result);
    expect(bound).toBeDefined();
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.reservation)).toBe(true);
    expect(Object.isFrozen(bound.reservation.intake)).toBe(true);
    expect(f.readRecordedForSender).toHaveBeenCalledWith(SENDER);
    expect(f.getExpirationDecision).toHaveBeenCalledWith(ID);
  });

  it('rejects intake mutation through the public type and at runtime', async () => {
    const result = await ask(setup());
    if (result.outcome !== 'pending') throw new Error('unreachable');
    const intake = result.binding.reservation.intake;
    expect(() => {
      // @ts-expect-error Public intake fields must remain readonly.
      intake.sourceRequestId = OTHER;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error Public intake fields must remain readonly.
      intake.type = 'EXPIRATION';
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error Public intake fields must remain readonly.
      intake.productId = OTHER;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error Public intake fields must remain readonly.
      intake.variantId = OTHER;
    }).toThrow(TypeError);
    expect(result.binding).toEqual(binding());
  });

  it('reports resolved for both typed actions with a detached decision', async () => {
    for (const resolution of [provided(), notAvailable()]) {
      const action = resolution.action;
      const wire = resolved(resolution);
      const result = await ask(setup({ decision: wire }));
      expect(result).toEqual({
        outcome: 'resolved',
        decision: wire,
        binding: binding(),
      });
      if (result.outcome !== 'resolved') throw new Error('unreachable');
      expect(Object.isFrozen(bindingOf(result))).toBe(true);
      wire.snapshot.branchId = 'mutated';
      (wire.resolution as unknown as { action: string }).action = 'mutated';
      expect(result.decision.snapshot.branchId).toBe(BRANCH);
      expect(result.decision.resolution.action).toBe(action);
      expect(bindingOf(result).branchId).toBe(BRANCH);
    }
  });

  it('still reports resolved past the deadline: no eligibility claim', async () => {
    const expired = resolved(
      {
        action: 'REPORT_EXPIRATION_UNAVAILABLE',
        resolvedAt: '1999-01-01T00:00:00.000Z',
      },
      { applyBefore: '1999-01-02T00:00:00.000Z' },
    );
    await expect(ask(setup({ decision: expired }))).resolves.toEqual({
      outcome: 'resolved',
      decision: expired,
      binding: binding(),
    });
  });

  it.each([
    undefined,
    null,
    { action: 'missing' },
    { action: 'hold' },
    { action: 'recorded' },
    { action: 'recorded', context: null },
  ])('held with no GET for an unrecorded receipt (%#)', async (read) => {
    const f = setup({ read });
    await expect(ask(f)).resolves.toEqual(held);
    expect(f.getExpirationDecision).not.toHaveBeenCalled();
  });

  it('query_failed with no GET when the receipt reader throws', async () => {
    const f = setup({ failRead: true });
    await expect(ask(f)).resolves.toEqual(failed);
    expect(f.getExpirationDecision).not.toHaveBeenCalled();
  });

  it.each(['', ' '])(
    'held with no I/O for an invalid branch %p',
    async (branch) => {
      const f = setup({ branch });
      await expect(ask(f)).resolves.toEqual(held);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
      expect(f.getExpirationDecision).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' ', ' padded', 'a\u0000b'])(
    'held with no I/O for an invalid sender %p',
    async (senderId) => {
      const f = setup();
      await expect(ask(f, senderId)).resolves.toEqual(held);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
      expect(f.getExpirationDecision).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['sender', { reservation: { ...context().reservation, senderId: OTHER } }],
    ['status', { reservation: { ...context().reservation, status: 'CLOSED' } }],
    ['route', { reservation: { ...context().reservation, route: 'RESTOCK' } }],
    [
      'requestKey',
      { reservation: { ...context().reservation, requestKey: OTHER } },
    ],
    [
      'intake',
      {
        reservation: {
          ...context().reservation,
          intake: { ...intake(), productId: 'bad' },
        },
      },
    ],
    ['id', { backendDecisionId: ID.toUpperCase() }],
    ['id null', { backendDecisionId: null }],
  ])(
    'held with no GET for an untrusted context (%s)',
    async (_label, patch) => {
      const f = setup({
        read: { action: 'recorded', context: context(patch) },
      });
      await expect(ask(f)).resolves.toEqual(held);
      expect(f.getExpirationDecision).not.toHaveBeenCalled();
    },
  );

  it.each([
    new UpstreamError('socket', null),
    new UpstreamError('not found', 404),
    new AuthError('auth', 401),
    new ForbiddenError('forbidden', 403),
    new RateLimitError(30),
    new UpstreamError('down', 500),
    new UpstreamError('down', 503),
    new Error('boom'),
  ])(
    'query_failed when the GET rejects (%#), never fabricating a decision',
    async (error) => {
      const f = setup();
      f.getExpirationDecision.mockRejectedValue(error);
      await expect(ask(f)).resolves.toEqual(failed);
      expect(f.getExpirationDecision).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    {},
    { garbage: true },
    { ...decision(), id: ID.toUpperCase() },
  ])('query_failed for a malformed GET projection (%#)', async (wire) => {
    await expect(ask(setup({ decision: wire }))).resolves.toEqual(failed);
  });

  it('query_failed when the returned decision id does not bind to the queried id', async () => {
    const f = setup({ decision: decision({ id: OTHER }) });
    await expect(ask(f)).resolves.toEqual(failed);
    expect(f.getExpirationDecision).toHaveBeenCalledWith(ID);
  });

  it.each([
    ['source', decision({ sourceRequestId: OTHER })],
    ['branch', decision({ snapshot: snapshot({ branchId: 'other' }) })],
    ['product', decision({ snapshot: snapshot({ productId: OTHER }) })],
    [
      'variant',
      decision({
        snapshot: snapshot({ variantId: OTHER, variantName: 'Otra' }),
      }),
    ],
  ])(
    'held when the decision %s does not bind to the persisted record',
    async (_label, wire) => {
      await expect(ask(setup({ decision: wire }))).resolves.toEqual(held);
    },
  );

  it('binds a null persisted variant exactly', async () => {
    const noVariant = context({
      reservation: {
        ...context().reservation,
        intake: intake({ variantId: null }),
      },
    });
    const blank = snapshot({
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    });
    const read = { action: 'recorded', context: noVariant };
    await expect(
      ask(setup({ read, decision: decision({ snapshot: blank }) })),
    ).resolves.toEqual({
      outcome: 'pending',
      decision: decision({ snapshot: blank }),
      binding: binding({ inlet: { variantId: null } }),
    });
    await expect(ask(setup({ read, decision: decision() }))).resolves.toEqual(
      held,
    );
  });

  it('does not fold source case: uppercase persisted vs lowercase GET is held', async () => {
    const upper = SRC.toUpperCase();
    const f = setup({
      read: {
        action: 'recorded',
        context: context({
          reservation: {
            ...context().reservation,
            requestKey: upper,
            intake: intake({ sourceRequestId: upper }),
          },
        }),
      },
      decision: decision({ sourceRequestId: SRC }),
    });
    await expect(ask(f)).resolves.toEqual(held);
    expect(f.getExpirationDecision).toHaveBeenCalledWith(ID);
  });

  it('snapshots the binding before the GET so it cannot rebind across the await', async () => {
    const ctx = {
      reservation: {
        status: 'ACTIVE',
        route: 'EXPIRATION',
        senderId: SENDER,
        requestKey: SRC,
        intake: intake(),
      },
      backendDecisionId: ID,
    };
    const readRecordedForSender: jest.Mock = jest
      .fn()
      .mockResolvedValue({ action: 'recorded', context: ctx });
    const getExpirationDecision: jest.Mock = jest.fn(() => {
      ctx.reservation.intake.productId = OTHER;
      ctx.reservation.senderId = 'mutated';
      ctx.backendDecisionId = OTHER;
      return Promise.resolve(decision());
    });
    const service = new ExpirationExistingDecisionService(
      { readRecordedForSender },
      { getExpirationDecision },
      BRANCH,
    );
    const result = await service.readExistingDecision(SENDER);
    expect(result).toEqual({
      outcome: 'pending',
      decision: decision(),
      binding: binding(),
    });
    const bound = bindingOf(result);
    expect(bound.reservation.intake.productId).toBe(PRODUCT);
    expect(bound.reservation.senderId).toBe(SENDER);
    expect(bound.backendDecisionId).toBe(ID);
    expect(getExpirationDecision).toHaveBeenCalledWith(ID);
  });

  it('returns a detached frozen binding, never the raw read context', async () => {
    const raw = context();
    const result = await ask(
      setup({ read: { action: 'recorded', context: raw } }),
    );
    const bound = bindingOf(result);
    expect(bound).not.toBe(raw);
    expect(bound.reservation).not.toBe(raw.reservation);
    expect(bound.reservation.intake).not.toBe(raw.reservation.intake);
    raw.reservation.intake.productId = OTHER;
    raw.reservation.senderId = 'mutated';
    raw.backendDecisionId = OTHER;
    expect(bound.reservation.intake.productId).toBe(PRODUCT);
    expect(bound.reservation.senderId).toBe(SENDER);
    expect(bound.backendDecisionId).toBe(ID);
    expect(Object.isFrozen(bound.reservation)).toBe(true);
    expect(Object.isFrozen(bound.reservation.intake)).toBe(true);
  });

  it('preserves an opaque branch byte-for-byte in the binding', async () => {
    const opaque = 'sucursal:centro/01 ';
    const wire = decision({ snapshot: snapshot({ branchId: opaque }) });
    const result = await ask(setup({ branch: opaque, decision: wire }));
    expect(result).toEqual({
      outcome: 'pending',
      decision: wire,
      binding: binding({ branch: opaque }),
    });
    expect(bindingOf(result).branchId).toBe(opaque);
  });

  it('never throws: hostile context and decision access fail closed', async () => {
    const hostileContext = Object.defineProperty({}, 'reservation', {
      get: () => {
        throw new Error('boom');
      },
    });
    await expect(
      ask(setup({ read: { action: 'recorded', context: hostileContext } })),
    ).resolves.toEqual(held);
    const hostileDecision = {
      get id(): string {
        throw new Error('boom');
      },
    };
    await expect(ask(setup({ decision: hostileDecision }))).resolves.toEqual(
      failed,
    );
  });

  it('returns frozen outcome markers', async () => {
    expect(
      Object.isFrozen(await ask(setup({ read: { action: 'hold' } }))),
    ).toBe(true);
    expect(Object.isFrozen(await ask(setup({ failRead: true })))).toBe(true);
  });
});

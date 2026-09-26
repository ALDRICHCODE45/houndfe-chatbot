import { RestockApplicationCandidateService } from './restock-application-candidate.service';
import type { RecordedRestockContext } from '../infrastructure/postgres-restock-application-context.store';
import type { RestockDecision } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { UpstreamError } from '../../chatbot-api/domain/errors';
const S = 'whatsapp:+5215500000001';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SRC = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const OTHER = '99999999-9999-4999-8999-999999999999';
const NOW = '2026-06-22T12:00:00.000Z';
const END = '2026-06-22T13:00:00.000Z';
function setup(branch = ' opaque branch ') {
  const subject = {
    productId: OTHER,
    productName: 'Collar',
    variantId: null,
    sku: null,
    requestedQuantity: 2,
    observedStockAtRequest: 0,
    stockObservedAt: NOW,
  };
  const context = {
    reservation: {
      status: 'ACTIVE',
      route: 'RESTOCK',
      senderId: S,
      requestKey: SRC,
      intake: {
        ...subject,
        sourceRequestId: SRC,
        type: 'RESTOCK',
        supersedesDecisionId: null,
      },
    },
    backendDecisionId: ID,
    postAttemptedAt: NOW,
    receiptRecordedAt: NOW,
  } as RecordedRestockContext;
  const decision: RestockDecision = {
    id: ID,
    sourceRequestId: SRC,
    type: 'RESTOCK',
    createdAt: NOW,
    snapshot: { ...subject, branchId: branch, branchName: null },
    supersedesDecisionId: null,
    status: 'RESOLVED',
    version: 2,
    resolution: {
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 3,
      resolvedAt: NOW,
    },
    applyBefore: END,
  };
  const readRecordedForSender = jest
    .fn()
    .mockResolvedValue({ action: 'recorded', context });
  const getRestockDecision = jest.fn().mockResolvedValue(decision);
  const clock = jest.fn(() => new Date(NOW));
  const service = new RestockApplicationCandidateService(
    { readRecordedForSender },
    { getRestockDecision },
    branch,
    clock,
  );
  return {
    context,
    decision,
    readRecordedForSender,
    getRestockDecision,
    clock,
    service,
  };
}
const hold = { action: 'hold' };
describe('queued source binding', () => {
  it.each([OTHER, SRC.toUpperCase(), ` ${SRC}`, 'bad', '', null, 42, {}])(
    'holds supplied source %p before GET and clock',
    async (source) => {
      const f = setup();
      expect(await f.service.pollForSender(S, source as string)).toEqual(hold);
      expect(f.getRestockDecision).not.toHaveBeenCalled();
      expect(f.clock).not.toHaveBeenCalled();
    },
  );
  it.each(['PENDING', 'RESOLVED'])(
    'accepts exact source for %s',
    async (status) => {
      const f = setup();
      if (status === 'PENDING')
        Object.assign(f.decision, {
          status,
          version: 1,
          resolution: null,
          applyBefore: null,
        });
      expect(await f.service.pollForSender(S, SRC)).toMatchObject({
        action: status === 'PENDING' ? 'pending' : 'candidate',
      });
      expect(f.getRestockDecision).toHaveBeenCalledWith(ID);
      expect(f.clock).toHaveBeenCalledTimes(1);
    },
  );
});

describe('unwired restock candidate polling', () => {
  it.each(['', ' ', ' padded', 'x\n'])(
    'rejects sender %p before reading',
    async (sender) => {
      const f = setup();
      expect(await f.service.pollForSender(sender)).toEqual(hold);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
    },
  );
  it.each(['', ' '])('rejects invalid configuration %p', async (branch) => {
    const f = setup(branch);
    expect(await f.service.pollForSender(S)).toEqual(hold);
    expect(f.readRecordedForSender).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { action: 'missing' },
    { action: 'hold' },
    { action: 'recorded' },
  ])('holds bad context result %p without GET', async (result) => {
    const f = setup();
    f.readRecordedForSender.mockResolvedValue(result);
    expect(await f.service.pollForSender(S)).toEqual(hold);
    expect(f.getRestockDecision).not.toHaveBeenCalled();
  });
  it.each([
    { senderId: 'other' },
    { status: 'DONE' },
    { route: 'OTHER' },
    { requestKey: SRC.toUpperCase() },
    { intake: null },
  ])('rejects unsafe reservation %p before GET', async (patch) => {
    const f = setup();
    Object.assign(f.context.reservation, patch);
    expect(await f.service.pollForSender(S)).toEqual(hold);
    expect(f.getRestockDecision).not.toHaveBeenCalled();
  });
  it('rejects invalid persisted id and noncanonical intake before GET', async () => {
    for (const patch of [
      { backendDecisionId: undefined },
      { backendDecisionId: 'bad' },
    ]) {
      const f = setup();
      Object.assign(f.context, patch);
      expect(await f.service.pollForSender(S)).toEqual(hold);
      expect(f.getRestockDecision).not.toHaveBeenCalled();
    }
    const f = setup();
    Object.assign(f.context.reservation.intake, { productName: ' Collar ' });
    expect(await f.service.pollForSender(S)).toEqual(hold);
    expect(f.getRestockDecision).not.toHaveBeenCalled();
  });
  it('reads once, polls only persisted id, preserves uppercase keys and stable attempt', async () => {
    const f = setup();
    Object.assign(f.context.reservation, { requestKey: SRC.toUpperCase() });
    Object.assign(f.context.reservation.intake, {
      sourceRequestId: SRC.toUpperCase(),
    });
    const first = await f.service.pollForSender(S);
    expect(first).toMatchObject({
      action: 'candidate',
      classification: { action: 'ready' },
      checkedAt: NOW,
    });
    expect(f.readRecordedForSender).toHaveBeenCalledTimes(1);
    expect(f.readRecordedForSender).toHaveBeenCalledWith(S);
    expect(f.getRestockDecision).toHaveBeenCalledTimes(1);
    expect(f.getRestockDecision).toHaveBeenCalledWith(ID);
    expect(await f.service.pollForSender(S)).toEqual(first);
  });
  it.each(['positive', 'negative', 'pending'])(
    'binds %s current state',
    async (kind) => {
      const f = setup();
      if (kind === 'negative')
        Object.assign(f.decision, {
          resolution: {
            action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
            resolvedAt: NOW,
          },
        });
      if (kind === 'pending')
        Object.assign(f.decision, {
          status: 'PENDING',
          version: 1,
          resolution: null,
          applyBefore: null,
        });
      expect(await f.service.pollForSender(S)).toMatchObject({
        action: kind === 'pending' ? 'pending' : 'candidate',
      });
      f.decision.snapshot.branchId = 'branch';
      expect(await f.service.pollForSender(S)).toEqual(hold);
    },
  );
  it.each([
    { productId: ID },
    { productName: 'Other' },
    { requestedQuantity: 3 },
    { variantId: ID },
    { sku: 'other' },
    { observedStockAtRequest: 1 },
    { stockObservedAt: END },
    { branchId: 'opaque branch' },
  ])('holds changed subject %p even when pending', async (patch) => {
    const f = setup();
    Object.assign(f.decision.snapshot, patch);
    expect(await f.service.pollForSender(S)).toEqual(hold);
    Object.assign(f.decision, {
      status: 'PENDING',
      version: 1,
      resolution: null,
      applyBefore: null,
    });
    expect(await f.service.pollForSender(S)).toEqual(hold);
  });
  it.each([
    { id: OTHER },
    { sourceRequestId: OTHER },
    { supersedesDecisionId: OTHER },
  ])('holds changed identity %p', async (patch) => {
    const f = setup();
    Object.assign(f.decision, patch);
    expect(await f.service.pollForSender(S)).toEqual(hold);
  });
  it.each([null, {}, { ok: false }, { status: 'RESOLVED' }])(
    'holds malformed backend %p',
    async (value) => {
      const f = setup();
      f.getRestockDecision.mockResolvedValue(value);
      expect(await f.service.pollForSender(S)).toEqual(hold);
      expect(f.getRestockDecision).toHaveBeenCalledTimes(1);
    },
  );
  it.each([new Error('failure'), new UpstreamError('failure', 503)])(
    'holds thrown client failures without retry',
    async (error) => {
      const f = setup();
      f.getRestockDecision.mockRejectedValue(error);
      expect(await f.service.pollForSender(S)).toEqual(hold);
      expect(f.getRestockDecision).toHaveBeenCalledTimes(1);
    },
  );
  it('holds reader failures without GET', async () => {
    const f = setup();
    f.readRecordedForSender.mockRejectedValue(new Error('failure'));
    expect(await f.service.pollForSender(S)).toEqual(hold);
    expect(f.getRestockDecision).not.toHaveBeenCalled();
  });
  it.each([END, '2026-06-22T11:59:59.999Z', 'invalid'])(
    'uses fresh clock %s',
    async (now) => {
      const f = setup();
      f.clock.mockReturnValue(new Date(now));
      expect(await f.service.pollForSender(S)).toMatchObject(
        now === END
          ? { action: 'candidate', classification: { action: 'stale' } }
          : hold,
      );
    },
  );
  it('holds thrown clocks', async () => {
    const f = setup();
    f.clock.mockImplementation(() => {
      throw new Error('clock');
    });
    expect(await f.service.pollForSender(S)).toEqual(hold);
  });
  it('detaches before awaiting GET; freezes all candidate objects with a post-GET clock', async () => {
    const f = setup();
    let finish!: (value: RestockDecision) => void;
    f.getRestockDecision.mockReturnValue(
      new Promise<RestockDecision>((resolve) => {
        finish = resolve;
      }),
    );
    const poll = f.service.pollForSender(S);
    await Promise.resolve();
    expect(f.clock).not.toHaveBeenCalled();
    Object.assign(f.context.reservation.intake, { productName: 'Changed' });
    Object.assign(f.context.reservation, { senderId: 'Changed' });
    finish(f.decision);
    const result = await poll;
    expect(f.clock).toHaveBeenCalledTimes(1);
    if (result.action !== 'candidate') throw new Error('expected candidate');
    expect(result.context.reservation.senderId).toBe(S);
    expect(result.context.reservation.intake.productName).toBe('Collar');
    expect(result.decision).not.toBe(f.decision);
    expect(result.context).not.toBe(f.context);
    for (const object of [
      result,
      result.context,
      result.context.reservation,
      result.context.reservation.intake,
      result.decision,
      result.decision.snapshot,
      result.decision.resolution,
      result.classification,
    ])
      expect(Object.isFrozen(object)).toBe(true);
    f.decision.snapshot.productName = 'Changed';
    expect(result.decision.snapshot.productName).toBe('Collar');
  });
});

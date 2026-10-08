import { ExpirationRecoveryPoller } from './expiration-recovery-poller';
import * as candidates from './expiration-preparation-candidate';

const hint = { senderId: 'customer', requestKey: 'original' };
const resolvedOutcome = {
  outcome: 'resolved' as const,
  decision: { resolution: { resolvedAt: '2026-06-23T08:00:00.000Z' } },
  binding: {
    backendDecisionId: 'decision',
    reservation: { requestKey: hint.requestKey },
  },
};
const candidate = {
  action: 'candidate',
} as candidates.ExpirationPreparationCandidate;
function armResolved(h: ReturnType<typeof setup>): { deliverOnce: jest.Mock } {
  h.decisions.readExistingDecision.mockResolvedValue(resolvedOutcome);
  jest
    .spyOn(candidates, 'createExpirationPreparationCandidate')
    .mockReturnValue(candidate);
  return h.delivery as { deliverOnce: jest.Mock };
}
function deliverySetup() {
  const delivery = {
    deliverOnce: jest.fn().mockResolvedValue({ action: 'hold' }),
  };
  return setup(delivery);
}
const page = (nextCursor: string | null = null) => ({
  action: 'page' as const,
  hints: [hint],
  nextCursor,
});
function setup(
  delivery?: { deliverOnce: jest.Mock },
  recovery?: {
    outcomes?: { readOutcomeByDecision: jest.Mock };
    coordinator?: { finishOnce: jest.Mock };
  },
) {
  const discovery = {
    discoverRecordedHints: jest.fn().mockResolvedValue(page()),
  };
  const decisions = {
    readExistingDecision: jest.fn().mockResolvedValue({
      outcome: 'pending',
      binding: { reservation: { requestKey: 'original' } },
    }),
  };
  const preparation = {
    preparePending: jest.fn().mockResolvedValue({ action: 'hold' }),
  };
  const outcomes = recovery?.outcomes ?? {
    readOutcomeByDecision: jest.fn().mockResolvedValue({ action: 'missing' }),
  };
  const coordinator = recovery?.coordinator ?? { finishOnce: jest.fn() };
  const poller = new ExpirationRecoveryPoller(
    discovery,
    decisions,
    preparation,
    undefined,
    delivery,
    outcomes,
    coordinator,
  );
  return {
    discovery,
    decisions,
    preparation,
    delivery,
    outcomes,
    coordinator,
    poller,
  };
}

const acceptedRow = {
  state: 'PROVIDER_ACCEPTED' as const,
  attemptedAt: '2026-06-23T08:30:00.000Z',
};
function terminalRecovery(outcome = { action: 'closed' }): {
  outcomes: { readOutcomeByDecision: jest.Mock };
  coordinator: { finishOnce: jest.Mock };
} {
  return {
    outcomes: {
      readOutcomeByDecision: jest.fn().mockResolvedValue({
        action: 'foundOutcome',
        row: acceptedRow,
        receipt: null,
      }),
    },
    coordinator: { finishOnce: jest.fn().mockResolvedValue(outcome) },
  };
}

describe('ExpirationRecoveryPoller', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('stays idle before start and revisits pending work after wrapping the cursor', async () => {
    const h = setup();
    expect(h.discovery.discoverRecordedHints).not.toHaveBeenCalled();
    h.discovery.discoverRecordedHints.mockResolvedValueOnce(page('next'));
    h.poller.start();
    h.poller.start();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(h.discovery.discoverRecordedHints.mock.calls).toEqual([
      [{ limit: 1, afterRequestKey: null }],
      [{ limit: 1, afterRequestKey: 'next' }],
      [{ limit: 1, afterRequestKey: null }],
    ]);
    expect(h.decisions.readExistingDecision).toHaveBeenCalledTimes(3);
    expect(h.preparation.preparePending).not.toHaveBeenCalled();
    await h.poller.stop();
  });

  it('prepares only a resolved candidate bound to the original hint', async () => {
    const h = setup();
    const outcome = {
      outcome: 'resolved',
      binding: { reservation: { requestKey: 'other' } },
    };
    h.decisions.readExistingDecision.mockResolvedValue(outcome);
    const candidate = {
      action: 'candidate',
    } as candidates.ExpirationPreparationCandidate;
    const build = jest
      .spyOn(candidates, 'createExpirationPreparationCandidate')
      .mockReturnValue(candidate);
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(build).not.toHaveBeenCalled();
    expect(h.preparation.preparePending).not.toHaveBeenCalled();
    outcome.binding.reservation.requestKey = hint.requestKey;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(build).toHaveBeenCalledWith(
      hint.senderId,
      outcome,
      expect.any(String),
    );
    expect(h.preparation.preparePending).toHaveBeenCalledWith(candidate);
    await h.poller.stop();
  });

  it('does not overlap ticks and drains an in-flight read without preparing after stop', async () => {
    const h = setup();
    let release!: (value: unknown) => void;
    h.decisions.readExistingDecision.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    h.poller.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(h.discovery.discoverRecordedHints).toHaveBeenCalledTimes(1);
    let drained = false;
    const stopping = h.poller.stop().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release({ outcome: 'held' });
    await stopping;
    h.poller.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(h.discovery.discoverRecordedHints).toHaveBeenCalledTimes(1);
    expect(h.preparation.preparePending).not.toHaveBeenCalled();
  });

  it('retries discovery on a later tick and a new poller starts from the beginning', async () => {
    const h = setup();
    h.discovery.discoverRecordedHints.mockRejectedValueOnce(
      new Error('offline'),
    );
    h.poller.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.decisions.readExistingDecision).toHaveBeenCalledTimes(1);
    await h.poller.stop();
    const fresh = new ExpirationRecoveryPoller(
      h.discovery,
      h.decisions,
      h.preparation,
    );
    fresh.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.discovery.discoverRecordedHints).toHaveBeenLastCalledWith({
      limit: 1,
      afterRequestKey: null,
    });
    await fresh.stop();
  });

  it('offers only a prepared candidate to delivery once per tick', async () => {
    const h = deliverySetup();
    const delivery = armResolved(h);
    h.preparation.preparePending.mockResolvedValue({
      action: 'prepared',
      row: {},
    });
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.preparation.preparePending).toHaveBeenCalledWith(candidate);
    expect(delivery.deliverOnce).toHaveBeenCalledTimes(1);
    expect(delivery.deliverOnce).toHaveBeenCalledWith(candidate);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(delivery.deliverOnce).toHaveBeenCalledTimes(2);
    await h.poller.stop();
  });

  it('routes a persisted terminal row to the coordinator without preparing or sending', async () => {
    const recovery = terminalRecovery();
    const h = setup({ deliverOnce: jest.fn() }, recovery);
    armResolved(h);
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(recovery.outcomes.readOutcomeByDecision).toHaveBeenCalledWith(
      resolvedOutcome.binding.backendDecisionId,
    );
    expect(recovery.coordinator.finishOnce).toHaveBeenCalledWith(
      candidate,
      acceptedRow,
    );
    expect(h.preparation.preparePending).not.toHaveBeenCalled();
    expect(h.delivery?.deliverOnce).not.toHaveBeenCalled();
    await h.poller.stop();
  });

  it('offers persisted STALE with resolved evidence for validated recovery, never preparing or sending', async () => {
    const recovery = terminalRecovery();
    recovery.outcomes.readOutcomeByDecision.mockResolvedValue({
      action: 'foundOutcome',
      row: { state: 'STALE' },
      receipt: null,
    });
    const h = setup({ deliverOnce: jest.fn() }, recovery);
    armResolved(h);
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(recovery.coordinator.finishOnce).toHaveBeenCalledWith(
      resolvedOutcome,
      { state: 'STALE' },
    );
    expect(h.preparation.preparePending).not.toHaveBeenCalled();
    expect(h.delivery?.deliverOnce).not.toHaveBeenCalled();
    await h.poller.stop();
  });

  it('recovers a terminal row with the historical attempt time, not the current clock', async () => {
    const recovery = terminalRecovery();
    const h = setup(undefined, recovery);
    h.decisions.readExistingDecision.mockResolvedValue(resolvedOutcome);
    const build = jest
      .spyOn(candidates, 'createExpirationPreparationCandidate')
      .mockReturnValue(candidate);
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(build).toHaveBeenCalledWith(
      hint.senderId,
      resolvedOutcome,
      acceptedRow.attemptedAt,
    );
    expect(recovery.coordinator.finishOnce).toHaveBeenCalledTimes(1);
    await h.poller.stop();
  });

  it('prepares and delivers when no durable terminal row exists', async () => {
    const h = deliverySetup();
    const delivery = armResolved(h);
    h.preparation.preparePending.mockResolvedValue({
      action: 'prepared',
      row: {},
    });
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.outcomes.readOutcomeByDecision).toHaveBeenCalledTimes(1);
    expect(h.preparation.preparePending).toHaveBeenCalledWith(candidate);
    expect(delivery.deliverOnce).toHaveBeenCalledWith(candidate);
    expect(h.coordinator.finishOnce).not.toHaveBeenCalled();
    await h.poller.stop();
  });

  it('routes a newly accepted delivery row to the coordinator', async () => {
    const h = deliverySetup();
    const delivery = armResolved(h);
    delivery.deliverOnce.mockResolvedValue({
      action: 'accepted',
      row: acceptedRow,
    });
    h.preparation.preparePending.mockResolvedValue({
      action: 'prepared',
      row: {},
    });
    h.coordinator.finishOnce.mockResolvedValue({ action: 'closed' });
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.coordinator.finishOnce).toHaveBeenCalledWith(
      candidate,
      acceptedRow,
    );
    await h.poller.stop();
  });

  it('revisits an unreported terminal row next sweep without resending', async () => {
    const recovery = terminalRecovery({ action: 'hold' });
    const h = setup({ deliverOnce: jest.fn() }, recovery);
    armResolved(h);
    h.poller.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(recovery.coordinator.finishOnce).toHaveBeenCalledTimes(2);
    expect(h.preparation.preparePending).not.toHaveBeenCalled();
    expect(h.delivery?.deliverOnce).not.toHaveBeenCalled();
    await h.poller.stop();
  });

  it('does not report a terminal row when stopped after the terminal read', async () => {
    const recovery = terminalRecovery();
    const h = setup(undefined, recovery);
    armResolved(h);
    let release!: (value: unknown) => void;
    recovery.outcomes.readOutcomeByDecision.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    const stopping = h.poller.stop();
    release({ action: 'foundOutcome', row: acceptedRow, receipt: null });
    await stopping;
    expect(recovery.coordinator.finishOnce).not.toHaveBeenCalled();
  });

  it('never delivers when preparation holds or is absent', async () => {
    const h = deliverySetup();
    const delivery = armResolved(h);
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.preparation.preparePending).toHaveBeenCalledTimes(1);
    expect(delivery.deliverOnce).not.toHaveBeenCalled();
    await h.poller.stop();
    const prepOnly = setup();
    jest
      .spyOn(candidates, 'createExpirationPreparationCandidate')
      .mockReturnValue(candidate);
    prepOnly.decisions.readExistingDecision.mockResolvedValue(resolvedOutcome);
    prepOnly.preparation.preparePending.mockResolvedValue({
      action: 'prepared',
      row: {},
    });
    prepOnly.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(prepOnly.preparation.preparePending).toHaveBeenCalledTimes(1);
    await prepOnly.poller.stop();
  });

  it('does not deliver when stopped after preparation resolves', async () => {
    const h = deliverySetup();
    const delivery = armResolved(h);
    let release!: (value: unknown) => void;
    h.preparation.preparePending.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    const stopping = h.poller.stop();
    release({ action: 'prepared', row: {} });
    await stopping;
    expect(delivery.deliverOnce).not.toHaveBeenCalled();
  });

  it('waits for an in-flight delivery before shutdown drains', async () => {
    const h = deliverySetup();
    const delivery = armResolved(h);
    let release!: (value: unknown) => void;
    delivery.deliverOnce.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    h.preparation.preparePending.mockResolvedValue({
      action: 'prepared',
      row: {},
    });
    h.poller.start();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(delivery.deliverOnce).toHaveBeenCalledTimes(1);
    let drained = false;
    const stopping = h.poller.stop().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release({ action: 'hold' });
    await stopping;
    expect(drained).toBe(true);
  });
});

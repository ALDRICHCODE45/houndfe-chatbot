import { ExpirationRecoveryPoller } from './expiration-recovery-poller';
import * as candidates from './expiration-preparation-candidate';

const hint = { senderId: 'customer', requestKey: 'original' };
const resolvedOutcome = {
  outcome: 'resolved' as const,
  binding: { reservation: { requestKey: hint.requestKey } },
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
function setup(delivery?: { deliverOnce: jest.Mock }) {
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
  const poller = new ExpirationRecoveryPoller(
    discovery,
    decisions,
    preparation,
    undefined,
    delivery,
  );
  return { discovery, decisions, preparation, delivery, poller };
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

import { Logger } from '@nestjs/common';
import { HumanRequestMaintenanceWorker } from './human-request-maintenance.worker';

describe('HumanRequestMaintenanceWorker', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const delivery = () => ({
    sweepAcks: jest.fn(() => Promise.resolve(0)),
    recoverStuckSending: jest.fn(() => Promise.resolve(0)),
    replayHeld: jest.fn(() => Promise.resolve(0)),
  });

  it('a tick recovers stuck sends, retries ACKs and replays held rows', async () => {
    const ports = delivery();
    await new HumanRequestMaintenanceWorker(ports).tick();
    expect(ports.recoverStuckSending).toHaveBeenCalledTimes(1);
    expect(ports.sweepAcks).toHaveBeenCalledTimes(1);
    expect(ports.replayHeld).toHaveBeenCalledTimes(1);
  });

  it('one failing step does not skip the others', async () => {
    const ports = delivery();
    ports.recoverStuckSending.mockRejectedValueOnce(new Error('db'));
    ports.sweepAcks.mockRejectedValueOnce(new Error('db'));
    await expect(
      new HumanRequestMaintenanceWorker(ports).tick(),
    ).resolves.toBeUndefined();
    expect(ports.replayHeld).toHaveBeenCalledTimes(1);
  });

  it('runs on an interval after start and stops for good', async () => {
    jest.useFakeTimers();
    try {
      const ports = delivery();
      const worker = new HumanRequestMaintenanceWorker(ports, {
        intervalMs: 1_000,
      });
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(ports.sweepAcks).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(ports.sweepAcks).toHaveBeenCalledTimes(2);
      await worker.stop();
      worker.start();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(ports.sweepAcks).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

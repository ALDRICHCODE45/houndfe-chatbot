import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { ChatbotApiClient } from '../chatbot-api/domain/chatbot-api.client';
import { RestockApplicationRuntime } from './restock-application.runtime';
import { RestockApplicationCoordinator } from './application/restock-application-coordinator';
import { RestockApplicationPoller } from './application/restock-application-poller';
import { RestockApplicationCandidateService } from './application/restock-application-candidate.service';
import { PostgresRestockApplicationContextStore } from './infrastructure/postgres-restock-application-context.store';
import { PostgresRestockApplicationPreparationStore } from './infrastructure/postgres-restock-application-preparation.store';
import { PostgresRestockApplicationClaimStore } from './infrastructure/postgres-restock-application-claim.store';
import { PostgresRestockApplicationLedgerStore } from './infrastructure/postgres-restock-application-ledger.store';
import { PostgresRestockApplicationCompletionStore } from './infrastructure/postgres-restock-application-completion.store';

const source = 'ABCDEF12-1234-4234-8234-123456789ABC';
const senderId = 'synthetic-sender';
const branch = ' opaque branch ';
const phone = ' opaque phone ';
const HOLD = { action: 'hold' as const };
const RECORDED = {
  action: 'recorded' as const,
  context: { reservation: { requestKey: source } },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(flag: unknown, identity = { branch, phone }) {
  const values: Record<string, unknown> = {
    'humanDecisions.restockEnabled': flag,
    'chatbotApi.branchId': identity.branch,
    'meta.phoneNumberId': identity.phone,
  };
  const config = { get: jest.fn((key: string) => values[key]) };
  const pool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };
  const client = {
    getRestockDecision: jest.fn(),
    recordRestockApplicationOutcome: jest.fn(),
  };
  const sender = { sendText: jest.fn() };
  const runtime = new RestockApplicationRuntime(
    config as unknown as ConfigService,
    pool as unknown as Pool,
    client as unknown as ChatbotApiClient,
    sender,
  );
  const inert = () => {
    for (const mock of [
      ...Object.values(pool),
      ...Object.values(client),
      ...Object.values(sender),
    ])
      expect(mock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  };
  return { runtime, pool, client, sender, inert };
}

// Unit composition/lifecycle proof only: no Nest graph or durable I/O.
describe('RestockApplicationRuntime in isolation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([undefined, false, 'true'])(
    'is inert for strict-OFF %s',
    async (flag) => {
      const f = fixture(flag);
      const start = jest.spyOn(RestockApplicationPoller.prototype, 'start');
      const close = jest.spyOn(
        PostgresRestockApplicationCompletionStore.prototype,
        'closeAcknowledged',
      );
      f.runtime.onApplicationBootstrap();
      expect(f.runtime.enqueue(senderId, source)).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(
        (f.runtime as unknown as { poller?: unknown }).poller,
      ).toBeUndefined();
      await f.runtime.onModuleDestroy();
      f.inert();
    },
  );

  it.each([
    { branch: '', phone },
    { branch, phone: ' ' },
  ])('rejects invalid enabled identity %s', (identity) => {
    const f = fixture(true, identity);
    expect(() => f.runtime.onApplicationBootstrap()).toThrow();
    expect(f.runtime.enqueue(senderId, source)).toBe(false);
    f.inert();
  });

  it('stays idle, delays synchronous admission, drains fully and never rearms', async () => {
    const f = fixture(true);
    let finish!: (value: typeof HOLD) => void;
    const apply = jest
      .spyOn(RestockApplicationCoordinator.prototype, 'applyOnce')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const start = jest.spyOn(RestockApplicationPoller.prototype, 'start');
    expect(f.runtime.enqueue(senderId, source)).toBe(false);
    f.runtime.onApplicationBootstrap();
    f.runtime.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
    f.inert();
    expect(f.runtime.enqueue(senderId, source)).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    expect(apply).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    expect(apply).toHaveBeenCalledWith(senderId, source);
    let drained = false;
    const stopping = f.runtime.onModuleDestroy();
    expect(f.runtime.onModuleDestroy()).toBe(stopping);
    void stopping.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(f.runtime.enqueue('another', source)).toBe(false);
    f.runtime.onApplicationBootstrap();
    finish(HOLD); // Simulated final coordinator operation, not real ACK SQL.
    await stopping;
    expect(drained).toBe(true);
    await jest.advanceTimersByTimeAsync(10000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    f.inert();
  });

  it('drops waiting work on stop without invoking the coordinator', async () => {
    const f = fixture(true);
    const apply = jest.spyOn(
      RestockApplicationCoordinator.prototype,
      'applyOnce',
    );
    f.runtime.onApplicationBootstrap();
    expect(f.runtime.enqueue(senderId, source)).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    await f.runtime.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    f.runtime.onApplicationBootstrap();
    expect(f.runtime.enqueue(senderId, source)).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(apply).not.toHaveBeenCalled();
    f.inert();
  });

  it('latches shutdown before bootstrap', async () => {
    const f = fixture(true);
    const start = jest.spyOn(RestockApplicationPoller.prototype, 'start');
    await f.runtime.onModuleDestroy();
    f.runtime.onApplicationBootstrap();
    expect(f.runtime.enqueue(senderId, source)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    f.inert();
  });

  describe('expired-only on-demand reconciliation', () => {
    const read = () =>
      jest
        .spyOn(
          PostgresRestockApplicationContextStore.prototype,
          'readRecordedForSender',
        )
        .mockResolvedValue(RECORDED as never);
    const reconcile = () =>
      jest
        .spyOn(RestockApplicationCoordinator.prototype, 'reconcileExpiredOnce')
        .mockResolvedValue({ action: 'ack_recorded' });

    it.each([undefined, false])(
      'is inert while disabled (%s)',
      async (flag) => {
        const f = fixture(flag);
        f.runtime.onApplicationBootstrap();
        await expect(f.runtime.reconcileExpired(senderId)).resolves.toBe(false);
        f.inert();
        await f.runtime.onModuleDestroy();
      },
    );

    it('is inert before bootstrap and after shutdown', async () => {
      const f = fixture(true);
      await expect(f.runtime.reconcileExpired(senderId)).resolves.toBe(false);
      f.runtime.onApplicationBootstrap();
      await f.runtime.onModuleDestroy();
      await expect(f.runtime.reconcileExpired(senderId)).resolves.toBe(false);
      f.inert();
    });

    it('passes only the ORIGINAL recorded request key to the coordinator', async () => {
      const f = fixture(true);
      const readMock = read();
      const reconcileMock = reconcile();
      f.runtime.onApplicationBootstrap();
      await expect(f.runtime.reconcileExpired(senderId)).resolves.toBe(true);
      expect(readMock).toHaveBeenCalledWith(senderId);
      expect(reconcileMock).toHaveBeenCalledWith(senderId, source);
      f.inert();
      await f.runtime.onModuleDestroy();
    });

    it.each(['missing', 'hold'])(
      'does not apply on %s context',
      async (action) => {
        const f = fixture(true);
        read().mockResolvedValue({ action } as never);
        const reconcileMock = reconcile();
        f.runtime.onApplicationBootstrap();
        await expect(f.runtime.reconcileExpired(senderId)).resolves.toBe(false);
        expect(reconcileMock).not.toHaveBeenCalled();
        f.inert();
        await f.runtime.onModuleDestroy();
      },
    );

    it('awaits an in-flight recovery before shutdown resolves', async () => {
      const f = fixture(true);
      read();
      const gate = deferred<{ action: 'ack_recorded' }>();
      const reconcileMock = jest
        .spyOn(RestockApplicationCoordinator.prototype, 'reconcileExpiredOnce')
        .mockReturnValue(gate.promise);
      f.runtime.onApplicationBootstrap();
      const recovered = f.runtime.reconcileExpired(senderId);
      let drained = false;
      const stopping = f.runtime.onModuleDestroy().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      gate.resolve({ action: 'ack_recorded' });
      await expect(recovered).resolves.toBe(true);
      await stopping;
      expect(drained).toBe(true);
      expect(reconcileMock).toHaveBeenCalledTimes(1);
      f.inert();
    });
  });

  it('composes real adapters on one pool with bound receivers and exact identities', async () => {
    const f = fixture(true);
    const candidate = jest
      .spyOn(RestockApplicationCandidateService.prototype, 'pollForSender')
      .mockResolvedValue(HOLD);
    const prepare = jest
      .spyOn(
        PostgresRestockApplicationPreparationStore.prototype,
        'preparePending',
      )
      .mockResolvedValue(HOLD);
    const claim = jest
      .spyOn(PostgresRestockApplicationClaimStore.prototype, 'claimPending')
      .mockResolvedValue(HOLD);
    const acceptance = jest
      .spyOn(
        PostgresRestockApplicationLedgerStore.prototype,
        'recordAcceptance',
      )
      .mockResolvedValue(HOLD);
    const ack = jest
      .spyOn(
        PostgresRestockApplicationLedgerStore.prototype,
        'recordOutcomeAck',
      )
      .mockResolvedValue(HOLD);
    const close = jest
      .spyOn(
        PostgresRestockApplicationCompletionStore.prototype,
        'closeAcknowledged',
      )
      .mockResolvedValue(HOLD);
    // Test-only access to private ports; invoke wrappers without real transactions.
    type Internals = {
      ports: Record<string, (...args: unknown[]) => unknown>;
      branchId: string;
      receivingPhoneNumberId: string;
      clock: () => Date;
    };
    let coordinator!: Internals;
    jest
      .spyOn(RestockApplicationCoordinator.prototype, 'applyOnce')
      .mockImplementation(function (this: RestockApplicationCoordinator) {
        coordinator = this as unknown as Internals;
        return Promise.resolve(HOLD);
      });
    f.runtime.onApplicationBootstrap();
    f.runtime.enqueue(senderId, source);
    await jest.advanceTimersByTimeAsync(5000);
    expect(coordinator.branchId).toBe(branch);
    expect(coordinator.receivingPhoneNumberId).toBe(phone);
    expect(coordinator.clock()).toEqual(new Date());
    const args = [senderId, source];
    for (const name of [
      'pollForSender',
      'preparePending',
      'claimPending',
      'recordAcceptance',
      'recordOutcomeAck',
      'readByDecision',
      'closeAcknowledged',
      'recordRestockApplicationOutcome',
      'sendText',
    ])
      await coordinator.ports[name](...args);
    const candidateInstance = candidate.mock.contexts[0] as unknown as {
      reader: unknown;
      backend: unknown;
      branchId: string;
      clock: () => Date;
    };
    expect(candidateInstance.reader).toBeInstanceOf(
      PostgresRestockApplicationContextStore,
    );
    expect((candidateInstance.reader as { pool: unknown }).pool).toBe(f.pool);
    expect(candidateInstance.backend).toBe(f.client);
    for (const spy of [candidate, prepare, claim]) {
      expect(spy.mock.contexts[0]).toMatchObject({
        branchId: branch,
        clock: coordinator.clock,
      });
      expect(spy).toHaveBeenCalledWith(...args);
    }
    for (const spy of [prepare, claim, acceptance, ack, close])
      expect((spy.mock.contexts[0] as unknown as { pool: unknown }).pool).toBe(
        f.pool,
      );
    expect(claim.mock.contexts[0]).toMatchObject({
      receivingPhoneNumberId: phone,
    });
    expect(prepare.mock.contexts[0]).toBeInstanceOf(
      PostgresRestockApplicationPreparationStore,
    );
    expect(claim.mock.contexts[0]).toBeInstanceOf(
      PostgresRestockApplicationClaimStore,
    );
    expect(acceptance.mock.contexts[0]).toBeInstanceOf(
      PostgresRestockApplicationLedgerStore,
    );
    expect(acceptance.mock.contexts[0]).toBe(ack.mock.contexts[0]);
    expect(close.mock.contexts[0]).toBeInstanceOf(
      PostgresRestockApplicationCompletionStore,
    );
    expect(close.mock.contexts[0]).toMatchObject({ branchId: branch });
    expect(close).toHaveBeenCalledWith(...args);
    expect(f.client.recordRestockApplicationOutcome.mock.contexts[0]).toBe(
      f.client,
    );
    expect(f.sender.sendText.mock.contexts[0]).toBe(f.sender);
    expect(f.pool.query).not.toHaveBeenCalled();
    expect(f.pool.connect).not.toHaveBeenCalled();
    await f.runtime.onModuleDestroy();
  });
});

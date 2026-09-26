import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import { MetaWhatsappSender } from '../whatsapp/infrastructure/meta-whatsapp.sender';
import { HumanDecisionsModule } from './human-decisions.module';
import { RestockApplicationRuntime } from './restock-application.runtime';
import { RESTOCK_INTAKE_SERVICE } from './application/restock-intake.service';
import { RestockApplicationCoordinator } from './application/restock-application-coordinator';
import { RestockApplicationPoller } from './application/restock-application-poller';

const source = 'ABCDEF12-1234-4234-8234-123456789ABC';
const senderId = 'synthetic-sender';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function compile(flag: unknown, reverse = false) {
  const pool = {
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  };
  const client = {
    getRestockDecision: jest.fn(),
    recordRestockApplicationOutcome: jest.fn(),
  };
  const sender = { sendText: jest.fn() };
  const values: Record<string, unknown> = {
    'humanDecisions.restockEnabled': flag,
    'chatbotApi.branchId': 'synthetic-branch',
    'meta.phoneNumberId': 'synthetic-phone',
  };
  const imports = reverse
    ? [HumanDecisionsModule, DatabaseModule, HumanDecisionsModule]
    : [DatabaseModule, HumanDecisionsModule, HumanDecisionsModule];
  const moduleRef = await Test.createTestingModule({ imports })
    .overrideProvider(ConfigService)
    .useValue({ get: (key: string) => values[key] })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(ChatbotApiHttpClient)
    .useValue({})
    .overrideProvider(CHATBOT_API_CLIENT)
    .useValue(client)
    .overrideProvider(MetaWhatsappSender)
    .useValue({})
    .overrideProvider(WHATSAPP_SENDER)
    .useValue(sender)
    .compile();
  const inert = () => {
    for (const fn of [
      pool.query,
      pool.connect,
      ...Object.values(client),
      sender.sendText,
    ])
      expect(fn).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  };
  return { moduleRef, pool, inert };
}

describe('HumanDecisionsModule application lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([undefined, false, 'true'])(
    'keeps strict-OFF %s inert through real Nest hooks',
    async (flag) => {
      const start = jest.spyOn(RestockApplicationPoller.prototype, 'start');
      const f = await compile(flag);
      f.inert();
      await f.moduleRef.init();
      const runtime = f.moduleRef.get(RestockApplicationRuntime);
      expect(runtime.enqueue(senderId, source)).toBe(false);
      expect(
        (runtime as unknown as { poller?: unknown }).poller,
      ).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      f.inert();
      await f.moduleRef.close();
      expect(f.pool.end).toHaveBeenCalledTimes(1);
      f.inert();
    },
  );

  it.each([false, true])(
    'wires the intake hook and drains before pool close (reverse=%s)',
    async (reverse) => {
      const operation = deferred<{ action: 'ack_recorded' }>();
      const enteredDestroy = deferred<void>();
      const events: string[] = [];
      const original = RestockApplicationRuntime.prototype.onModuleDestroy;
      jest
        .spyOn(RestockApplicationRuntime.prototype, 'onModuleDestroy')
        .mockImplementation(function (this: RestockApplicationRuntime) {
          const stopping = original.call(this);
          enteredDestroy.resolve();
          void stopping.then(() => {
            events.push('drained');
          });
          return stopping;
        });
      const apply = jest
        .spyOn(RestockApplicationCoordinator.prototype, 'applyOnce')
        .mockReturnValue(operation.promise);
      const start = jest.spyOn(RestockApplicationPoller.prototype, 'start');
      const f = await compile(true, reverse);
      f.pool.end.mockImplementation(async () => {
        events.push('pool.end');
      });
      f.inert();
      await f.moduleRef.init();
      const runtime = f.moduleRef.get(RestockApplicationRuntime);
      runtime.onApplicationBootstrap();
      expect(start).toHaveBeenCalledTimes(1);
      expect(f.moduleRef.get(PG_POOL)).toBe(f.pool);
      f.inert();
      // Invoke the actual factory-bound callback, not coordinate() or enqueue().
      // Existing intake tests prove only fresh confirmed receipts invoke this hook.
      const intake = f.moduleRef.get<{
        onReceiptRecorded?: (sender: string, source: string) => void;
      }>(RESTOCK_INTAKE_SERVICE);
      const enqueue = jest.spyOn(runtime, 'enqueue');
      expect(intake.onReceiptRecorded).toEqual(expect.any(Function));
      expect(intake.onReceiptRecorded!(senderId, source)).toBeUndefined();
      expect(enqueue).toHaveBeenCalledWith(senderId, source);
      expect(apply).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(4999);
      expect(apply).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith(senderId, source);
      let closed = false;
      const closing = f.moduleRef.close().then(() => {
        closed = true;
      });
      // Signal comes from the real runtime hook, not sleeps or microtask polling.
      await enteredDestroy.promise;
      expect(closed).toBe(false);
      expect(f.pool.end).not.toHaveBeenCalled();
      expect(runtime.enqueue('later', source)).toBe(false);
      runtime.onApplicationBootstrap();
      expect(start).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      events.push('final-operation'); // Simulated ACK phase; no durable SQL claim.
      operation.resolve({ action: 'ack_recorded' });
      await closing;
      expect(events).toEqual(['final-operation', 'drained', 'pool.end']);
      expect(f.pool.end).toHaveBeenCalledTimes(1);
      expect(closed).toBe(true);
      runtime.onApplicationBootstrap();
      expect(runtime.enqueue('after-close', source)).toBe(false);
      await jest.advanceTimersByTimeAsync(10000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledTimes(1);
      f.inert();
    },
  );
});

import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PG_POOL } from '../database/postgres-pool.provider';
import { ConversationGatePurgeWorker } from './application/conversation-gate-purge.worker';
import { ConversationGates } from './application/conversation-gates';
import { ConversationGatePurgeModule } from './conversation-gate-purge.module';
import { ConversationGatesModule } from './conversation-gates.module';
import { CONVERSATION_GATE_STORE } from './domain/conversation-gate.store';
import { PostgresConversationGateStore } from './infrastructure/postgres-conversation-gate.store';

const pool = (order: string[] = []) => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn(),
  end: jest.fn(() => {
    order.push('pool.end');
    return Promise.resolve();
  }),
});

describe('ConversationGatesModule wiring (S4)', () => {
  it('binds the Postgres store and one shared ConversationGates, without a worker', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        ConversationGatesModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    expect(moduleRef.get(CONVERSATION_GATE_STORE)).toBeInstanceOf(
      PostgresConversationGateStore,
    );
    expect(moduleRef.get(ConversationGates)['store']).toBe(
      moduleRef.get(CONVERSATION_GATE_STORE),
    );
    expect(() => moduleRef.get(ConversationGatePurgeWorker)).toThrow();
    await moduleRef.close();
  });

  it('the purge module runs one worker that stops before the pool closes', async () => {
    const order: string[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        ConversationGatePurgeModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool(order))
      .compile();
    const worker = moduleRef.get(ConversationGatePurgeWorker);
    expect(worker).toBeInstanceOf(ConversationGatePurgeWorker);
    const stop = worker.onModuleDestroy.bind(worker);
    jest.spyOn(worker, 'onModuleDestroy').mockImplementation(() => {
      order.push('worker.stop');
      return stop();
    });
    await moduleRef.init();
    await moduleRef.close();
    expect(order).toEqual(['worker.stop', 'pool.end']);
  });
});

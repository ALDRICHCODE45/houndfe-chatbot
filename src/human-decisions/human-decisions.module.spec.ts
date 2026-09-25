import {
  Inject,
  Injectable,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import {
  SHARED_RESERVATION,
  type SharedReservationPort,
} from './domain/shared-reservation';
import { HumanDecisionsModule } from './human-decisions.module';
import { PostgresSharedReservationStore } from './infrastructure/postgres-shared-reservation.store';

/**
 * Synthetic DI wiring test for HumanDecisionsModule: it proves the
 * SHARED_RESERVATION token resolves to exactly one PostgresSharedReservationStore
 * and that the token is exported to an importing module, using a fake PG_POOL so
 * no connection is opened and `reserve` is never invoked during module init.
 */
@Injectable()
class ReservationConsumer {
  constructor(
    @Inject(SHARED_RESERVATION) readonly port: SharedReservationPort,
  ) {}
}

@Module({
  imports: [HumanDecisionsModule],
  providers: [ReservationConsumer],
})
class ConsumerModule {}

const fakePool = {
  connect: jest.fn(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
  end: jest.fn().mockResolvedValue(undefined),
};

const compile = (imports: NonNullable<ModuleMetadata['imports']>) =>
  Test.createTestingModule({ imports })
    .overrideProvider(PG_POOL)
    .useValue(fakePool)
    .compile();

describe('HumanDecisionsModule binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('binds SHARED_RESERVATION to one inert PostgresSharedReservationStore', async () => {
    const moduleRef = await compile([DatabaseModule, HumanDecisionsModule]);
    const first = moduleRef.get<SharedReservationPort>(SHARED_RESERVATION);
    const second = moduleRef.get<SharedReservationPort>(SHARED_RESERVATION);
    expect(first).toBeInstanceOf(PostgresSharedReservationStore);
    expect(second).toBe(first);
    // Inert: resolving the token never opens a connection or issues SQL.
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(fakePool.query).not.toHaveBeenCalled();
    await moduleRef.close();
    expect(fakePool.end).toHaveBeenCalledTimes(1);
  });

  it('exports SHARED_RESERVATION to a consuming module', async () => {
    const moduleRef = await compile([ConsumerModule]);
    const consumer = moduleRef.get(ReservationConsumer);
    expect(consumer.port).toBeInstanceOf(PostgresSharedReservationStore);
    expect(fakePool.connect).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});

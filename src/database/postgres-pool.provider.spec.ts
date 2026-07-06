import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import {
  PG_POOL,
  postgresPoolFactory,
  PostgresPoolLifecycle,
} from './postgres-pool.provider';

/**
 * Tests for the singleton pg.Pool provider + OnModuleDestroy lifecycle.
 *
 * 4.1: factory injects ConfigService and returns a Pool wired to
 *      database.url / database.poolMax.
 * 4.3: PostgresPoolLifecycle.onModuleDestroy() calls pool.end().
 */
describe('PG_POOL provider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds a Pool with connectionString + max from the typed config', () => {
    const get = jest.fn((key: string) => {
      if (key === 'database.url') return 'postgres://u:p@db:5432/x';
      if (key === 'database.poolMax') return 7;
      return undefined;
    });
    const config = { get } as unknown as ConfigService;

    const pool = postgresPoolFactory(config);

    expect(pool).toBeInstanceOf(Pool);
    expect(get).toHaveBeenCalledWith('database.url');
    expect(get).toHaveBeenCalledWith('database.poolMax');
    const options = (pool as unknown as { options: { connectionString?: string; max?: number } }).options;
    expect(options.connectionString).toBe('postgres://u:p@db:5432/x');
    expect(options.max).toBe(7);
  });

  it('exposes a unique Symbol token for DI', () => {
    expect(typeof PG_POOL).toBe('symbol');
  });
});

describe('PostgresPoolLifecycle', () => {
  it('calls pool.end() in onModuleDestroy', async () => {
    const end = jest.fn().mockResolvedValue(undefined);
    const pool = { end } as unknown as Pool;

    const lifecycle = new PostgresPoolLifecycle(pool);
    await lifecycle.onModuleDestroy();

    expect(end).toHaveBeenCalledTimes(1);
  });

  it('is resolvable as a Nest provider (smoke test)', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: PG_POOL,
          useValue: { end: jest.fn().mockResolvedValue(undefined) },
        },
        PostgresPoolLifecycle,
      ],
    }).compile();

    const lifecycle = moduleRef.get(PostgresPoolLifecycle);
    expect(lifecycle).toBeInstanceOf(PostgresPoolLifecycle);

    await moduleRef.close();
  });
});
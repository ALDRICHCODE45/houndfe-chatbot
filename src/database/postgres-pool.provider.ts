import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

/**
 * DI token for the singleton pg.Pool that backs the durable
 * conversation store. Imported by DatabaseModule (producer) and
 * PostgresConversationStore (consumer).
 */
export const PG_POOL = Symbol('PG_POOL');

/**
 * Factory that builds a pg.Pool from typed AppConfig.database values.
 *
 * Provided to Nest via `useFactory: postgresPoolFactory` on the
 * DatabaseModule. The Pool is a singleton per application process;
 * it is closed by PostgresPoolLifecycle.onModuleDestroy().
 */
export function postgresPoolFactory(config: ConfigService): Pool {
  return new Pool({
    connectionString: config.get<string>('database.url'),
    max: config.get<number>('database.poolMax'),
  });
}

/**
 * Lifecycle hook that closes the singleton pg.Pool on Nest shutdown.
 *
 * `enableShutdownHooks()` in main.ts causes Nest to invoke
 * `onModuleDestroy()` on every provider that implements it, in reverse
 * dependency order — closing the pool BEFORE the process exits so no
 * connections are leaked.
 */
@Injectable()
export class PostgresPoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
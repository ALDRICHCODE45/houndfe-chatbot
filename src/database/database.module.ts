import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  PG_POOL,
  postgresPoolFactory,
  PostgresPoolLifecycle,
} from './postgres-pool.provider';

/**
 * DatabaseModule
 *
 * Provides the singleton pg.Pool that backs the durable conversation
 * store. The pool is constructed from typed AppConfig.database values
 * (DATABASE_URL, DB_POOL_MAX) and is closed on Nest shutdown by
 * PostgresPoolLifecycle.
 *
 * Import this module from any feature module that needs PG_POOL
 * (e.g. PostgresConversationStore via ConversationModule).
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_POOL,
      useFactory: postgresPoolFactory,
      inject: [ConfigService],
    },
    PostgresPoolLifecycle,
  ],
  exports: [PG_POOL, PostgresPoolLifecycle],
})
export class DatabaseModule {}
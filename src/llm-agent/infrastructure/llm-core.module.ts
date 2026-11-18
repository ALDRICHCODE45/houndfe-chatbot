import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import {
  CostGuardService,
  type CostGuardSettings,
} from '../application/cost-guard.service';
import { LLM_SPEND_STORE, type LlmSpendStore } from '../domain/llm-spend';
import { GENERATE_TEXT, generateTextImpl } from './generate-text.provider';
import { PostgresLlmSpendStore } from './postgres-llm-spend.store';

/**
 * Shared LLM seams: the GENERATE_TEXT network seam and the single
 * CostGuardService over the persistent spend ledger (migration 5100).
 * Imported by LlmAgentModule (agent turns), ReceiptMediaModule (receipt
 * vision) and ProductImageModule (product photos), so every call books
 * against the same daily/monthly budget, across restarts and processes.
 */
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    { provide: GENERATE_TEXT, useValue: generateTextImpl },
    { provide: LLM_SPEND_STORE, useClass: PostgresLlmSpendStore },
    {
      provide: CostGuardService,
      inject: [ConfigService, LLM_SPEND_STORE],
      useFactory: (config: ConfigService, store: LlmSpendStore) =>
        new CostGuardService({
          ...config.get<{ costGuard?: CostGuardSettings }>('llm')?.costGuard,
          store,
        }),
    },
  ],
  exports: [GENERATE_TEXT, CostGuardService],
})
export class LlmCoreModule {}

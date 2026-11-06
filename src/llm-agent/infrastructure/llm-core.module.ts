import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CostGuardService } from '../application/cost-guard.service';
import { GENERATE_TEXT, generateTextImpl } from './generate-text.provider';

/**
 * Shared LLM seams: the GENERATE_TEXT network seam and the single
 * process-local CostGuardService. Imported by LlmAgentModule (agent turns)
 * and ReceiptMediaModule (receipt vision pre-fill) so both spend against
 * the same monthly budget counter.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    { provide: GENERATE_TEXT, useValue: generateTextImpl },
    {
      provide: CostGuardService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new CostGuardService(
          config.get<{ monthlyTokenCeiling: number }>('llm')!
            .monthlyTokenCeiling,
        ),
    },
  ],
  exports: [GENERATE_TEXT, CostGuardService],
})
export class LlmCoreModule {}

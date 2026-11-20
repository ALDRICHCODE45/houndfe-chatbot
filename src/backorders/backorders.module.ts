import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BACKORDER_CLIENT } from './domain/backorder';
import { BackorderOfferRegistry } from './domain/backorder-offer';
import { BackorderHttpClient } from './infrastructure/backorder-http.client';

/**
 * BackordersModule (restock backorder, T4)
 *
 *   - `BACKORDER_CLIENT` → HTTP adapter of `/chatbot-api/backorders`, a port
 *     apart from `CHATBOT_API_CLIENT` (its fakes stay valid).
 *   - `BackorderOfferRegistry` → late-bound holder of the offer capability,
 *     registered by `LlmAgentModule` (which owns the customer turn and the
 *     conversation gates) and resolved at call time by the RESTOCK
 *     application coordinator of `HumanDecisionsModule`.
 */
@Module({
  imports: [ConfigModule, HttpModule],
  providers: [
    BackorderHttpClient,
    { provide: BACKORDER_CLIENT, useExisting: BackorderHttpClient },
    BackorderOfferRegistry,
  ],
  exports: [BACKORDER_CLIENT, BackorderOfferRegistry],
})
export class BackordersModule {}

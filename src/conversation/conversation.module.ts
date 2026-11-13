import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { HandoffModeService } from './application/handoff-mode.service';
import { CONVERSATION_STORE } from './domain/conversation-store';
import {
  LIVE_RECONCILE_REF,
  type LiveReconcileRef,
} from './domain/live-reconcile-ref';
import { PostgresConversationStore } from './infrastructure/postgres-conversation.store';

/**
 * ConversationModule
 *
 * Provides the ConversationStore port bound to the durable
 * PostgresConversationStore. The in-memory adapter remains available
 * in src/conversation/infrastructure for unit tests but is no longer
 * wired into the runtime DI graph.
 *
 * Import this module in any feature module that needs to inject
 * the CONVERSATION_STORE token. DatabaseModule is imported here so the
 * PG_POOL token is in scope for PostgresConversationStore's constructor.
 * `HandoffModeService` (S7) is exported for the dispatcher gate and the
 * future feed consumer. `LIVE_RECONCILE_REF` (unit 11 T7) is the late-bound
 * holder of the reconcile worker, shared without a module cycle.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: CONVERSATION_STORE,
      useClass: PostgresConversationStore,
    },
    HandoffModeService,
    // A fresh holder per application (never a module-level singleton).
    {
      provide: LIVE_RECONCILE_REF,
      useFactory: (): LiveReconcileRef => ({}),
    },
  ],
  exports: [CONVERSATION_STORE, HandoffModeService, LIVE_RECONCILE_REF],
})
export class ConversationModule {}

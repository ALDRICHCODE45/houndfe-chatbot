import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  HUMAN_REQUESTS_CLIENT,
  type HumanRequestsClient,
} from '../chatbot-api/domain/chatbot-api.client';
import {
  LIVE_CONVERSATION_CLIENT,
  type LiveConversationClient,
} from '../chatbot-api/domain/live-conversation.port';
import {
  SCHEDULING_CLIENT,
  type SchedulingClient,
} from '../chatbot-api/domain/scheduling.port';
import { ConversationModule } from '../conversation/conversation.module';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../conversation/domain/conversation-store';
import { HumanRequestCreateService } from '../human-requests/application/human-request-create.service';
import {
  HUMAN_REQUEST_FEED_STORE,
  type HumanRequestFeedStore,
} from '../human-requests/domain/human-request-feed';
import { HumanRequestsServicesModule } from '../human-requests/human-requests.module';
import { OUT_OF_HOURS_POLICY } from '../whatsapp/domain/out-of-hours-policy';
import { SchedulingOutOfHoursPolicy } from './application/scheduling-out-of-hours.policy';
import { SchedulingStateService } from './application/scheduling-state.service';

/**
 * Unit 14 (scheduled conversations): the durable offer/appointment state and
 * the `OutOfHoursPolicy` the talk-to-human flow already consults. Importing
 * this module is what switches scheduling on in the dispatcher; whether a
 * branch schedules is decided by the backend (`422 SCHEDULING_DISABLED` falls
 * back to the unit 11 out-of-hours behavior).
 */
@Module({
  imports: [ConversationModule, ChatbotApiModule, HumanRequestsServicesModule],
  providers: [
    {
      provide: SchedulingStateService,
      useFactory: (
        store: ConversationStore,
        live: LiveConversationClient,
      ): SchedulingStateService => new SchedulingStateService({ store, live }),
      inject: [CONVERSATION_STORE, LIVE_CONVERSATION_CLIENT],
    },
    {
      provide: OUT_OF_HOURS_POLICY,
      useFactory: (
        scheduling: SchedulingClient,
        requests: HumanRequestsClient,
        state: SchedulingStateService,
        team: HumanRequestCreateService,
        registry: HumanRequestFeedStore,
      ): SchedulingOutOfHoursPolicy =>
        new SchedulingOutOfHoursPolicy({
          scheduling,
          requests,
          state,
          team,
          registry,
        }),
      inject: [
        SCHEDULING_CLIENT,
        HUMAN_REQUESTS_CLIENT,
        SchedulingStateService,
        HumanRequestCreateService,
        HUMAN_REQUEST_FEED_STORE,
      ],
    },
  ],
  exports: [OUT_OF_HOURS_POLICY, SchedulingStateService],
})
export class SchedulingModule {}

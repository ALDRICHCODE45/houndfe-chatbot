import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  HUMAN_REQUESTS_CLIENT,
  type HumanRequestsClient,
} from '../chatbot-api/domain/chatbot-api.client';
import {
  SCHEDULING_CLIENT,
  type SchedulingClient,
} from '../chatbot-api/domain/scheduling.port';
import { HumanRequestCreateService } from '../human-requests/application/human-request-create.service';
import {
  HUMAN_REQUEST_FEED_STORE,
  type HumanRequestFeedStore,
} from '../human-requests/domain/human-request-feed';
import { HumanRequestsServicesModule } from '../human-requests/human-requests.module';
import { OUT_OF_HOURS_POLICY } from '../whatsapp/domain/out-of-hours-policy';
import { SchedulingOutOfHoursPolicy } from './application/scheduling-out-of-hours.policy';
import { AppointmentIntentService } from './application/appointment-intent.service';
import { SchedulingStateService } from './application/scheduling-state.service';
import { SchedulingStateModule } from './scheduling-state.module';

/**
 * Unit 14 (scheduled conversations): the durable offer/appointment state and
 * the `OutOfHoursPolicy` the talk-to-human flow already consults. Importing
 * this module is what switches scheduling on in the dispatcher; whether a
 * branch schedules is decided by the backend (`422 SCHEDULING_DISABLED` falls
 * back to the unit 11 out-of-hours behavior).
 */
@Module({
  imports: [
    ChatbotApiModule,
    HumanRequestsServicesModule,
    SchedulingStateModule,
  ],
  providers: [
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
          // T4: appointment questions, change and cancel.
          appointments: new AppointmentIntentService({
            scheduling,
            requests,
            state,
            registry,
          }),
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
  exports: [OUT_OF_HOURS_POLICY, SchedulingStateModule],
})
export class SchedulingModule {}

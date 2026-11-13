import { Logger } from '@nestjs/common';
import type {
  HumanRequestCreateService,
  TalkToHumanOutcome,
} from '../../human-requests/application/human-request-create.service';
import {
  ASK_TEAM_OPEN_LIMIT_REPLY,
  ASK_TEAM_RATE_LIMITED_REPLY,
  TALK_TO_HUMAN_QUEUED_REPLY,
  type TalkToHumanInput,
} from '../../human-requests/domain/human-request-create';
import { maskConversationRef } from '../../human-requests/domain/human-request-feed';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import { describeError } from '../../common/log-safe';
import {
  FixedHoursOutOfHoursPolicy,
  TALK_TO_HUMAN_IN_HOURS_REPLY,
  TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
  type AskPlan,
  type OutOfHoursPolicy,
} from '../domain/out-of-hours-policy';

export interface TalkToHumanPorts {
  team: Pick<HumanRequestCreateService, 'requestTalkToHuman'>;
  /** The unit 14 branch point; defaults to the fixed hours text (and never
   *  plans an ask). */
  policy?: OutOfHoursPolicy;
}

/**
 * T8 / S6: the customer clearly asked for a person. Creates the
 * TALK_TO_HUMAN request (the backend merges a repeated ask into the open
 * one) and decides the customer copy: in hours, or out of hours through the
 * `OutOfHoursPolicy`. `businessHours: null` (backend without a calendar) is
 * never "closed". Returns the usted copy (the caller styles it), or null when
 * nothing was promised and the normal agent turn should run instead.
 */
export class TalkToHumanService {
  private readonly logger = new Logger(TalkToHumanService.name);
  private readonly policy: OutOfHoursPolicy;

  constructor(private readonly ports: TalkToHumanPorts) {
    this.policy = ports.policy ?? new FixedHoursOutOfHoursPolicy();
  }

  /** Never throws. */
  async handle(input: TalkToHumanInput): Promise<string | null> {
    const plan = await this.planAsk(input);
    if (plan.kind === 'reply') return plan.text;
    const closedReply =
      plan.kind === 'create_then_reply' ? plan.closedReply : null;
    let outcome: TalkToHumanOutcome;
    try {
      outcome = await this.ports.team.requestTalkToHuman(input);
    } catch (error) {
      this.logger.warn(
        `talk-to-human create threw for ${maskConversationRef(conversationRefFor(input.senderId))}: ${describeError(error)}`,
      );
      return null;
    }
    switch (outcome.kind) {
      case 'registered': {
        const hours = outcome.businessHours;
        if (hours === null || hours.openNow !== false)
          return TALK_TO_HUMAN_IN_HOURS_REPLY;
        if (closedReply !== null) return closedReply;
        try {
          return await this.policy.outOfHoursReply({
            senderId: input.senderId,
            requestId: outcome.requestId,
            merged: outcome.merged,
            businessHours: hours,
          });
        } catch (error) {
          this.logger.warn(
            `out-of-hours policy failed for ${maskConversationRef(conversationRefFor(input.senderId))}, using the fixed text: ${describeError(error)}`,
          );
          return TALK_TO_HUMAN_OUT_OF_HOURS_REPLY;
        }
      }
      case 'queued':
        return TALK_TO_HUMAN_QUEUED_REPLY;
      case 'open_limit':
        return ASK_TEAM_OPEN_LIMIT_REPLY;
      case 'customer_rate_limited':
        return ASK_TEAM_RATE_LIMITED_REPLY;
      case 'failed':
        return null;
    }
  }

  /** The policy's pre-create plan; a missing hook or a failure is today's
   *  flow. */
  private async planAsk(input: TalkToHumanInput): Promise<AskPlan> {
    if (this.policy.planAsk === undefined) return { kind: 'default' };
    try {
      return await this.policy.planAsk({
        senderId: input.senderId,
        inboundAt: input.inboundAt ?? null,
        triggerWaMessageId: input.triggerWaMessageId ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `out-of-hours plan failed for ${maskConversationRef(conversationRefFor(input.senderId))}, using the default flow: ${describeError(error)}`,
      );
      return { kind: 'default' };
    }
  }
}

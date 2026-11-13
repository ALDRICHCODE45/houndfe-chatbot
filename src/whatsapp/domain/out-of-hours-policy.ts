import type { HumanRequestBusinessHours } from '../../chatbot-api/domain/dtos/human-requests.dto';

/**
 * T8 / S5: the customer copy for "quiero hablar con una persona". Owner
 * approved, usted; `applyCustomerStyle` turns it into tú through the curated
 * pairs in `customer-style.ts`.
 */
export const TALK_TO_HUMAN_IN_HOURS_REPLY =
  'Con gusto, ya le pedí a una persona del equipo que le atienda. En cuanto alguien esté disponible, le escribe por aquí.';
export const TALK_TO_HUMAN_OUT_OF_HOURS_REPLY =
  'Nuestro equipo atiende de lunes a sábado de 9 a 19 h. Ya dejé su solicitud y le escriben en cuanto abramos.';

/** What the policy knows about the request the backend just accepted. */
export interface OutOfHoursContext {
  /** Raw Meta wa_id. */
  senderId: string;
  requestId: string | null;
  /** The ask merged into an already open request. */
  merged: boolean;
  /** The create answer's calendar verdict; `openNow` is false here. */
  businessHours: HumanRequestBusinessHours;
}

/** A clear talk-to-human ask, before anything is created. */
export interface AskContext {
  /** Raw Meta wa_id. */
  senderId: string;
  /** The inbound's time (ISO), null when absent or unparsable. */
  inboundAt: string | null;
  triggerWaMessageId: string | null;
}

/**
 * What the policy decides BEFORE the unscheduled create (unit 14: it needs
 * to know whether the branch is open before creating anything):
 *  - `default`: today's flow (create, then in-hours / out-of-hours copy).
 *  - `reply`: the policy answered (e.g. the slot offer); NO request is
 *    created now.
 *  - `create_then_reply`: create the unscheduled request as today; when the
 *    create answer says the branch is closed, answer `closedReply` instead of
 *    `outOfHoursReply` (e.g. "no hay horarios, le escriben cuando abramos").
 * Texts are usted (the dispatcher styles them).
 */
export type AskPlan =
  | { kind: 'default' }
  | { kind: 'reply'; text: string }
  | { kind: 'create_then_reply'; closedReply: string };

/** A plain customer text while the policy may hold an open offer. */
export interface ReplyContext {
  senderId: string;
  text: string;
  inboundAt: string | null;
  messageId: string;
}

/** `pass`: not for the policy, run the normal turn. */
export type ReplyOutcome = { kind: 'pass' } | { kind: 'reply'; text: string };

/**
 * The branch point for out-of-hours talk-to-human requests. `outOfHoursReply`
 * is called AFTER an unscheduled request was created (the unit 11 behavior,
 * and the default). Unit 14 (scheduled conversations) provides
 * `OUT_OF_HOURS_POLICY` with the optional hooks: `planAsk` runs BEFORE the
 * create and may take over the ask (offer slots), and `handleReply` sees the
 * customer's next plain text BEFORE the LLM turn (the slot choice). All
 * return usted copy (the dispatcher styles it) and may throw: the callers
 * then fall back (`planAsk` → default flow, `handleReply` → normal turn,
 * `outOfHoursReply` → the fixed text).
 */
export interface OutOfHoursPolicy {
  outOfHoursReply(context: OutOfHoursContext): Promise<string>;
  planAsk?(context: AskContext): Promise<AskPlan>;
  handleReply?(context: ReplyContext): Promise<ReplyOutcome>;
}

export const OUT_OF_HOURS_POLICY = Symbol('OUT_OF_HOURS_POLICY');

/** Default: the fixed "lunes a sábado de 9 a 19 h" text, whatever the day. */
export class FixedHoursOutOfHoursPolicy implements OutOfHoursPolicy {
  outOfHoursReply(context: OutOfHoursContext): Promise<string> {
    void context;
    return Promise.resolve(TALK_TO_HUMAN_OUT_OF_HOURS_REPLY);
  }
}

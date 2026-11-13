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

/**
 * The branch point for out-of-hours talk-to-human requests. The request is
 * ALWAYS created first; the policy only decides what the customer is told
 * next. Unit 14 (scheduled conversations: offering slots from
 * `businessHours.nextOpenAt`) replaces the default by providing
 * `OUT_OF_HOURS_POLICY`; nothing else in the flow changes. It returns the
 * usted copy (the dispatcher styles it) and may throw: the caller then falls
 * back to the fixed text.
 */
export interface OutOfHoursPolicy {
  outOfHoursReply(context: OutOfHoursContext): Promise<string>;
}

export const OUT_OF_HOURS_POLICY = Symbol('OUT_OF_HOURS_POLICY');

/** Default: the fixed "lunes a sábado de 9 a 19 h" text, whatever the day. */
export class FixedHoursOutOfHoursPolicy implements OutOfHoursPolicy {
  outOfHoursReply(context: OutOfHoursContext): Promise<string> {
    void context;
    return Promise.resolve(TALK_TO_HUMAN_OUT_OF_HOURS_REPLY);
  }
}

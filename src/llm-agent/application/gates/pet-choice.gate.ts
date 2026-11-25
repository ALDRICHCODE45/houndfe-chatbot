import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';

/**
 * S13: the which-pet question stays valid for 15 minutes; after that the
 * customer's answer is treated as a new message.
 */
export const MINIMAL_PET_CHOICE_TTL_MS = 15 * 60 * 1000;

/** Longest original request kept with the question (payload cap 64 KiB). */
export const PET_CHOICE_REQUEST_MAX_CHARS = 8000;

/**
 * Why the bot asked which pet. T4c-2a: `request` (a product request that
 * named no pet). T4c-2b adds its purposes here (forget, ambiguous,
 * diminutive).
 */
export const PET_CHOICE_PURPOSES = ['request'] as const;
export type PetChoicePurpose = (typeof PET_CHOICE_PURPOSES)[number];

/** One offered answer: a pet ref (`backend:<id>`, `local:<id>`, `legacy`)
 *  or `other` («Otra mascota»), and the pet's name (the text a typed answer
 *  is matched against). */
export type PetChoiceOption = {
  readonly ref: string;
  readonly text: string;
};

export type PetChoice = {
  readonly purpose: PetChoicePurpose;
  readonly options: readonly PetChoiceOption[];
  /** The customer's original request, continued once a pet is chosen. */
  readonly request: string;
};

const payloadSchema = z.strictObject({
  purpose: z.enum(PET_CHOICE_PURPOSES),
  options: z
    .array(
      z.strictObject({
        ref: z.string().min(1).max(190),
        text: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(50),
  request: z.string().min(1).max(PET_CHOICE_REQUEST_MAX_CHARS),
});

/**
 * T4c-2a durable `pet_choice` gate: the «¿Para quién es?» question the bot
 * asked, its options and the original request. The agent sets it when a turn
 * asks the question and clears it on any other recorded turn; a restarted
 * process restores it from the durable row. The caller still checks a tapped
 * ref against the current known pets.
 */
export class DurablePetChoice {
  private readonly choices = new Map<
    string,
    { readonly choice: PetChoice; readonly expiresAt: number }
  >();

  constructor(private readonly gates: ConversationGates) {
    gates.register({
      kind: 'pet_choice',
      read: (senderId) => {
        const live = this.live(senderId);
        return live === null
          ? null
          : { payload: copy(live.choice), expiresAt: live.expiresAt };
      },
      write: (senderId, state) => {
        if (state === null) {
          this.choices.delete(senderId);
          return true;
        }
        const parsed = payloadSchema.safeParse(state.payload);
        if (!parsed.success) {
          this.choices.delete(senderId);
          return false;
        }
        this.choices.set(senderId, {
          choice: parsed.data,
          expiresAt: state.expiresAt,
        });
        return true;
      },
    });
  }

  /** The turn just asked which pet (replaces any earlier question). */
  ask(senderId: string, choice: PetChoice): void {
    this.choices.set(senderId, {
      choice: copy(choice),
      expiresAt: this.gates.now() + MINIMAL_PET_CHOICE_TTL_MS,
    });
  }

  clear(senderId: string): void {
    this.choices.delete(senderId);
  }

  /** The live question, or `null` when absent or expired. */
  read(senderId: string): PetChoice | null {
    const live = this.live(senderId);
    return live === null ? null : copy(live.choice);
  }

  private live(senderId: string) {
    const live = this.choices.get(senderId);
    if (live === undefined) return null;
    if (this.gates.now() >= live.expiresAt) {
      this.choices.delete(senderId);
      return null;
    }
    return live;
  }
}

function copy(choice: PetChoice): PetChoice {
  return {
    purpose: choice.purpose,
    options: choice.options.map(({ ref, text }) => ({ ref, text })),
    request: choice.request,
  };
}

/** Lowercase, no accents, letters/digits and single spaces only. */
const foldAnswer = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** «es para el Max» → also «para el max», «el max», «max». */
function answerForms(text: string): Set<string> {
  const forms = new Set<string>();
  let rest = foldAnswer(text);
  forms.add(rest);
  for (const lead of [/^(?:es|son|seria)\s+/, /^para\s+/, /^(?:el|la|mi)\s+/]) {
    rest = rest.replace(lead, '');
    forms.add(rest);
  }
  forms.delete('');
  return forms;
}

/**
 * T4c-2a P3: a typed answer to the which-pet question. Counts only when the
 * whole message is one offered pet's name (optionally «para …», «es para …»,
 * «el/la/mi …») and exactly one option has that name; «Otra mascota» never
 * matches. `null` otherwise (the message is a new one).
 */
export function matchPetChoiceAnswer(
  text: string,
  options: readonly PetChoiceOption[],
  otherRef: string,
): PetChoiceOption | null {
  const forms = answerForms(text);
  const matched = options.filter(
    (option) =>
      option.ref !== otherRef &&
      foldAnswer(option.text) !== '' &&
      forms.has(foldAnswer(option.text)),
  );
  return matched.length === 1 ? matched[0] : null;
}

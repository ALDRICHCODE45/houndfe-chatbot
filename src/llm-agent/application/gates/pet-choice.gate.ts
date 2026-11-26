import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';

/**
 * S13: the which-pet question stays valid for 15 minutes; after that the
 * customer's answer is treated as a new message.
 */
export const MINIMAL_PET_CHOICE_TTL_MS = 15 * 60 * 1000;

/** Longest original request kept with the question (payload cap 64 KiB). */
export const PET_CHOICE_REQUEST_MAX_CHARS = 8000;

/** Longest pet fact (and forget reason) a question keeps (contract: notes
 *  ≤ 500). */
export const PET_CHOICE_FACT_MAX_CHARS = 500;

/** Longest pet name a question keeps (contract: name 1–60). */
export const PET_CHOICE_NAME_MAX_CHARS = 60;

/**
 * Why the bot asked which pet. T4c-2a: `request` (a product request that
 * named no pet). T4c-2b: `forget` (forgetPet named 2+ pets with that name:
 * the tap archives that pet), `ambiguous` (a local entry blocked as
 * ambiguous: which backend pet it is, or another pet), `diminutive` (a
 * captured name like «Brunito» of a known or just-forgotten «Bruno»: the
 * same pet or another one).
 */
export const PET_CHOICE_PURPOSES = [
  'request',
  'forget',
  'ambiguous',
  'diminutive',
] as const;
export type PetChoicePurpose = (typeof PET_CHOICE_PURPOSES)[number];

/** Most options one question keeps (the «Otra mascota» follow-up offers
 *  every known pet up to this cap). */
export const PET_CHOICE_OPTIONS_MAX = 50;

/** T6b: the ref older builds gave the single profile pet (removed). */
const PET_CHOICE_LEGACY_REF = 'legacy';

/**
 * One offered answer: a pet ref (`backend:<id>`, `local:<id>`; T6b: the
 * `legacy` ref of an older build's row is no longer offered, see `read`),
 * `other` («Otra mascota» / «Es otra mascota») or `forgotten` (T4c-2b: the
 * just-forgotten pet a diminutive may name), and its display text: the
 * pet's name, or the kind (breed/species) of a nameless pet. A typed answer
 * is matched against the text unless `matchable` is `false` (a nameless
 * pet: its breed is never an answer). Rows written before the flag carry no
 * `matchable` and keep matching by text.
 */
export type PetChoiceOption = {
  readonly ref: string;
  readonly text: string;
  readonly matchable?: false;
};

/** T4c-2b Q3: the facts of the statement that named the diminutive. */
export type PetChoiceFacts = {
  readonly name?: string;
  readonly species?: string;
  readonly breed?: string;
  readonly size?: string;
  readonly ageText?: string;
  readonly allergies?: string;
  readonly notes?: string;
};

export type PetChoice =
  | {
      readonly purpose: 'request';
      readonly options: readonly PetChoiceOption[];
      /** The customer's original request, continued once a pet is chosen. */
      readonly request: string;
    }
  | {
      readonly purpose: 'forget';
      readonly options: readonly PetChoiceOption[];
      /** The name forgetPet was given. */
      readonly name: string;
      /** The customer's reason, sent with the archive. */
      readonly reason?: string;
    }
  | {
      readonly purpose: 'ambiguous';
      readonly options: readonly PetChoiceOption[];
      /** The blocked local entry the question is about. */
      readonly localId: string;
      /** The customer's message, continued once answered. */
      readonly request: string;
    }
  | {
      readonly purpose: 'diminutive';
      readonly options: readonly PetChoiceOption[];
      /** The captured name («Brunito»). */
      readonly name: string;
      /** What the statement said, written only once answered. */
      readonly facts: PetChoiceFacts;
      /** T4c-2b-fix K4: the customer's message, continued once answered.
       *  Absent on rows written before it (their answer replies as before). */
      readonly request?: string;
    };

const optionsSchema = z
  .array(
    z.strictObject({
      ref: z.string().min(1).max(190),
      text: z.string().min(1).max(200),
      matchable: z.literal(false).optional(),
    }),
  )
  .min(1)
  .max(PET_CHOICE_OPTIONS_MAX);
const requestSchema = z.string().min(1).max(PET_CHOICE_REQUEST_MAX_CHARS);
const fact = z.string().min(1).max(PET_CHOICE_FACT_MAX_CHARS).optional();
const nameSchema = z.string().min(1).max(PET_CHOICE_NAME_MAX_CHARS);

// `request` keeps the exact T4c-2a shape: rows written by 5ab9410/848cdf2
// load unchanged.
const payloadSchema = z.discriminatedUnion('purpose', [
  z.strictObject({
    purpose: z.literal('request'),
    options: optionsSchema,
    request: requestSchema,
  }),
  z.strictObject({
    purpose: z.literal('forget'),
    options: optionsSchema,
    name: nameSchema,
    reason: z.string().min(1).max(PET_CHOICE_FACT_MAX_CHARS).optional(),
  }),
  z.strictObject({
    purpose: z.literal('ambiguous'),
    options: optionsSchema,
    localId: z.string().min(1).max(64),
    request: requestSchema,
  }),
  z.strictObject({
    purpose: z.literal('diminutive'),
    options: optionsSchema,
    name: nameSchema,
    facts: z.strictObject({
      name: fact,
      species: fact,
      breed: fact,
      size: fact,
      ageText: fact,
      allergies: fact,
      notes: fact,
    }),
    request: requestSchema.optional(),
  }),
]);

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

  /** The live question, or `null` when absent or expired. T6b: an option
   *  with the `legacy` ref (a row an older build stored for the single
   *  profile pet, which no longer exists) is not offered any more: its tap
   *  is stale and its text never answers. The durable row is untouched. */
  read(senderId: string): PetChoice | null {
    const live = this.live(senderId);
    if (live === null) return null;
    const choice = copy(live.choice);
    return {
      ...choice,
      options: choice.options.filter(
        (option) => option.ref !== PET_CHOICE_LEGACY_REF,
      ),
    };
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
  const options = choice.options.map(({ ref, text, matchable }) => ({
    ref,
    text,
    ...(matchable === false ? { matchable } : {}),
  }));
  switch (choice.purpose) {
    case 'request':
      return { purpose: 'request', options, request: choice.request };
    case 'forget':
      return {
        purpose: 'forget',
        options,
        name: choice.name,
        ...(choice.reason === undefined ? {} : { reason: choice.reason }),
      };
    case 'ambiguous':
      return {
        purpose: 'ambiguous',
        options,
        localId: choice.localId,
        request: choice.request,
      };
    case 'diminutive':
      return {
        purpose: 'diminutive',
        options,
        name: choice.name,
        facts: Object.fromEntries(
          Object.entries(choice.facts).filter(
            ([, value]) => typeof value === 'string',
          ),
        ),
        ...(choice.request === undefined ? {} : { request: choice.request }),
      };
  }
}

/** Lowercase, no accents, letters/digits and single spaces only (the one
 *  text folder of the pet answers and pet references). */
export const foldWords = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** «es para el Max» → also «para el max», «el max», «max». */
function answerForms(text: string): Set<string> {
  const forms = new Set<string>();
  let rest = foldWords(text);
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
 * «el/la/mi …») and exactly one option has that name; «Otra mascota» and a
 * nameless pet's option (`matchable: false`) never match. `null` otherwise
 * (the message is a new one).
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
      option.matchable !== false &&
      foldWords(option.text) !== '' &&
      forms.has(foldWords(option.text)),
  );
  return matched.length === 1 ? matched[0] : null;
}

/** T4c-2b-fix K2: whole typed answers that mean «it is another pet». */
const OTHER_PET_ANSWERS: ReadonlySet<string> = new Set([
  'otra',
  'otro',
  'otra mascota',
  'otro mascota',
  'ninguno',
  'ninguna',
  'ninguno de esos',
  'ninguna de esas',
  'ninguno de ellos',
  'ninguna de ellas',
  'ninguno de los dos',
  'ninguna de las dos',
]);

/**
 * T4c-2b-fix K2: a typed answer meaning «Es otra mascota» («es otra», «otra
 * mascota», «ninguna de esas», «no, es otro»): the whole message, with an
 * optional leading «no» and «es». Only the ambiguous and diminutive
 * questions use it (the request question's «Otra mascota» row keeps its own
 * behaviour); `matchPetChoiceAnswer` never answers `other`.
 */
export function isOtherPetAnswer(text: string): boolean {
  const folded = foldWords(text)
    .replace(/^no\s+/, '')
    .replace(/^(?:es|son|seria)\s+/, '');
  return OTHER_PET_ANSWERS.has(folded);
}

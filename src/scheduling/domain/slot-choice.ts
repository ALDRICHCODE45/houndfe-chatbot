/**
 * Deterministic parser for the customer's reply to a slot offer. It only
 * ever resolves to a slot that was OFFERED (by number, or by a day/time that
 * matches exactly one offered slot in the branch zone); anything else,
 * including a valid but unoffered time, is `unclear`. Accent/case-insensitive.
 */
import { dayOffset, zonedParts } from './slot-time';

export interface OfferedSlot {
  startsAt: string;
}

export interface SlotChoiceContext {
  /** IANA zone of the branch, from the API. */
  timeZone: string;
  /** Injected "now" (relative days are computed in the zone). */
  now: string | Date;
}

export type SlotChoice =
  | { kind: 'slot'; index: number; startsAt: string }
  | { kind: 'unclear' };

const UNCLEAR: SlotChoice = { kind: 'unclear' };
const MAX_LENGTH = 80;

const ORDINALS: Record<string, number> = {
  '1': 0,
  uno: 0,
  primero: 0,
  primera: 0,
  primer: 0,
  '2': 1,
  dos: 1,
  segundo: 1,
  segunda: 1,
  '3': 2,
  tres: 2,
  tercero: 2,
  tercera: 2,
  tercer: 2,
};

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

/** Lowercase, no accents, no keycap/variation marks, light punctuation. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ⃣️]/g, '')
    .replace(/[¿?¡!,;()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim();
}

const REFUSAL =
  /\b(no|ninguna?|ninguno|ni|o|otra|otro|otras|otros|cancel\w*|mas (tarde|temprano))\b/;

const ORDINAL_LEAD =
  '(?:(?:si|ok|va|claro|quiero|prefiero|elijo|me quedo con|opcion|numero|la|el)\\s+)*';
const ORDINAL_TRAIL =
  '(?:\\s+(?:por favor|porfa|gracias|esta bien|ok|si|perfecto))*';
const ORDINAL = new RegExp(
  `^${ORDINAL_LEAD}#?(${Object.keys(ORDINALS).join('|')})${ORDINAL_TRAIL}$`,
);

interface TimeSpec {
  minute: number;
  /** Candidate 24 h hours for the reply. */
  hours: number[];
}

type Meridiem = 'am' | 'pm' | null;

function candidateHours(hour: number, meridiem: Meridiem): number[] | null {
  if (meridiem !== null) {
    if (hour < 1 || hour > 12) return null;
    return [(hour % 12) + (meridiem === 'pm' ? 12 : 0)];
  }
  if (hour > 23) return null;
  if (hour === 0 || hour >= 13) return [hour];
  return [hour, (hour % 12) + 12 === hour ? hour : (hour % 12) + 12].filter(
    (value, index, all) => all.indexOf(value) === index,
  );
}

/** The time of the reply; `undefined` when none, `null` when invalid. */
function extractTime(
  text: string,
  meridiem: Meridiem,
): TimeSpec | null | undefined {
  const explicit = text.match(/\b([ap])\.?\s?m\b/);
  const day: Meridiem =
    meridiem ?? (explicit ? (explicit[1] === 'a' ? 'am' : 'pm') : null);

  const clock = text.match(/\b(\d{1,2})\s*[:.h]\s*(\d{2})\b/);
  if (clock) {
    const minute = Number(clock[2]);
    const hours = candidateHours(Number(clock[1]), day);
    return hours === null || minute > 59 ? null : { minute, hours };
  }

  let hourToken: number | null = null;
  const withUnit = text.match(/\b(\d{1,2})\s*(?:hrs?|hs|h)\b/);
  const withMeridiem = text.match(/\b(\d{1,2})\s*[ap]\.?\s?m\b/);
  const withArticle = text.match(/\b(?:a |de )?las?\s+(\d{1,2})\b/);
  const una = text.match(/\b(?:a|de)? ?la una\b/);
  if (withUnit) hourToken = Number(withUnit[1]);
  else if (withMeridiem) hourToken = Number(withMeridiem[1]);
  else if (withArticle) hourToken = Number(withArticle[1]);
  else if (una) hourToken = 1;
  if (hourToken === null) return undefined;

  let minute = 0;
  if (/\by media\b/.test(text)) minute = 30;
  else if (/\by cuarto\b/.test(text)) minute = 15;
  const hours = candidateHours(hourToken, day);
  return hours === null ? null : { minute, hours };
}

interface DaySpec {
  offset?: number;
  weekday?: number;
}

function extractDay(text: string): DaySpec | undefined {
  if (/\bpasado manana\b/.test(text)) return { offset: 2 };
  if (/\bmanana\b/.test(text)) return { offset: 1 };
  if (/\bhoy\b/.test(text)) return { offset: 0 };
  const weekday = text.match(
    /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/,
  );
  return weekday ? { weekday: WEEKDAYS[weekday[1]] } : undefined;
}

/**
 * Resolves the customer's reply against the offered slots (`index` is
 * 0-based). Unoffered numbers, unoffered times and ambiguous replies are
 * `unclear`.
 */
export function parseSlotChoice(
  reply: string,
  slots: readonly OfferedSlot[],
  context: SlotChoiceContext,
): SlotChoice {
  if (slots.length === 0 || reply.length > MAX_LENGTH * 2) return UNCLEAR;
  let text = normalize(reply);
  if (text === '' || text.length > MAX_LENGTH) return UNCLEAR;
  if (REFUSAL.test(text)) return UNCLEAR;

  const ordinal = text.match(ORDINAL);
  if (ordinal) {
    const index = ORDINALS[ordinal[1]];
    return index < slots.length
      ? { kind: 'slot', index, startsAt: slots[index].startsAt }
      : UNCLEAR;
  }

  // "de la mañana/tarde/noche" is a day period, not the day "mañana".
  let meridiem: Meridiem = null;
  text = text.replace(
    /\b(?:de|en|por) la (manana|madrugada|tarde|noche)\b/,
    (_match, period: string) => {
      meridiem = period === 'tarde' || period === 'noche' ? 'pm' : 'am';
      return ' ';
    },
  );
  text = text.replace(/\bmedio ?dia\b/, 'a las 12:00 pm');

  const day = extractDay(text);
  const time = extractTime(text, meridiem);
  if (time === null) return UNCLEAR;
  if (time === undefined && day === undefined) return UNCLEAR;

  const matches: number[] = [];
  slots.forEach((slot, index) => {
    const parts = zonedParts(slot.startsAt, context.timeZone);
    if (day?.offset !== undefined) {
      if (
        dayOffset(slot.startsAt, context.timeZone, context.now) !== day.offset
      ) {
        return;
      }
    }
    if (day?.weekday !== undefined && parts.weekday !== day.weekday) return;
    if (
      time !== undefined &&
      !(time.hours.includes(parts.hour) && time.minute === parts.minute)
    ) {
      return;
    }
    matches.push(index);
  });

  return matches.length === 1
    ? { kind: 'slot', index: matches[0], startsAt: slots[matches[0]].startsAt }
    : UNCLEAR;
}

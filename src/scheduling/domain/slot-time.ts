/**
 * S4 time formatting for scheduled conversations: pure, in the branch time
 * zone the API returns (IANA name), through `Intl.DateTimeFormat('es-MX',
 * {timeZone})` only. Never a fixed offset, never "en 10 minutos".
 *
 * Style (one, consistent): 12 h clock with the es-MX day period spelled
 * "a. m." / "p. m." and plain ASCII spaces: "9:30 a. m.", "4:00 p. m.",
 * "12:00 p. m.". Intl's own output varies by ICU version ("a.m.", U+202F,
 * U+00A0), so the hour and minute come from `formatToParts` and the day
 * period is rebuilt here.
 *
 * Days: "hoy", "mañana" (computed in the zone relative to the injected
 * `now`), otherwise "el lunes 16 de noviembre". The `{cuándo}` form drops
 * the date for the next 6 days ("el lunes a las 9:00 a. m.") and keeps it
 * from 7 days on, where a bare weekday would be ambiguous.
 */

export interface SlotLabel {
  /** `{día}`: "hoy" | "mañana" | "el lunes 16 de noviembre". */
  day: string;
  /** `{hora}`: "9:30 a. m.". */
  time: string;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
}

type Instant = string | Date;

const LOCALE = 'es-MX';

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const nameFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(LOCALE, {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function nameFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = nameFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(LOCALE, {
      timeZone,
      weekday: 'long',
      month: 'long',
    });
    nameFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function toDate(instant: Instant): Date {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid instant: ${String(instant)}`);
  }
  return date;
}

const DAY_MS = 86_400_000;

/** Days since the epoch of a local calendar date (zone-free arithmetic). */
export function localDayNumber(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'>,
): number {
  return Math.round(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

/** The local calendar fields of an instant in `timeZone`. */
export function zonedParts(instant: Instant, timeZone: string): ZonedParts {
  const date = toDate(instant);
  const read: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') read[part.type] = Number(part.value);
  }
  const year = read['year'];
  const month = read['month'];
  const day = read['day'];
  return {
    year,
    month,
    day,
    hour: read['hour'] % 24,
    minute: read['minute'],
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Local days from `now` to `instant` in the zone (0 = same local day). */
export function dayOffset(
  instant: Instant,
  timeZone: string,
  now: Instant,
): number {
  return (
    localDayNumber(zonedParts(instant, timeZone)) -
    localDayNumber(zonedParts(now, timeZone))
  );
}

/** `{hora}`: "9:30 a. m." (12 h, plain spaces). */
export function formatClock(instant: Instant, timeZone: string): string {
  const { hour, minute } = zonedParts(instant, timeZone);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, '0')} ${
    hour < 12 ? 'a. m.' : 'p. m.'
  }`;
}

/** Lower-case es-MX weekday and month names of the instant in the zone. */
function names(
  instant: Instant,
  timeZone: string,
): { weekday: string; month: string } {
  let weekday = '';
  let month = '';
  for (const part of nameFormatter(timeZone).formatToParts(toDate(instant))) {
    if (part.type === 'weekday') weekday = part.value.toLowerCase();
    if (part.type === 'month') month = part.value.toLowerCase();
  }
  return { weekday, month };
}

function absoluteDay(instant: Instant, timeZone: string): string {
  const { day } = zonedParts(instant, timeZone);
  const { weekday, month } = names(instant, timeZone);
  return `el ${weekday} ${day} de ${month}`;
}

/** `{día}`: "hoy" | "mañana" | "el lunes 16 de noviembre". */
export function formatDay(
  instant: Instant,
  timeZone: string,
  now: Instant,
): string {
  const offset = dayOffset(instant, timeZone, now);
  if (offset === 0) return 'hoy';
  if (offset === 1) return 'mañana';
  return absoluteDay(instant, timeZone);
}

/** "a las 9:30 a. m." — "a la 1:00 p. m." for one o'clock. */
export function atTime(clock: string): string {
  return /^1:/.test(clock) ? `a la ${clock}` : `a las ${clock}`;
}

/**
 * `{cuándo}` for "abrimos {cuándo}": "hoy a las 4:00 p. m." |
 * "mañana a las 9:00 a. m." | "el lunes a las 9:00 a. m." (≤ 6 days ahead,
 * else with the date: "el jueves 19 de noviembre a las 9:00 a. m.").
 */
export function formatWhen(
  instant: Instant,
  timeZone: string,
  now: Instant,
): string {
  const offset = dayOffset(instant, timeZone, now);
  let day: string;
  if (offset === 0) day = 'hoy';
  else if (offset === 1) day = 'mañana';
  else if (offset > 1 && offset <= 6) {
    day = `el ${names(instant, timeZone).weekday}`;
  } else day = absoluteDay(instant, timeZone);
  return `${day} ${atTime(formatClock(instant, timeZone))}`;
}

/** The `{día}` / `{hora}` pieces of one offered slot. */
export function slotLabel(
  instant: Instant,
  timeZone: string,
  now: Instant,
): SlotLabel {
  return {
    day: formatDay(instant, timeZone, now),
    time: formatClock(instant, timeZone),
  };
}

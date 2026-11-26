/**
 * Message formatting (WhatsApp) S2–S4: shared, pure building blocks for the
 * server-owned customer copy. WhatsApp renders `*bold*` and `_italic_` only
 * when the markers touch the text, so edge spaces are always trimmed.
 *
 * Title emojis (S3) go to every customer: `applyCustomerStyle` keeps a
 * `TITLE_EMOJIS` emoji that closes a bold title line (see
 * `TITLE_EMOJI_LINE`), while every other emoji follows the customer's style.
 */

import type { CustomerReplyLocation } from './customer-reply';

/** S3: the only emojis a server-owned title may carry. */
export const TITLE_EMOJI = Object.freeze({
  summary: '🧾',
  shipping: '🚚',
  created: '✅',
} as const);

export type TitleEmoji = (typeof TITLE_EMOJI)[keyof typeof TITLE_EMOJI];

export const TITLE_EMOJIS: readonly TitleEmoji[] = Object.values(TITLE_EMOJI);

/**
 * A title line as `sectionTitle` renders it: `*Title* 🧾` and nothing else.
 * Group 1 is the protected « 🧾» suffix.
 */
export const TITLE_EMOJI_LINE = new RegExp(
  `^\\*[^*\\n]+\\*( (?:${TITLE_EMOJIS.join('|')}))$`,
  'u',
);

/** S2: indentation of the detail lines under an item bullet. */
export const ITEM_DETAIL_INDENT = '   ';

/**
 * F2-fix G1: an interpolated catalog/customer value (product, variant, pet
 * or customer name, promotion title, address field) made safe to place in
 * or next to WhatsApp markup. The markers `*` and `~` and the monospace
 * backtick are dropped, `_` becomes a space («2x1_Mayo» → «2x1 Mayo»), and
 * runs of spaces collapse, so a value can never open or close a bold,
 * italic, strike or monospace span of the surrounding copy. Display only:
 * stored data and consent snapshots are never rewritten.
 */
export function plain(value: string): string {
  return value
    .replace(/[*~`]/g, '')
    .replace(/_/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** `*text*`, trimmed; empty text stays empty. */
export function bold(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : `*${trimmed}*`;
}

/** `_text_`, trimmed; empty text stays empty. */
export function italic(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : `_${trimmed}_`;
}

/** S4: «$1,250.00» — thousands separator, two decimals, no «MXN». */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const [units, decimals] = (Math.abs(Math.round(cents)) / 100)
    .toFixed(2)
    .split('.');
  return `${sign}$${units.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals}`;
}

/** S2/S3: `*Title*`, with the optional title emoji after it. */
export function sectionTitle(title: string, emoji?: TitleEmoji): string {
  return emoji === undefined ? bold(title) : `${bold(title)} ${emoji}`;
}

/** S2: «• <label>», the first line of an item. */
export function itemLine(label: string): string {
  return `• ${label}`;
}

/** S2: a detail line of an item, indented under its bullet. */
export function itemDetail(text: string): string {
  return `${ITEM_DETAIL_INDENT}${text}`;
}

/** T3-fix E8: `text` within `max` characters, cut between words with «…». */
export function truncateOnWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max).join('');
  const cut = chars[max] === ' ' ? head : head.replace(/\s+\S*$/, '');
  return `${(cut === '' ? head : cut).trimEnd()}…`;
}

/**
 * T2-fix J8: the store pin's labels are short captions under the map: the
 * branch name is capped at this many characters and the address at
 * `STORE_PIN_ADDRESS_MAX_CHARS`, cut on a word boundary with «…» (a long
 * backend value never makes Meta refuse the pin).
 */
export const STORE_PIN_NAME_MAX_CHARS = 100;
export const STORE_PIN_ADDRESS_MAX_CHARS = 250;

/** T2-fix J8: `text` in at most `max` characters, the «…» included. */
const capLabel = (text: string, max: number): string =>
  Array.from(text).length <= max ? text : truncateOnWord(text, max - 1);

/** T2 H3/H4: the branch as the store pin needs it (any source). */
export interface StorePinSource {
  name: string;
  address: { formatted: string } | null;
  location?: { latitude: number; longitude: number } | null;
}

/**
 * T2 H3/H4: the WhatsApp location message for a branch: its coordinates,
 * labelled with the plain name and address (final dots dropped, as in
 * `storeLines`; capped, T2-fix J8; an empty label is left out). `undefined`
 * without coordinates (missing or null): no pin is ever invented.
 */
export function storePin(
  source: StorePinSource,
): CustomerReplyLocation | undefined {
  const location = source.location;
  if (location === null || location === undefined) return undefined;
  const name = capLabel(
    withoutFinalDot(plain(source.name)),
    STORE_PIN_NAME_MAX_CHARS,
  );
  const address =
    source.address === null
      ? ''
      : capLabel(
          withoutFinalDot(plain(source.address.formatted)),
          STORE_PIN_ADDRESS_MAX_CHARS,
        );
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    ...(name === '' ? {} : { name }),
    ...(address === '' ? {} : { address }),
  };
}

/** The pickup branch as the store block needs it (structural, any source). */
export interface StoreLinesLocation {
  name: string;
  address: { formatted: string } | null;
  hours: { summary: string } | null;
}

const withoutFinalDot = (text: string): string =>
  text.trim().replace(/\.+$/, '').trim();

/**
 * Message formatting F3b-fix H3: the one store block of the server copy
 * (order created, pay-in-store hold, pickup reminder). «<lead><name>» with
 * the bold branch name, then the address and the bold «Horario:» line, each
 * on its own line; values are `plain` and the name and address lose their
 * final dots. A name emptied by `plain()` reads «la tienda» (address and
 * hours still shown); «la tienda» alone closes the sentence with a dot.
 */
export function storeLines(
  lead: string,
  location: StoreLinesLocation,
): string[] {
  const name = withoutFinalDot(plain(location.name));
  const address =
    location.address === null
      ? ''
      : withoutFinalDot(plain(location.address.formatted));
  const hours = location.hours === null ? '' : plain(location.hours.summary);
  const details = [
    ...(address === '' ? [] : [address]),
    ...(hours === '' ? [] : [`${bold('Horario:')} ${hours}`]),
  ];
  const place =
    name !== ''
      ? bold(name)
      : details.length === 0
        ? 'la tienda.'
        : 'la tienda';
  return [`${lead}${place}`, ...details];
}

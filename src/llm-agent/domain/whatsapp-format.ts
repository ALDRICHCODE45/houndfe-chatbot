/**
 * Message formatting (WhatsApp) S2–S4: shared, pure building blocks for the
 * server-owned customer copy. WhatsApp renders `*bold*` and `_italic_` only
 * when the markers touch the text, so edge spaces are always trimmed.
 *
 * Title emojis (S3) go to every customer: `applyCustomerStyle` keeps a
 * `TITLE_EMOJIS` emoji that closes a bold title line (see
 * `TITLE_EMOJI_LINE`), while every other emoji follows the customer's style.
 */

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

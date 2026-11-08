/**
 * H1: rewrites model-authored Markdown into text WhatsApp renders. WhatsApp
 * bold is `*x*`, it shows images/links as raw URLs, and has no headings.
 * Product photos travel separately as media, so image syntax is dropped.
 * Pure; only for model text (deterministic replies are already plain).
 */

const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;
const IMAGE_URL = /\.(?:jpe?g|png|gif|webp|avif|svg)(?:[?#]\S*)?$/i;
const HEADING = /^#{1,6}\s+/;
const BULLET = /^[-*+•]\s+/;
const ORDERED = /^(\d{1,3})[.)]\s+/;
/** A line left with nothing but a list marker. */
const MARKER_ONLY = /^(?:[-*+•]|\d{1,3}[.)])?$/;

const link = (_match: string, label: string, url: string): string => {
  // A link to a product photo goes entirely: the photo is sent as media.
  if (IMAGE_URL.test(url)) return '';
  if (label.trim() !== url) return label;
  return /^https:\/\//i.test(url) ? url : '';
};

const bold = (text: string): string =>
  text
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '*$1*')
    .replace(/(^|[^\w])__(?=\S)([^_\n]+?)(?<=\S)__(?![\w])/g, '$1*$2*');

function formatLine(raw: string): string | null {
  const indent = raw.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0;
  const trimmed = raw.trim();
  const unlinked = trimmed.replace(IMAGE, '').replace(LINK, link);
  let body = unlinked.replace(/[ \t]{2,}/g, ' ').trim();
  if (unlinked !== trimmed && MARKER_ONLY.test(body)) return null;
  body = body.replace(HEADING, '');
  const ordered = body.match(ORDERED);
  if (ordered !== null)
    body = `${ordered[1]}. ${body.slice(ordered[0].length)}`;
  else if (BULLET.test(body)) body = `• ${body.replace(BULLET, '')}`;
  body = bold(body);
  if (body === '') return '';
  return `${' '.repeat(Math.min(indent, 2))}${body}`;
}

export function toWhatsAppText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(formatLine)
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

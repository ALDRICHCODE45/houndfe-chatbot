import type { MetaMediaProfile } from '../../receipt-media/infrastructure/meta-media.client';
import type { MirrorMediaContractType } from '../domain/mirror-media';

/**
 * The conversation mirror's media rules: the backend's contract set (jpeg,
 * png, webp, pdf and audio ogg / mpeg / mp4 (m4a) / aac / amr), decided by the
 * bytes like the backend does. Used ONLY by the mirror (injected as a profile);
 * the receipt and product-image paths keep their narrower allowlist.
 */

const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
]);

/** Spellings Meta / clients use for the same storable type. */
const ALIASES: Readonly<Record<string, string>> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'image/jpg': 'image/jpeg',
};

/** Parameters stripped (`audio/ogg; codecs=opus`), lowercased, aliases
 *  resolved; `undefined` when the backend would not store it. */
export function canonicalMirrorMime(raw: string): string | undefined {
  const base = raw.split(';')[0].trim().toLowerCase();
  const mime = ALIASES[base] ?? base;
  return ALLOWED.has(mime) ? mime : undefined;
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** Magic-byte sniffing of the contract set; anything else is `undefined`
 *  (video mp4, gif, svg, html, archives, riff that is not webp, …). */
export function sniffMirrorMedia(bytes: Buffer): string | undefined {
  if (bytes.length < 2) return undefined;
  const ascii = (start: number, end: number): string =>
    bytes.toString('latin1', start, end);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    return 'image/webp';
  if (bytes.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 6 && ascii(0, 5) === '#!AMR') return 'audio/amr';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return brand === 'M4A ' || brand === 'M4B ' ? 'audio/mp4' : undefined;
  }
  if (bytes.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // ADTS (aac) has layer bits 00; an MPEG audio frame has layer 01..11.
    if ((bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
    const layer = (bytes[1] >> 1) & 0x03;
    const version = (bytes[1] >> 3) & 0x03;
    if (layer !== 0 && version !== 1) return 'audio/mpeg';
  }
  return undefined;
}

/** The backend answers `422 MEDIA_TYPE_MISMATCH` when the file kind does not
 *  fit the message type: IMAGE/STICKER an image, DOCUMENT a PDF, AUDIO audio. */
export function mirrorMimeFitsType(
  mimeType: string,
  type: MirrorMediaContractType,
): boolean {
  switch (type) {
    case 'IMAGE':
    case 'STICKER':
      return mimeType.startsWith('image/');
    case 'DOCUMENT':
      return mimeType === 'application/pdf';
    case 'AUDIO':
      return mimeType.startsWith('audio/');
  }
}

export const MIRROR_MEDIA_PROFILE: MetaMediaProfile = {
  canonicalMime: canonicalMirrorMime,
  sniff: sniffMirrorMedia,
  // The backend sniffs and stores; we only relay, so no deep structure check.
  strictContentType: false,
};

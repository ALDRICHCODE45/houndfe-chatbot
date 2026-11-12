import {
  MIRROR_MEDIA_PROFILE,
  canonicalMirrorMime,
  mirrorMimeFitsType,
  sniffMirrorMedia,
} from './mirror-media-profile';

const bytes = (...parts: Array<string | number[]>): Buffer =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === 'string'
        ? Buffer.from(part, 'latin1')
        : Buffer.from(part),
    ),
  );
const pad = (buffer: Buffer): Buffer =>
  Buffer.concat([buffer, Buffer.alloc(32)]);

describe('canonicalMirrorMime', () => {
  it.each([
    ['image/jpeg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/webp'],
    ['application/pdf', 'application/pdf'],
    ['audio/ogg', 'audio/ogg'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['AUDIO/OGG;codecs=opus', 'audio/ogg'],
    ['audio/mpeg', 'audio/mpeg'],
    ['audio/mp4', 'audio/mp4'],
    ['audio/aac', 'audio/aac'],
    ['audio/amr', 'audio/amr'],
    ['audio/mp3', 'audio/mpeg'],
    ['audio/x-m4a', 'audio/mp4'],
    ['audio/m4a', 'audio/mp4'],
    ['audio/x-aac', 'audio/aac'],
    ['image/jpg', 'image/jpeg'],
  ])('%s -> %s', (raw, expected) => {
    expect(canonicalMirrorMime(raw)).toBe(expected);
  });

  it.each([
    'video/mp4',
    'video/3gpp',
    'image/gif',
    'image/svg+xml',
    'text/html',
    'application/zip',
    'application/octet-stream',
    'audio/wav',
    '',
    '   ',
  ])('refuses %j', (raw) => {
    expect(canonicalMirrorMime(raw)).toBeUndefined();
  });
});

describe('sniffMirrorMedia', () => {
  it.each([
    ['jpeg', pad(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg'],
    [
      'png',
      pad(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      'image/png',
    ],
    ['webp', pad(bytes('RIFF', [0x1a, 0, 0, 0], 'WEBPVP8 ')), 'image/webp'],
    ['pdf', pad(bytes('%PDF-1.7\n')), 'application/pdf'],
    ['ogg', pad(bytes('OggS', [0, 2])), 'audio/ogg'],
    ['mp3 with id3', pad(bytes('ID3', [3, 0, 0])), 'audio/mpeg'],
    ['mp3 frame sync', pad(bytes([0xff, 0xfb, 0x90, 0x00])), 'audio/mpeg'],
    ['aac adts', pad(bytes([0xff, 0xf1, 0x50, 0x80])), 'audio/aac'],
    ['aac adts mpeg2', pad(bytes([0xff, 0xf9, 0x50, 0x80])), 'audio/aac'],
    ['m4a', pad(bytes([0, 0, 0, 0x20], 'ftypM4A ', [0, 0, 0, 0])), 'audio/mp4'],
    ['amr', pad(bytes('#!AMR\n')), 'audio/amr'],
    ['amr-wb', pad(bytes('#!AMR-WB\n')), 'audio/amr'],
  ])('%s', (_name, buffer, expected) => {
    expect(sniffMirrorMedia(buffer)).toBe(expected);
  });

  it.each([
    ['mp4 video', pad(bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0]))],
    ['3gp video', pad(bytes([0, 0, 0, 0x14], 'ftyp3gp4', [0, 0, 0, 0]))],
    ['gif', pad(bytes('GIF89a'))],
    [
      'wav (riff but not webp)',
      pad(bytes('RIFF', [0x1a, 0, 0, 0], 'WAVEfmt ')),
    ],
    ['html', pad(bytes('<!doctype html><html>'))],
    ['zip', pad(bytes('PK', [3, 4]))],
    ['empty', Buffer.alloc(0)],
    ['one byte', bytes([0xff])],
  ])('does not accept %s', (_name, buffer) => {
    expect(sniffMirrorMedia(buffer)).toBeUndefined();
  });
});

describe('mirrorMimeFitsType', () => {
  it.each([
    ['image/jpeg', 'IMAGE', true],
    ['image/webp', 'IMAGE', true],
    ['image/webp', 'STICKER', true],
    ['image/png', 'STICKER', true],
    ['application/pdf', 'DOCUMENT', true],
    ['audio/ogg', 'AUDIO', true],
    ['audio/mp4', 'AUDIO', true],
    ['application/pdf', 'IMAGE', false],
    ['application/pdf', 'AUDIO', false],
    ['audio/ogg', 'IMAGE', false],
    ['audio/ogg', 'DOCUMENT', false],
    ['image/jpeg', 'DOCUMENT', false],
    ['image/jpeg', 'AUDIO', false],
  ] as const)('%s as %s -> %s', (mime, type, fits) => {
    expect(mirrorMimeFitsType(mime, type)).toBe(fits);
  });
});

describe('MIRROR_MEDIA_PROFILE', () => {
  it('is the wider profile: parameters ok, bytes decide, no strict header, no structure check', () => {
    expect(MIRROR_MEDIA_PROFILE.canonicalMime('audio/ogg; codecs=opus')).toBe(
      'audio/ogg',
    );
    expect(MIRROR_MEDIA_PROFILE.sniff(pad(bytes('OggS')))).toBe('audio/ogg');
    expect(MIRROR_MEDIA_PROFILE.strictContentType).toBe(false);
    expect(MIRROR_MEDIA_PROFILE.validate).toBeUndefined();
  });
});

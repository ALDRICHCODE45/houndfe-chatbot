import {
  MetaMediaError,
  type MetaMediaPort,
  META_MEDIA,
} from '../domain/meta-media.port';
import { validateMediaStructure } from './media-structure.validator';
import { deflateSync, inflateSync } from 'zlib';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, 'ascii');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  name.copy(head, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([head, data, tail]);
}

function ihdr(width = 1, height = 1): Buffer {
  const data = Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 2, 0, 0, 0]);
  return pngChunk('IHDR', data);
}

const scanlines = Buffer.from([0, 0xff, 0, 0]);
const compressed = deflateSync(scanlines);
const idat = (data = compressed): Buffer => pngChunk('IDAT', data);
const png = (...chunks: Buffer[]): Buffer =>
  Buffer.concat([PNG_SIGNATURE, ...chunks]);

const segment = (marker: number, payload: number[]): Buffer => {
  const length = payload.length + 2;
  return Buffer.from([0xff, marker, length >>> 8, length & 0xff, ...payload]);
};
const SOF = segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
const SOS = segment(0xda, [1, 1, 0, 0, 63, 0]);
const DQT = segment(0xdb, [0, ...new Array<number>(64).fill(16)]);
const huffman = (table: number): Buffer =>
  segment(0xc4, [table, 1, ...new Array<number>(15).fill(0), 0]);
const tables = [DQT, huffman(0), huffman(0x10)];
const jpeg = (...parts: Array<Buffer | number[]>): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))),
    Buffer.from([0xff, 0xd9]),
  ]);
const positive = (entropy: number[]) => jpeg(...tables, SOF, SOS, entropy);

const expectInvalid = (
  bytes: Buffer,
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif',
  code: string,
) =>
  expect(() => validateMediaStructure(bytes, mimeType)).toThrow(
    expect.objectContaining({
      category: 'MEDIA_VALIDATION',
      code,
      message: `receipt-media:MEDIA_VALIDATION/${code}`,
    }) as Error,
  );

describe('provider-id-only Meta media contract', () => {
  it('exposes a stable token and an input with no URL field', async () => {
    const input = {
      providerMediaId: 'provider-id',
      declaredMimeType: 'image/png' as const,
      signal: new AbortController().signal,
    };
    const adapter: MetaMediaPort = {
      resolveAndDownload: (request) =>
        Promise.resolve({
          filePath: '/opaque/temp',
          mimeType: request.declaredMimeType,
          byteCount: 4,
          sha256: Buffer.alloc(32),
        }),
    };

    const result = await adapter.resolveAndDownload(input);
    expect(result.mimeType).toBe('image/png');
    expect(META_MEDIA.description).toBe('META_MEDIA');
    expect(Object.keys(input).sort()).toEqual([
      'declaredMimeType',
      'providerMediaId',
      'signal',
    ]);
  });

  it('formats fixed category/code errors with no detail field', () => {
    const error = new MetaMediaError('META_TRANSPORT', 'NETWORK_FAILURE');
    expect(String(error)).toBe(
      'Error: receipt-media:META_TRANSPORT/NETWORK_FAILURE',
    );
    expect(Object.keys(error).sort()).toEqual(['category', 'code']);
  });
});

describe('PNG structural validation', () => {
  const valid = png(ihdr(), idat(), pngChunk('IEND'));

  const badSignature = Buffer.from(valid);
  badSignature[0] = 0;
  const ancillary = pngChunk('tEXt');

  it('uses a standalone-valid positive fixture with a real zlib IDAT stream', () => {
    expect(inflateSync(idat().subarray(8, -4))).toEqual(scanlines);
  });

  it('accepts a signature, first IHDR, bounded chunks, and final IEND', () => {
    expect(validateMediaStructure(valid, 'image/png')).toBe('image/png');
  });

  it('accepts one zlib stream split across multiple IDAT chunks', () => {
    const middle = Math.ceil(compressed.length / 2);
    const split = [compressed.subarray(0, middle), compressed.subarray(middle)];
    const bytes = png(ihdr(), ancillary, ...split.map(idat), pngChunk('IEND'));
    expect(validateMediaStructure(bytes, 'image/png')).toBe('image/png');
  });

  it.each([
    ['bad signature', badSignature],
    ['IHDR absent', png(pngChunk('IDAT'), pngChunk('IEND'))],
    ['IHDR not first', png(pngChunk('IDAT'), ihdr(), pngChunk('IEND'))],
    [
      'IHDR wrong size',
      png(pngChunk('IHDR', Buffer.alloc(12)), pngChunk('IEND')),
    ],
    ['missing IDAT', png(ihdr(), pngChunk('IEND'))],
    ['zero width', png(ihdr(0, 1), pngChunk('IEND'))],
    ['zero height', png(ihdr(1, 0), pngChunk('IEND'))],
    ['missing IEND', png(ihdr(), pngChunk('IDAT'))],
    ['IEND payload', png(ihdr(), pngChunk('IEND', Buffer.from([0])))],
    ['trailing bytes', Buffer.concat([valid, Buffer.from([0])])],
    ['IDAT gap', png(ihdr(), idat(), ancillary, idat(), pngChunk('IEND'))],
  ])('rejects %s', (_name, bytes) => {
    expectInvalid(bytes, 'image/png', 'PNG_STRUCTURE_INVALID');
  });

  it.each(['IHDR', 'IDAT', 'IEND'])('rejects a bad %s CRC', (type) => {
    const chunks = [ihdr(), pngChunk('IDAT'), pngChunk('IEND')];
    const index = ['IHDR', 'IDAT', 'IEND'].indexOf(type);
    chunks[index] = Buffer.from(chunks[index]);
    chunks[index][chunks[index].length - 1] ^= 1;
    expectInvalid(png(...chunks), 'image/png', 'PNG_STRUCTURE_INVALID');
  });

  it('rejects a chunk whose declared length exceeds the available bytes', () => {
    const truncated = Buffer.from(pngChunk('IDAT'));
    truncated.writeUInt32BE(64, 0);
    expectInvalid(png(ihdr(), truncated), 'image/png', 'PNG_STRUCTURE_INVALID');
  });
});

describe('JPEG structural validation', () => {
  it('uses a standalone-valid grayscale fixture with both Huffman tables', () => {
    const bytes = positive([0x3f]);
    expect(tables.map((table) => table.subarray(0, 2).toString('hex'))).toEqual(
      ['ffdb', 'ffc4', 'ffc4'],
    );
    expect(validateMediaStructure(bytes, 'image/jpeg')).toBe('image/jpeg');
  });

  it.each([
    ['ordinary entropy', positive([0x3f])],
    ['stuffed entropy byte', positive([0x3f, 0xff, 0, 0x3f])],
    ['restart markers', positive([0x3f, 0xff, 0xd0, 0x3f, 0xff, 0xd7, 0x3f])],
  ])('accepts valid %s', (_name, bytes) => {
    expect(validateMediaStructure(bytes, 'image/jpeg')).toBe('image/jpeg');
  });

  it.each([
    ['missing SOI', Buffer.from([0xff, 0xd9])],
    ['missing SOF', jpeg(SOS, [1])],
    ['missing SOS', jpeg(SOF)],
    ['SOF after SOS', jpeg(DQT, SOS, SOF)],
    ['SOF after SOS with entropy data', jpeg(DQT, SOS, SOF, [1])],
    ['duplicate SOF', jpeg(...tables, SOF, SOF, SOS, [1])],
    ['SOS without entropy data', jpeg(...tables, SOF, SOS)],
    ['restart-only entropy', jpeg(...tables, SOF, SOS, [0xff, 0xd0])],
    ['second scan without entropy data', jpeg(...tables, SOF, SOS, [1], SOS)],
    ['empty earlier scan', jpeg(...tables, SOF, SOS, SOS, [1])],
    ['segment length below two', jpeg(Buffer.from([0xff, 0xe0, 0, 1]))],
    ['segment outside bounds', jpeg(Buffer.from([0xff, 0xe0, 0, 20, 1]))],
    [
      'malformed SOF dimensions',
      jpeg(segment(0xc0, [8, 0, 0, 0, 1, 1, 1, 0x11, 0]), SOS, [1]),
    ],
    [
      'malformed SOF component length',
      jpeg(segment(0xc0, [8, 0, 1, 0, 1, 2, 1, 0x11, 0]), SOS, [1]),
    ],
    ['malformed SOS length', jpeg(SOF, segment(0xda, [1, 1, 0]))],
    ['restart before entropy', jpeg([0xff, 0xd0], SOF, SOS, [1])],
    ['unescaped entropy marker', jpeg(SOF, SOS, [1, 0xff, 0x02, 0, 2])],
    [
      'dangling entropy escape',
      Buffer.from([...jpeg(SOF, SOS, [1]).subarray(0, -2), 0xff]),
    ],
    ['missing EOI', jpeg(SOF, SOS, [1]).subarray(0, -2)],
    ['trailing bytes', Buffer.concat([jpeg(SOF, SOS, [1]), Buffer.from([0])])],
  ])('rejects %s', (_name, bytes) => {
    expectInvalid(bytes, 'image/jpeg', 'JPEG_STRUCTURE_INVALID');
  });

  it('rejects unsupported MIME with a fixed safe error', () => {
    expectInvalid(Buffer.from('unsafe'), 'image/gif', 'UNSUPPORTED_MIME');
  });
});

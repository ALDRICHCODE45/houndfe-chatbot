import { MetaMediaError } from '../domain/meta-media.port';
import type { ReceiptMimeType } from '../domain/meta-media.port';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(bytes: Buffer): void {
  const bad = (): never => {
    throw new MetaMediaError('MEDIA_VALIDATION', 'PNG_STRUCTURE_INVALID');
  };
  if (bytes.length < 20 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) bad();
  let offset = 8;
  let idat = false;
  let idatClosed = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) bad();
    const length = bytes.readUInt32BE(offset);
    const data = offset + 8;
    if (length > bytes.length - data - 4) bad();
    const end = data + length;
    const type = bytes.toString('ascii', offset + 4, data);
    if (bytes.readUInt32BE(end) !== crc32(bytes, offset + 4, end)) bad();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) bad();
      if (bytes.readUInt32BE(data) === 0 || bytes.readUInt32BE(data + 4) === 0)
        bad();
    } else if (offset === 8) bad();
    if (type === 'IDAT') {
      if (idatClosed) bad();
      idat = true;
    } else if (idat) idatClosed = true;
    offset = end + 4;
    if (type === 'IEND') {
      if (length !== 0 || !idat || offset !== bytes.length) bad();
      return;
    }
  }
  bad();
}

const validFrame = (b: Buffer, s: number, n: number): boolean =>
  n >= 8 &&
  b[s + 7] > 0 &&
  n === 8 + b[s + 7] * 3 &&
  b.readUInt16BE(s + 3) > 0 &&
  b.readUInt16BE(s + 5) > 0;

const validScan = (b: Buffer, s: number, n: number): boolean =>
  n >= 3 && b[s + 2] > 0 && n === 6 + b[s + 2] * 2;

function validateJpeg(bytes: Buffer): void {
  const bad = (): never => {
    throw new MetaMediaError('MEDIA_VALIDATION', 'JPEG_STRUCTURE_INVALID');
  };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) bad();
  let offset = 2;
  const state = { frame: false, scan: false, entropy: false, data: false };
  while (offset < bytes.length) {
    if (state.entropy) {
      const start = offset;
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset > start) state.data = true;
      if (offset >= bytes.length) bad();
    }
    if (bytes[offset] !== 0xff) bad();
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) bad();
    const marker = bytes[offset++];
    if (state.entropy && marker === 0x00) {
      state.data = true;
      continue;
    }
    if (state.entropy && marker >= 0xd0 && marker <= 0xd7) continue;
    if (state.entropy && !state.data) bad();
    state.entropy = false;
    if (marker === 0xd9) {
      if (!state.frame || !state.scan || !state.data || offset !== bytes.length)
        bad();
      return;
    }
    if (marker < 0xc0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7))
      bad();
    if (bytes.length - offset < 2) bad();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) bad();
    if (SOF.has(marker)) {
      if (state.frame || state.scan) bad();
      if (!validFrame(bytes, offset, length)) bad();
      state.frame = true;
    }
    if (marker === 0xda) {
      if (!state.frame) bad();
      if (!validScan(bytes, offset, length)) bad();
      state.scan = state.entropy = true;
      state.data = false;
    }
    offset += length;
  }
  bad();
}

export function validateMediaStructure(
  bytes: Buffer,
  mimeType: string,
): ReceiptMimeType {
  if (mimeType === 'image/png') validatePng(bytes);
  else if (mimeType === 'image/jpeg') validateJpeg(bytes);
  else throw new MetaMediaError('MEDIA_VALIDATION', 'UNSUPPORTED_MIME');
  return mimeType;
}

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

/** `filename` is cosmetic and must be safe inside a quoted header value. */
export function safeUploadFilename(filename: string | undefined): string {
  const cleaned = (filename ?? '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .slice(0, 100)
    .trim();
  return cleaned === '' ? 'media' : cleaned;
}

/**
 * Meta `POST /{phone-number-id}/media` body, streamed lazily: the
 * `messaging_product` and `type` fields, then exactly one `file` part. Memory
 * stays bounded to one chunk of the source, and the declared length is exact
 * (the body errors if the file changes size while it is read).
 */
export function createMetaMediaMultipart(options: {
  source: Readable;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): { body: Readable; contentType: string; contentLength: number } {
  const boundary = `houndfe-${randomBytes(16).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${options.mimeType}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename}"\r\nContent-Type: ${options.mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const { source, sizeBytes } = options;

  async function* generate(): AsyncGenerator<Buffer> {
    yield head;
    let total = 0;
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array | string);
        total += buffer.length;
        if (total > sizeBytes)
          throw new Error('Media file grew while it was being uploaded');
        yield buffer;
      }
    } finally {
      source.destroy();
    }
    if (total !== sizeBytes)
      throw new Error('Media file length differs from the declared size');
    yield tail;
  }

  return {
    body: Readable.from(generate(), { objectMode: false }),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: head.length + sizeBytes + tail.length,
  };
}

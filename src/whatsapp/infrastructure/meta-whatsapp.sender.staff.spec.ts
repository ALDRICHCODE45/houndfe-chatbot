import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { from, of, throwError } from 'rxjs';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { InMemoryBackendOutboxStore } from '../../backend-outbox/infrastructure/in-memory-backend-outbox.store';
import { TranscriptRecorder } from '../../conversation-transcript/application/transcript-recorder';
import { InMemoryTranscriptStore } from '../../conversation-transcript/infrastructure/in-memory-transcript.store';
import { UnsupportedOutboundError } from '../domain/whatsapp-sender.port';
import { MetaWhatsappSender, WhatsappSendError } from './meta-whatsapp.sender';

/**
 * Live conversation (unit 11) S3/S4/S7: staff and template sends are never
 * mirrored, media goes up from disk as a stream and is sent by media id.
 */
const TO = '5215550001111';
const BASE = 'https://graph.facebook.com/v23.0';
// A real, read-only file of the repo: the upload streams it from disk.
const FILE = __filename;

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

type PostArgs = [url: string, body: unknown, config?: Record<string, unknown>];

describe('MetaWhatsappSender staff / template / media (unit 11)', () => {
  let post: jest.SpiedFunction<HttpService['post']>;
  let store: InMemoryTranscriptStore;
  let outbox: InMemoryBackendOutboxStore;
  let sender: MetaWhatsappSender;
  const uploadedBodies: Buffer[] = [];

  const calls = () => post.mock.calls as unknown as PostArgs[];
  const mirrorKeys = () =>
    outbox.snapshot().map((entry) => entry.idempotencyKey);
  const stored = () => store.listRecent(TO, 50);

  /** Meta accepts the message with this wamid. */
  const accept = (id: string) =>
    post.mockReturnValueOnce(of(axiosResponse({ messages: [{ id }] })));

  /** Meta accepts one media upload; the streamed body is drained here. */
  const acceptUpload = (mediaId: string) =>
    post.mockImplementationOnce(((_url: string, body: unknown) =>
      from(
        new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          (body as Readable)
            .on('data', (chunk: Buffer) => chunks.push(chunk))
            .on('end', () => resolve(Buffer.concat(chunks)))
            .on('error', reject);
        }).then((buffer) => {
          uploadedBodies.push(buffer);
          return axiosResponse({ id: mediaId });
        }),
      )) as never);

  beforeEach(() => {
    uploadedBodies.length = 0;
    const http = new HttpService();
    post = jest
      .spyOn(http, 'post')
      .mockImplementation(() =>
        throwError(() => new Error('unexpected network request')),
      );
    store = new InMemoryTranscriptStore();
    outbox = new InMemoryBackendOutboxStore();
    const recorder = new TranscriptRecorder(
      store,
      () => new Date('2026-11-12T10:00:00.000Z'),
      new BackendOutboxService(outbox),
    );
    const config = new ConfigService({
      meta: {
        accessToken: 'meta-token',
        phoneNumberId: '1',
        graphApiBaseUrl: BASE,
        sandboxRecipientNormalizationEnabled: false,
      },
    });
    sender = new MetaWhatsappSender(http, config, recorder);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('mirror (S4)', () => {
    it('default sends keep mirroring as BOT (text, image, template)', async () => {
      accept('wamid.t');
      accept('wamid.i');
      accept('wamid.p');
      await sender.sendText({ to: TO, text: 'hola' });
      await sender.sendImage({ to: TO, link: 'https://cdn.example.com/a.jpg' });
      await sender.sendTemplate({
        to: TO,
        templateName: 'order_ready',
        languageCode: 'es_MX',
        bodyParameters: [],
      });
      expect(mirrorKeys()).toEqual([
        'mirror:wamid.t',
        'mirror:wamid.i',
        'mirror:wamid.p',
      ]);
      expect((await stored()).map((row) => row.author)).toEqual([
        'BOT',
        'BOT',
        'BOT',
      ]);
    });

    it('a STAFF text is sent verbatim, returns the wamid, is kept locally as STAFF and never mirrored', async () => {
      accept('wamid.staff');
      const result = await sender.sendText({
        to: TO,
        text: 'Hola, soy Ana',
        origin: 'STAFF',
      });
      expect(result).toEqual({ providerMessageId: 'wamid.staff' });
      expect(calls()[0][1]).toMatchObject({
        type: 'text',
        text: { body: 'Hola, soy Ana' },
      });
      expect(JSON.stringify(calls()[0][1])).not.toContain('origin');
      expect(mirrorKeys()).toEqual([]);
      expect(await stored()).toMatchObject([
        {
          waMessageId: 'wamid.staff',
          author: 'STAFF',
          direction: 'OUT',
          text: 'Hola, soy Ana',
          details: { origin: 'STAFF' },
        },
      ]);
    });

    it('a TEMPLATE without variables carries no components, is kept locally with its origin and never mirrored', async () => {
      accept('wamid.tpl');
      const result = await sender.sendTemplate({
        to: TO,
        templateName: 'seguimiento',
        languageCode: 'es_MX',
        bodyParameters: [],
        origin: 'TEMPLATE',
      });
      expect(result).toEqual({ providerMessageId: 'wamid.tpl' });
      const template = (calls()[0][1] as { template: Record<string, unknown> })
        .template;
      expect(template).toEqual({
        name: 'seguimiento',
        language: { code: 'es_MX' },
      });
      expect(mirrorKeys()).toEqual([]);
      expect(await stored()).toMatchObject([
        {
          waMessageId: 'wamid.tpl',
          type: 'template',
          details: { origin: 'TEMPLATE', templateName: 'seguimiento' },
        },
      ]);
    });

    it('a STAFF image by link is not mirrored either', async () => {
      accept('wamid.img');
      await sender.sendImage({
        to: TO,
        link: 'https://cdn.example.com/a.jpg',
        origin: 'STAFF',
      });
      expect(mirrorKeys()).toEqual([]);
      expect((await stored())[0].author).toBe('STAFF');
    });

    it('an unknown origin is rejected before reaching Meta', async () => {
      await expect(
        sender.sendText({ to: TO, text: 'x', origin: 'OTHER' as never }),
      ).rejects.toThrow(UnsupportedOutboundError);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('media from a local file (S3)', () => {
    it('uploads the file as a stream, then sends the image by the returned media id', async () => {
      acceptUpload('media-77');
      accept('wamid.photo');
      const result = await sender.sendMediaFile({
        to: TO,
        filePath: FILE,
        mimeType: 'image/jpeg',
        caption: 'Su pedido',
        origin: 'STAFF',
      });

      expect(result).toEqual({
        providerMessageId: 'wamid.photo',
        providerMediaId: 'media-77',
      });
      const [upload, message] = calls();
      expect(upload[0]).toBe(`${BASE}/1/media`);
      // Streamed from disk, never a Buffer / string.
      expect(upload[1]).toBeInstanceOf(Readable);
      expect(Buffer.isBuffer(upload[1])).toBe(false);
      const config = upload[2] as {
        headers: Record<string, string | number>;
        timeout: number;
        maxRedirects: number;
      };
      expect(config.headers.Authorization).toBe('Bearer meta-token');
      expect(config.headers['Content-Type']).toMatch(
        /^multipart\/form-data; boundary=.+/,
      );
      expect(config.timeout).toBeGreaterThan(0);
      // Native transport: follow-redirects would buffer the streamed body.
      expect(config.maxRedirects).toBe(0);

      const body = uploadedBodies[0].toString('latin1');
      expect(body).toContain('name="messaging_product"\r\n\r\nwhatsapp');
      expect(body).toContain('name="type"\r\n\r\nimage/jpeg');
      expect(body).toMatch(
        /name="file"; filename="[^"]+"\r\nContent-Type: image\/jpeg\r\n\r\n/,
      );
      // The whole file is in the body and the declared length is exact.
      const fileBytes = await import('node:fs').then((fs) =>
        fs.readFileSync(FILE),
      );
      expect(uploadedBodies[0].includes(fileBytes)).toBe(true);
      expect(config.headers['Content-Length']).toBe(uploadedBodies[0].length);
      expect(createHash('sha256').update(fileBytes).digest('hex')).toHaveLength(
        64,
      );

      expect(message[0]).toBe(`${BASE}/1/messages`);
      expect(message[1]).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: TO,
        type: 'image',
        image: { id: 'media-77', caption: 'Su pedido' },
      });
      expect(mirrorKeys()).toEqual([]);
      expect(await stored()).toMatchObject([
        {
          waMessageId: 'wamid.photo',
          author: 'STAFF',
          type: 'image',
          text: 'Su pedido',
          media: { providerMediaId: 'media-77', mimeType: 'image/jpeg' },
        },
      ]);
    });

    it('sends a PDF as a document with its filename and caption', async () => {
      acceptUpload('media-pdf');
      accept('wamid.doc');
      const result = await sender.sendMediaFile({
        to: TO,
        filePath: FILE,
        mimeType: 'application/pdf',
        filename: 'cotizacion.pdf',
        caption: 'Cotización',
        origin: 'STAFF',
      });
      expect(result.providerMessageId).toBe('wamid.doc');
      expect(calls()[1][1]).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: TO,
        type: 'document',
        document: {
          id: 'media-pdf',
          filename: 'cotizacion.pdf',
          caption: 'Cotización',
        },
      });
      expect(mirrorKeys()).toEqual([]);
      expect(await stored()).toMatchObject([
        {
          type: 'document',
          author: 'STAFF',
          text: 'Cotización',
          media: {
            providerMediaId: 'media-pdf',
            mimeType: 'application/pdf',
            filename: 'cotizacion.pdf',
          },
        },
      ]);
    });

    it('omits an absent caption', async () => {
      acceptUpload('media-1');
      accept('wamid.doc2');
      await sender.sendMediaFile({
        to: TO,
        filePath: FILE,
        mimeType: 'application/pdf',
        filename: 'a.pdf',
      });
      expect(
        (calls()[1][1] as { document: Record<string, unknown> }).document,
      ).toEqual({ id: 'media-1', filename: 'a.pdf' });
    });

    it('a default-origin media send mirrors as BOT', async () => {
      acceptUpload('media-1');
      accept('wamid.bot-media');
      await sender.sendMediaFile({
        to: TO,
        filePath: FILE,
        mimeType: 'image/png',
      });
      expect(mirrorKeys()).toEqual(['mirror:wamid.bot-media']);
    });

    it.each(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])(
      'accepts %s',
      async (mimeType) => {
        acceptUpload('m');
        accept('wamid.ok');
        await expect(
          sender.sendMediaFile({
            to: TO,
            filePath: FILE,
            mimeType,
            filename: 'f',
          }),
        ).resolves.toMatchObject({ providerMessageId: 'wamid.ok' });
      },
    );

    it.each([
      ['an unsupported mime type', { mimeType: 'video/mp4' }],
      ['an empty recipient', { to: '' }],
      ['a missing file', { filePath: '/nonexistent/houndfe-file.pdf' }],
      ['a directory', { filePath: __dirname }],
    ])('rejects %s before any request', async (_label, override) => {
      await expect(
        sender.sendMediaFile({
          to: TO,
          filePath: FILE,
          mimeType: 'application/pdf',
          filename: 'f.pdf',
          ...override,
        }),
      ).rejects.toThrow(UnsupportedOutboundError);
      expect(post).not.toHaveBeenCalled();
    });

    it('maps a failed upload to the sendText error shape, tagged as upload (nothing reached the customer)', async () => {
      post.mockReturnValueOnce(
        throwError(() => ({
          isAxiosError: true,
          config: { headers: { Authorization: 'Bearer meta-token' } },
          response: {
            status: 400,
            data: { error: { code: 131053, message: 'Media upload error' } },
          },
        })),
      );
      let thrown: unknown;
      try {
        await sender.sendMediaFile({
          to: TO,
          filePath: FILE,
          mimeType: 'image/png',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WhatsappSendError);
      const error = thrown as WhatsappSendError;
      expect(error.status).toBe(400);
      expect(error.graphErrorCode).toBe(131053);
      expect(error.stage).toBe('upload');
      expect(JSON.stringify(error)).not.toContain('meta-token');
      expect(calls()).toHaveLength(1);
      expect(mirrorKeys()).toEqual([]);
    });

    it('an upload transport failure is a WhatsappSendError with a null status', async () => {
      post.mockReturnValueOnce(throwError(() => new Error('socket hang up')));
      await expect(
        sender.sendMediaFile({
          to: TO,
          filePath: FILE,
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({
        name: 'WhatsappSendError',
        status: null,
        graphErrorCode: null,
        stage: 'upload',
      });
    });

    it('a rejected upload does not leak the open file stream (no media id → no send)', async () => {
      post.mockReturnValueOnce(of(axiosResponse({})));
      await expect(
        sender.sendMediaFile({
          to: TO,
          filePath: FILE,
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ name: 'WhatsappSendError', stage: 'upload' });
      expect(calls()).toHaveLength(1);
    });

    it('window closed (131047) on the send maps like sendText and stays a send-stage error', async () => {
      acceptUpload('media-9');
      post.mockReturnValueOnce(
        throwError(() => ({
          isAxiosError: true,
          response: {
            status: 400,
            data: {
              error: { code: 131047, message: 'Re-engagement message' },
            },
          },
        })),
      );
      let thrown: unknown;
      try {
        await sender.sendMediaFile({
          to: TO,
          filePath: FILE,
          mimeType: 'image/jpeg',
          origin: 'STAFF',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WhatsappSendError);
      expect((thrown as WhatsappSendError).graphErrorCode).toBe(131047);
      expect((thrown as WhatsappSendError).status).toBe(400);
      expect((thrown as WhatsappSendError).stage).toBe('send');
      expect(mirrorKeys()).toEqual([]);
      expect(await stored()).toEqual([]);
    });

    it('a transport failure on the send is uncertain: null status, send stage', async () => {
      acceptUpload('media-9');
      post.mockReturnValueOnce(throwError(() => new Error('ETIMEDOUT')));
      await expect(
        sender.sendMediaFile({
          to: TO,
          filePath: FILE,
          mimeType: 'application/pdf',
          filename: 'a.pdf',
        }),
      ).rejects.toMatchObject({
        status: null,
        graphErrorCode: null,
        stage: 'send',
      });
    });

    it('sendText errors keep the send stage (parity)', async () => {
      post.mockReturnValueOnce(throwError(() => new Error('ETIMEDOUT')));
      await expect(
        sender.sendText({ to: TO, text: 'hola', origin: 'STAFF' }),
      ).rejects.toMatchObject({ status: null, stage: 'send' });
    });
  });

  describe('send by media id / document', () => {
    it('sendImage accepts a media id instead of a link', async () => {
      accept('wamid.byid');
      await sender.sendImage({ to: TO, mediaId: 'media-5', caption: 'c' });
      expect((calls()[0][1] as { image: unknown }).image).toEqual({
        id: 'media-5',
        caption: 'c',
      });
    });

    it('sendImage rejects both or neither of link and media id', async () => {
      await expect(
        sender.sendImage({
          to: TO,
          link: 'https://cdn.example.com/a.jpg',
          mediaId: 'm',
        }),
      ).rejects.toThrow(UnsupportedOutboundError);
      await expect(sender.sendImage({ to: TO })).rejects.toThrow(
        UnsupportedOutboundError,
      );
      expect(post).not.toHaveBeenCalled();
    });

    it('sendDocument by media id carries filename and caption', async () => {
      accept('wamid.docid');
      const result = await sender.sendDocument({
        to: TO,
        mediaId: 'media-6',
        filename: 'x.pdf',
        caption: 'c',
        origin: 'STAFF',
      });
      expect(result).toEqual({ providerMessageId: 'wamid.docid' });
      expect(calls()[0][1]).toMatchObject({
        type: 'document',
        document: { id: 'media-6', filename: 'x.pdf', caption: 'c' },
      });
      expect(mirrorKeys()).toEqual([]);
    });

    it('sendDocument requires a filename', async () => {
      await expect(
        sender.sendDocument({ to: TO, mediaId: 'm', filename: '' }),
      ).rejects.toThrow(UnsupportedOutboundError);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('logs (S7)', () => {
    it('a transcript failure on a staff media send logs no phone and no raw wamid', async () => {
      const http = new HttpService();
      jest.spyOn(http, 'post').mockReturnValueOnce(
        of(
          axiosResponse({
            messages: [{ id: 'wamid.HBgMNTIxNTU1MDAwMTExMQ' }],
          }),
        ),
      );
      const failing = new MetaWhatsappSender(
        http,
        new ConfigService({
          meta: {
            accessToken: 't',
            phoneNumberId: '1',
            graphApiBaseUrl: BASE,
          },
        }),
        {
          recordOutbound: () =>
            Promise.reject(
              new Error(`boom for ${TO} wamid.HBgMNTIxNTU1MDAwMTExMQ`),
            ),
        },
      );
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await failing.sendText({ to: TO, text: 'hola', origin: 'STAFF' });
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(warn).toHaveBeenCalled();
      expect(logged).not.toContain(TO);
      expect(logged).not.toContain('HBgM');
    });
  });
});

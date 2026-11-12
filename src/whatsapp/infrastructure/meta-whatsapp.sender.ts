import { createReadStream, promises as fsPromises } from 'node:fs';
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import {
  OUTBOUND_TRANSCRIPT_RECORDER,
  type OutboundTranscriptEntry,
  type OutboundTranscriptRecorder,
} from '../../conversation-transcript/application/transcript-recorder';
import {
  fitInteractiveText,
  INTERACTIVE_LIMITS,
} from '../../llm-agent/domain/customer-reply';
import {
  InteractiveSendResult,
  InvalidOutboundTemplateError,
  MediaSendResult,
  OUTBOUND_MEDIA_MIME_TYPES,
  OutboundDocument,
  OutboundImage,
  OutboundInteractive,
  OutboundMediaFile,
  OutboundOrigin,
  OutboundTemplate,
  OutboundText,
  SendResult,
  UnsupportedOutboundError,
  WhatsappSenderPort,
} from '../domain/whatsapp-sender.port';
import { describeError, fingerprintMessageId } from '../../common/log-safe';
import {
  createMetaMediaMultipart,
  safeUploadFilename,
} from './media-upload-multipart';

type MetaSendResponse = {
  messages?: Array<{ id: string }>;
};

type MetaMediaUploadResponse = { id?: unknown };

/** Send-time options that never reach Meta. */
interface SendOptions {
  staffReplyId?: string;
  origin?: OutboundOrigin;
  /** Media mime type, recorded with a media-id send. */
  mimeType?: string;
}

const ORIGINS: ReadonlySet<string> = new Set(['BOT', 'STAFF', 'TEMPLATE']);
/** Meta limits: images 5 MB, documents 100 MB. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
/** The upload streams a file between VPSs; message sends keep their defaults. */
const MEDIA_UPLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_DOCUMENT_FILENAME = 'documento.pdf';

type MetaMessagePayload = Record<string, unknown> & { to: string };

const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]+$/;
const TEMPLATE_NAME_MAX_LENGTH = 512;
const TEMPLATE_PARAMETER_MAX_LENGTH = 1024;
// Meta rejects body parameters with newlines, tabs or more than 4 spaces.
const TEMPLATE_PARAMETER_FORBIDDEN = /[\n\r\t]| {5,}/;

type GraphErrorResponse = {
  error?: {
    code?: string | number;
    message?: string;
  };
};

export class WhatsappSendError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly graphErrorCode: string | number | null,
    public readonly graphErrorMessage: string | null,
    /**
     * `upload`: the media upload failed, so nothing reached the customer
     * (a definite failure even with a null status). `send`: the message
     * request itself failed; a null status there is uncertain.
     */
    public readonly stage: 'send' | 'upload' = 'send',
  ) {
    super(graphErrorMessage ?? 'Failed to send WhatsApp message');
    this.name = 'WhatsappSendError';
  }
}

/** S4 body when the reply text alone exceeds the interactive body limit. */
const DEFAULT_SHORT_BODY = 'Elija una opción:';

@Injectable()
export class MetaWhatsappSender implements WhatsappSenderPort {
  private readonly logger = new Logger(MetaWhatsappSender.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    // S1 durable transcript. Optional so hand-built senders keep working.
    @Optional()
    @Inject(OUTBOUND_TRANSCRIPT_RECORDER)
    private readonly transcript?: OutboundTranscriptRecorder,
  ) {}

  async sendText(message: OutboundText): Promise<SendResult> {
    this.assertTextMessage(message);

    return this.send(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: message.to,
        type: 'text',
        text: {
          body: message.text,
        },
      },
      { staffReplyId: message.staffReplyId, origin: message.origin },
    );
  }

  async sendImage(message: OutboundImage): Promise<SendResult> {
    this.assertImageMessage(message);

    return this.send(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: message.to,
        type: 'image',
        image: {
          ...(message.link === undefined
            ? { id: message.mediaId }
            : { link: message.link }),
          ...(message.caption === undefined
            ? {}
            : { caption: message.caption }),
        },
      },
      { origin: message.origin },
    );
  }

  /** Document by link or media id, with the name the customer sees. */
  async sendDocument(message: OutboundDocument): Promise<SendResult> {
    this.assertDocumentMessage(message);

    return this.send(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: message.to,
        type: 'document',
        document: {
          ...(message.link === undefined
            ? { id: message.mediaId }
            : { link: message.link }),
          filename: message.filename,
          ...(message.caption === undefined
            ? {}
            : { caption: message.caption }),
        },
      },
      { origin: message.origin },
    );
  }

  /**
   * Uploads a local file to Meta (`POST /{phone-number-id}/media`, multipart
   * streamed from disk, never buffered) and sends it by the returned media
   * id: `image/*` as an image, `application/pdf` as a document. A failed
   * upload throws `WhatsappSendError` with `stage: 'upload'` (nothing was
   * sent); a failed send keeps `stage: 'send'` like every other send.
   */
  async sendMediaFile(message: OutboundMediaFile): Promise<MediaSendResult> {
    const sizeBytes = await this.assertMediaFile(message);
    const providerMediaId = await this.uploadMedia(message, sizeBytes);
    const { providerMessageId } = await this.send(
      message.mimeType === 'application/pdf'
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: message.to,
            type: 'document',
            document: {
              id: providerMediaId,
              filename: message.filename ?? DEFAULT_DOCUMENT_FILENAME,
              ...(message.caption === undefined
                ? {}
                : { caption: message.caption }),
            },
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: message.to,
            type: 'image',
            image: {
              id: providerMediaId,
              ...(message.caption === undefined
                ? {}
                : { caption: message.caption }),
            },
          },
      { origin: message.origin, mimeType: message.mimeType },
    );
    return { providerMessageId, providerMediaId };
  }

  /**
   * S4 reply buttons or list. Titles are shortened to Meta's limits; a body
   * over 1024 chars goes out first as plain text, then the controls with the
   * short body. Once that text is delivered, a failure of the controls only
   * warns: the text already tells the customer how to answer.
   */
  async sendInteractive(
    message: OutboundInteractive,
  ): Promise<InteractiveSendResult> {
    this.assertInteractiveMessage(message);
    const interactive = buildInteractivePayload(message.interactive);

    if (message.body.length <= INTERACTIVE_LIMITS.body) {
      const { providerMessageId } = await this.send(
        interactiveMessage(message.to, message.body, interactive),
      );
      return { providerMessageId, providerMessageIds: [providerMessageId] };
    }

    const text = await this.sendText({ to: message.to, text: message.body });
    const shortBody = fitInteractiveText(
      message.shortBody ?? DEFAULT_SHORT_BODY,
      INTERACTIVE_LIMITS.body,
    );
    try {
      const { providerMessageId } = await this.send(
        interactiveMessage(
          message.to,
          shortBody === '' ? DEFAULT_SHORT_BODY : shortBody,
          interactive,
        ),
      );
      return {
        providerMessageId,
        providerMessageIds: [text.providerMessageId, providerMessageId],
      };
    } catch (error) {
      this.logger.warn(
        `interactive controls failed after the long text was sent: ${describeError(error)}`,
      );
      return {
        providerMessageId: text.providerMessageId,
        providerMessageIds: [text.providerMessageId],
      };
    }
  }

  async sendTemplate(message: OutboundTemplate): Promise<SendResult> {
    this.assertTemplateMessage(message);

    return this.send(
      {
        messaging_product: 'whatsapp',
        to: message.to,
        type: 'template',
        template: {
          name: message.templateName,
          language: { code: message.languageCode },
          // A template without variables carries no body component.
          ...(message.bodyParameters.length > 0 && {
            components: [
              {
                type: 'body',
                parameters: message.bodyParameters.map((text) => ({
                  type: 'text',
                  text,
                })),
              },
            ],
          }),
        },
      },
      { origin: message.origin },
    );
  }

  private async uploadMedia(
    message: OutboundMediaFile,
    sizeBytes: number,
  ): Promise<string> {
    const source = createReadStream(message.filePath);
    const multipart = createMetaMediaMultipart({
      source,
      filename: safeUploadFilename(message.filename),
      mimeType: message.mimeType,
      sizeBytes,
    });
    let data: MetaMediaUploadResponse;
    try {
      const response = await lastValueFrom(
        this.httpService.post<MetaMediaUploadResponse>(
          this.buildGraphUrl('media'),
          multipart.body,
          {
            headers: {
              Authorization: `Bearer ${this.configService.getOrThrow<AppConfig['meta']['accessToken']>('meta.accessToken')}`,
              'Content-Type': multipart.contentType,
              'Content-Length': multipart.contentLength,
            },
            timeout: MEDIA_UPLOAD_TIMEOUT_MS,
            // Native transport: follow-redirects would buffer the body.
            maxRedirects: 0,
            maxBodyLength: Infinity,
          },
        ),
      );
      data = response.data;
    } catch (error) {
      // The request failed before (or without) consuming the body.
      multipart.body.destroy();
      source.destroy();
      throw this.toWhatsappSendError(error, 'upload');
    }
    if (typeof data?.id !== 'string' || data.id === '') {
      multipart.body.destroy();
      source.destroy();
      throw new WhatsappSendError(
        200,
        null,
        'Meta media upload response did not include a media id',
        'upload',
      );
    }
    return data.id;
  }

  private async send(
    payload: MetaMessagePayload,
    options: SendOptions = {},
  ): Promise<SendResult> {
    this.assertOrigin(options.origin);
    // Explicit, default-off sandbox compatibility mode (see below).
    const sandboxNormalization =
      this.configService.get<boolean>(
        'meta.sandboxRecipientNormalizationEnabled',
      ) === true;

    const response = await this.postMessage({
      ...payload,
      to: normalizeSandboxRecipient(payload.to, sandboxNormalization),
    });

    // T2: the moment Meta accepted the send, before any local bookkeeping.
    const acceptedAt = new Date();
    const providerMessageId = response.messages?.[0]?.id;

    if (!providerMessageId) {
      throw new Error('Meta response did not include a provider message id');
    }

    await this.recordTranscript(
      payload,
      providerMessageId,
      acceptedAt,
      options,
    );
    return { providerMessageId };
  }

  /**
   * S1: every message Meta accepted, under the raw wa_id (before the
   * sandbox rewrite), except sends to the ops phone. The recorder never throws; the extra catch keeps a
   * misbehaving one from failing a send that already happened.
   */
  private async recordTranscript(
    payload: MetaMessagePayload,
    providerMessageId: string,
    acceptedAt: Date,
    options: SendOptions,
  ): Promise<void> {
    if (this.transcript === undefined || this.isOpsPhone(payload.to)) return;
    try {
      const entry = transcriptEntry(payload, providerMessageId);
      const { staffReplyId, mimeType } = options;
      const origin = options.origin ?? 'BOT';
      const details = {
        ...entry.details,
        ...(staffReplyId === undefined ? {} : { staffReplyId }),
        // BOT rows keep their details exactly as before.
        ...(origin === 'BOT' ? {} : { origin }),
      };
      await this.transcript.recordOutbound({
        ...entry,
        ...(mimeType === undefined || entry.media == null
          ? {}
          : { media: { ...entry.media, mimeType } }),
        ...(Object.keys(details).length === 0 ? {} : { details }),
        // The wire shape of a TEMPLATE row stays BOT (the author column only
        // knows CUSTOMER/BOT/STAFF); `details.origin` tells them apart.
        ...(origin === 'STAFF' ? { author: 'STAFF' as const } : {}),
        // Staff messages and templates are local history only.
        ...(origin === 'BOT' ? {} : { mirror: false }),
        acceptedAt,
      });
    } catch (error) {
      this.logger.warn(
        `transcript record failed for ${fingerprintMessageId(providerMessageId)}: ${describeError(error)}`,
      );
    }
  }

  /**
   * The ops phone is not a customer conversation: its sends are never
   * recorded (nor mirrored). Same comparison as the dispatcher's
   * `isOpsSender`: exact by default, both sides rewritten only under
   * `META_SANDBOX_RECIPIENT_NORMALIZATION`.
   */
  private isOpsPhone(to: string): boolean {
    const ops = this.configService.get<string>('humanHandoff.opsChannelPhone');
    if (!ops) return false;
    const sandbox =
      this.configService.get<boolean>(
        'meta.sandboxRecipientNormalizationEnabled',
      ) === true;
    return (
      normalizeSandboxRecipient(to, sandbox) ===
      normalizeSandboxRecipient(ops, sandbox)
    );
  }

  private async postMessage(
    payload: MetaMessagePayload,
  ): Promise<MetaSendResponse> {
    try {
      const response = await lastValueFrom(
        this.httpService.post<MetaSendResponse>(
          this.buildMessagesUrl(),
          payload,
          {
            headers: {
              Authorization: `Bearer ${this.configService.getOrThrow<AppConfig['meta']['accessToken']>('meta.accessToken')}`,
            },
          },
        ),
      );

      return response.data;
    } catch (error) {
      throw this.toWhatsappSendError(error);
    }
  }

  private buildMessagesUrl(): string {
    return this.buildGraphUrl('messages');
  }

  private buildGraphUrl(edge: 'messages' | 'media'): string {
    const baseUrl = this.configService.getOrThrow<
      AppConfig['meta']['graphApiBaseUrl']
    >('meta.graphApiBaseUrl');
    const phoneNumberId =
      this.configService.getOrThrow<AppConfig['meta']['phoneNumberId']>(
        'meta.phoneNumberId',
      );

    return `${baseUrl}/${phoneNumberId}/${edge}`;
  }

  private toWhatsappSendError(
    error: unknown,
    stage: 'send' | 'upload' = 'send',
  ): WhatsappSendError {
    const maybeAxiosError = error as {
      response?: {
        status?: number;
        data?: GraphErrorResponse;
      };
    };
    const graphError = maybeAxiosError.response?.data?.error;

    return new WhatsappSendError(
      maybeAxiosError.response?.status ?? null,
      graphError?.code ?? null,
      graphError?.message ?? null,
      stage,
    );
  }

  /** An unknown origin would silently change whether the backend mirrors. */
  private assertOrigin(origin: unknown): void {
    if (origin !== undefined && !ORIGINS.has(origin as string)) {
      throw new UnsupportedOutboundError('Invalid outbound origin');
    }
  }

  private assertTextMessage(message: OutboundText): void {
    if (typeof message?.to !== 'string' || typeof message?.text !== 'string') {
      throw new UnsupportedOutboundError();
    }
    this.assertOrigin(message.origin);
  }

  private assertDocumentMessage(message: OutboundDocument): void {
    if (
      typeof message?.to !== 'string' ||
      message.to === '' ||
      !hasExactlyOneMediaSource(message) ||
      typeof message.filename !== 'string' ||
      message.filename.trim() === '' ||
      (message.caption !== undefined && typeof message.caption !== 'string')
    ) {
      throw new UnsupportedOutboundError('Invalid outbound document message');
    }
    this.assertOrigin(message.origin);
  }

  /** Validates before any request; returns the file size in bytes. */
  private async assertMediaFile(message: OutboundMediaFile): Promise<number> {
    const invalid = (reason: string) =>
      new UnsupportedOutboundError(`Invalid outbound media file: ${reason}`);
    if (
      typeof message?.to !== 'string' ||
      message.to === '' ||
      typeof message.filePath !== 'string' ||
      message.filePath === '' ||
      (message.caption !== undefined && typeof message.caption !== 'string') ||
      (message.filename !== undefined && typeof message.filename !== 'string')
    ) {
      throw invalid('fields');
    }
    if (
      !(OUTBOUND_MEDIA_MIME_TYPES as readonly string[]).includes(
        message.mimeType,
      )
    ) {
      throw invalid('mime type');
    }
    this.assertOrigin(message.origin);
    let sizeBytes: number;
    try {
      const stats = await fsPromises.stat(message.filePath);
      if (!stats.isFile()) throw invalid('not a file');
      sizeBytes = stats.size;
    } catch (error) {
      if (error instanceof UnsupportedOutboundError) throw error;
      // The path is deliberately not echoed.
      throw invalid('not readable');
    }
    if (sizeBytes === 0) throw invalid('empty');
    const max =
      message.mimeType === 'application/pdf'
        ? DOCUMENT_MAX_BYTES
        : IMAGE_MAX_BYTES;
    if (sizeBytes > max) throw invalid('too large');
    return sizeBytes;
  }

  private assertImageMessage(message: OutboundImage): void {
    if (
      typeof message?.to !== 'string' ||
      message.to === '' ||
      !hasExactlyOneMediaSource(message) ||
      (message.caption !== undefined && typeof message.caption !== 'string')
    ) {
      throw new UnsupportedOutboundError('Invalid outbound image message');
    }
    this.assertOrigin(message.origin);
  }

  private assertInteractiveMessage(message: OutboundInteractive): void {
    const validId = (id: unknown) =>
      typeof id === 'string' && id !== '' && id.length <= INTERACTIVE_LIMITS.id;
    const validTitle = (title: unknown) =>
      typeof title === 'string' && title.trim() !== '';
    const interactive = message?.interactive;
    const valid =
      typeof message?.to === 'string' &&
      message.to !== '' &&
      typeof message.body === 'string' &&
      message.body.trim() !== '' &&
      (message.shortBody === undefined ||
        typeof message.shortBody === 'string') &&
      ((interactive?.type === 'buttons' &&
        Array.isArray(interactive.buttons) &&
        interactive.buttons.length > 0 &&
        interactive.buttons.every(
          (button: { id?: unknown; title?: unknown } | null) =>
            validId(button?.id) && validTitle(button?.title),
        )) ||
        (interactive?.type === 'list' &&
          validTitle(interactive.buttonText) &&
          Array.isArray(interactive.rows) &&
          interactive.rows.length > 0 &&
          interactive.rows.every(
            (
              row: {
                id?: unknown;
                title?: unknown;
                description?: unknown;
              } | null,
            ) =>
              validId(row?.id) &&
              validTitle(row?.title) &&
              (row?.description === undefined ||
                typeof row.description === 'string'),
          )));
    if (!valid) {
      throw new UnsupportedOutboundError(
        'Invalid outbound interactive message',
      );
    }
  }

  private assertTemplateMessage(message: OutboundTemplate): void {
    if (typeof message?.to !== 'string' || message.to === '') {
      throw new InvalidOutboundTemplateError('recipient');
    }
    const name: unknown = message.templateName;
    if (
      typeof name !== 'string' ||
      name.length > TEMPLATE_NAME_MAX_LENGTH ||
      !TEMPLATE_NAME_PATTERN.test(name)
    ) {
      throw new InvalidOutboundTemplateError('template_name');
    }
    const languageCode: unknown = message.languageCode;
    if (typeof languageCode !== 'string' || languageCode.trim() === '') {
      throw new InvalidOutboundTemplateError('language_code');
    }
    const parameters: unknown = message.bodyParameters;
    if (!Array.isArray(parameters)) {
      throw new InvalidOutboundTemplateError('body_parameters');
    }
    if (message.origin !== undefined && !ORIGINS.has(message.origin)) {
      throw new InvalidOutboundTemplateError('origin');
    }
    for (const parameter of parameters as unknown[]) {
      if (
        typeof parameter !== 'string' ||
        parameter === '' ||
        parameter !== parameter.trim() ||
        parameter.length > TEMPLATE_PARAMETER_MAX_LENGTH ||
        TEMPLATE_PARAMETER_FORBIDDEN.test(parameter)
      ) {
        throw new InvalidOutboundTemplateError('body_parameter');
      }
    }
  }
}

/** Exactly one of an `https://` link and a non-empty Meta media id. */
function hasExactlyOneMediaSource(message: {
  link?: unknown;
  mediaId?: unknown;
}): boolean {
  const hasLink = message.link !== undefined;
  const hasId = message.mediaId !== undefined;
  if (hasLink === hasId) return false;
  return hasLink
    ? typeof message.link === 'string' && message.link.startsWith('https://')
    : typeof message.mediaId === 'string' && message.mediaId !== '';
}

type PayloadField = Record<string, unknown> | undefined;

const field = (value: unknown): PayloadField =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** S1 transcript view of one accepted Graph API message payload. */
function transcriptEntry(
  payload: MetaMessagePayload,
  providerMessageId: string,
): OutboundTranscriptEntry {
  const type = stringOf(payload.type) ?? 'text';
  const base = { to: payload.to, providerMessageId, type };
  switch (type) {
    case 'text':
      return { ...base, text: stringOf(field(payload.text)?.body) };
    case 'image': {
      const image = field(payload.image);
      const caption = stringOf(image?.caption);
      const mediaId = stringOf(image?.id);
      return {
        ...base,
        ...(caption === undefined ? {} : { text: caption }),
        media:
          mediaId === undefined
            ? { link: stringOf(image?.link) }
            : { providerMediaId: mediaId },
      };
    }
    case 'document': {
      const document = field(payload.document);
      const caption = stringOf(document?.caption);
      const mediaId = stringOf(document?.id);
      return {
        ...base,
        ...(caption === undefined ? {} : { text: caption }),
        media: {
          ...(mediaId === undefined
            ? { link: stringOf(document?.link) }
            : { providerMediaId: mediaId }),
          filename: stringOf(document?.filename),
        },
      };
    }
    case 'interactive': {
      const interactive = field(payload.interactive);
      return {
        ...base,
        text: stringOf(field(interactive?.body)?.text),
        details: {
          interactive: { type: interactive?.type, action: interactive?.action },
          // T2: the titles as sent, so the inbox can show what was offered.
          options: interactiveOptionTitles(interactive),
        },
      };
    }
    case 'template': {
      const template = field(payload.template);
      const components = Array.isArray(template?.components)
        ? (template.components as unknown[])
        : [];
      const parameters = components
        .flatMap((component) => {
          const list = field(component)?.parameters;
          return Array.isArray(list) ? (list as unknown[]) : [];
        })
        .map((parameter) => stringOf(field(parameter)?.text))
        .filter((text): text is string => text !== undefined);
      return {
        ...base,
        details: {
          templateName: template?.name,
          languageCode: field(template?.language)?.code,
          bodyParameters: parameters,
        },
      };
    }
    default:
      return base;
  }
}

/** T2: the button titles or list row titles of a Graph API interactive. */
function interactiveOptionTitles(interactive: PayloadField): string[] {
  const action = field(interactive?.action);
  const titleOf = (item: unknown): string | undefined =>
    stringOf(field(field(item)?.reply)?.title) ?? stringOf(field(item)?.title);
  const buttons = Array.isArray(action?.buttons)
    ? (action.buttons as unknown[])
    : [];
  const sections = Array.isArray(action?.sections)
    ? (action.sections as unknown[])
    : [];
  const rows = sections.flatMap((section) => {
    const list = field(section)?.rows;
    return Array.isArray(list) ? (list as unknown[]) : [];
  });
  return [...buttons, ...rows]
    .map(titleOf)
    .filter((title): title is string => title !== undefined && title !== '');
}

/** Graph API `interactive` object, shortened to Meta's limits. */
function buildInteractivePayload(
  interactive: OutboundInteractive['interactive'],
): Record<string, unknown> {
  if (interactive.type === 'buttons') {
    return {
      type: 'button',
      action: {
        buttons: interactive.buttons
          .slice(0, INTERACTIVE_LIMITS.buttons)
          .map((button) => ({
            type: 'reply',
            reply: {
              id: button.id,
              title: fitInteractiveText(
                button.title,
                INTERACTIVE_LIMITS.buttonTitle,
              ),
            },
          })),
      },
    };
  }
  const rows = interactive.rows.slice(0, INTERACTIVE_LIMITS.rows).map((row) => {
    const description =
      row.description === undefined
        ? ''
        : fitInteractiveText(
            row.description,
            INTERACTIVE_LIMITS.rowDescription,
          );
    return {
      id: row.id,
      title: fitInteractiveText(row.title, INTERACTIVE_LIMITS.rowTitle),
      ...(description === '' ? {} : { description }),
    };
  });
  const sectionTitle =
    interactive.sectionTitle === undefined
      ? ''
      : fitInteractiveText(
          interactive.sectionTitle,
          INTERACTIVE_LIMITS.rowTitle,
        );
  return {
    type: 'list',
    action: {
      button: fitInteractiveText(
        interactive.buttonText,
        INTERACTIVE_LIMITS.listButtonText,
      ),
      sections: [
        { ...(sectionTitle === '' ? {} : { title: sectionTitle }), rows },
      ],
    },
  };
}

function interactiveMessage(
  to: string,
  body: string,
  interactive: Record<string, unknown>,
): MetaMessagePayload {
  const { type, action } = interactive;
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: { type, body: { text: body }, action },
  };
}

/**
 * Explicit opt-in Meta test-number recipient compatibility mode.
 *
 * Context: Meta's TEST phone number (the sandbox number, not a real
 * registered number) only permits replying to phone numbers that appear
 * in its "allowed recipients" list. When a customer messages the bot,
 * the webhook `from` field uses the E.164 Mexico format WITH the national
 * trunk prefix `1` (e.g. `5215585876245`). However, the sandbox allowed
 * list only contains the format WITHOUT that trunk prefix (e.g.
 * `525585876245`), so replying to the `from` number as-is fails with
 * Meta error 131030 "Recipient phone number not in allowed list".
 *
 * This function is gated behind the explicit, default-off
 * `META_SANDBOX_RECIPIENT_NORMALIZATION` flag. When enabled it strips the
 * Mexican national trunk `1` from numbers matching the Mexico pattern
 * `521` + 10 digits so the bot can reply to test recipients; every other
 * number is passed through unchanged. When disabled (the default) the
 * recipient is returned exactly as given, so production preserves the
 * `wa_id` Meta reported. The `enabled` flag is required: there is
 * deliberately no default that could silently opt in.
 */
export function normalizeSandboxRecipient(
  to: string,
  enabled: boolean,
): string {
  if (!enabled) {
    return to;
  }

  const MEXICO_TRUNK_1_PATTERN = /^521\d{10}$/;

  if (MEXICO_TRUNK_1_PATTERN.test(to)) {
    // "521" + 10 digits → "52" + 10 digits (drop the national trunk 1)
    return `52${to.slice(3)}`;
  }

  return to;
}

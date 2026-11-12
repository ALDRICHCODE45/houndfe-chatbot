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
  OutboundImage,
  OutboundInteractive,
  OutboundTemplate,
  OutboundText,
  SendResult,
  UnsupportedOutboundError,
  WhatsappSenderPort,
} from '../domain/whatsapp-sender.port';
import { describeError, fingerprintMessageId } from '../../common/log-safe';

type MetaSendResponse = {
  messages?: Array<{ id: string }>;
};

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
      message.staffReplyId,
    );
  }

  async sendImage(message: OutboundImage): Promise<SendResult> {
    this.assertImageMessage(message);

    return this.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'image',
      image: {
        link: message.link,
        ...(message.caption === undefined ? {} : { caption: message.caption }),
      },
    });
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

    return this.send({
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
    });
  }

  private async send(
    payload: MetaMessagePayload,
    staffReplyId?: string,
  ): Promise<SendResult> {
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
      staffReplyId,
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
    staffReplyId?: string,
  ): Promise<void> {
    if (this.transcript === undefined || this.isOpsPhone(payload.to)) return;
    try {
      const entry = transcriptEntry(payload, providerMessageId);
      await this.transcript.recordOutbound({
        ...entry,
        ...(staffReplyId === undefined
          ? {}
          : { details: { ...entry.details, staffReplyId } }),
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
    const baseUrl = this.configService.getOrThrow<
      AppConfig['meta']['graphApiBaseUrl']
    >('meta.graphApiBaseUrl');
    const phoneNumberId =
      this.configService.getOrThrow<AppConfig['meta']['phoneNumberId']>(
        'meta.phoneNumberId',
      );

    return `${baseUrl}/${phoneNumberId}/messages`;
  }

  private toWhatsappSendError(error: unknown): WhatsappSendError {
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
    );
  }

  private assertTextMessage(message: OutboundText): void {
    if (typeof message?.to !== 'string' || typeof message?.text !== 'string') {
      throw new UnsupportedOutboundError();
    }
  }

  private assertImageMessage(message: OutboundImage): void {
    if (
      typeof message?.to !== 'string' ||
      message.to === '' ||
      typeof message.link !== 'string' ||
      !message.link.startsWith('https://') ||
      (message.caption !== undefined && typeof message.caption !== 'string')
    ) {
      throw new UnsupportedOutboundError('Invalid outbound image message');
    }
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
      return {
        ...base,
        ...(caption === undefined ? {} : { text: caption }),
        media: { link: stringOf(image?.link) },
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

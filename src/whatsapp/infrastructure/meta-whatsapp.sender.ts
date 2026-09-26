import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import {
  OutboundText,
  SendResult,
  UnsupportedOutboundError,
  WhatsappSenderPort,
} from '../domain/whatsapp-sender.port';

type MetaSendResponse = {
  messages?: Array<{ id: string }>;
};

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

@Injectable()
export class MetaWhatsappSender implements WhatsappSenderPort {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async sendText(message: OutboundText): Promise<SendResult> {
    this.assertTextMessage(message);

    // Explicit, default-off sandbox compatibility mode (see below).
    const sandboxNormalization =
      this.configService.get<boolean>(
        'meta.sandboxRecipientNormalizationEnabled',
      ) === true;
    const normalizedMessage = {
      ...message,
      to: normalizeSandboxRecipient(message.to, sandboxNormalization),
    };

    const response = await this.postTextMessage(normalizedMessage);

    const providerMessageId = response.messages?.[0]?.id;

    if (!providerMessageId) {
      throw new Error('Meta response did not include a provider message id');
    }

    return { providerMessageId };
  }

  private async postTextMessage(
    message: OutboundText,
  ): Promise<MetaSendResponse> {
    try {
      const response = await lastValueFrom(
        this.httpService.post<MetaSendResponse>(
          this.buildMessagesUrl(),
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: message.to,
            type: 'text',
            text: {
              body: message.text,
            },
          },
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

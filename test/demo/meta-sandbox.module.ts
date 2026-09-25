import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Module,
  type NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { CONVERSATION_STORE } from '../../src/conversation/domain/conversation-store';
import { InMemoryConversationStore } from '../../src/conversation/infrastructure/in-memory-conversation.store';
import { AgentRunner } from '../../src/llm-agent/application/agent-runner.service';
import { ReceiptAmountRouterService } from '../../src/receipt-media/application/receipt-amount-router.service';
import { ReceiptIngressService } from '../../src/receipt-media/application/receipt-ingress.service';
import { HUMAN_HANDOFF_SERVICE_TOKEN } from '../../src/sale-flow/infrastructure/real-tool-registry';
import { WebhookDispatcherService } from '../../src/whatsapp/application/webhook-dispatcher.service';
import { RECENT_OUTBOUND } from '../../src/whatsapp/domain/recent-outbound.store';
import { WEBHOOK_DEDUP } from '../../src/whatsapp/domain/webhook-dedup.store';
import {
  WHATSAPP_SENDER,
  type OutboundText,
  type SendResult,
  type WhatsappSenderPort,
} from '../../src/whatsapp/domain/whatsapp-sender.port';
import { InMemoryRecentOutboundStore } from '../../src/whatsapp/infrastructure/in-memory-recent-outbound.store';
import { InMemoryWebhookDedupStore } from '../../src/whatsapp/infrastructure/in-memory-webhook-dedup.store';
import { normalizeSandboxRecipient } from '../../src/whatsapp/infrastructure/meta-whatsapp.sender';
import { SignatureGuard } from '../../src/whatsapp/presentation/signature.guard';
import { WebhookController } from '../../src/whatsapp/presentation/webhook.controller';

/**
 * MetaSandboxModule — test-only, isolated webhook profile (M1).
 *
 * Exposes ONLY the real `GET/POST /webhook` surface (WebhookController +
 * SignatureGuard + WebhookDispatcherService) and fakes every outbound edge:
 * the LLM/agent runner returns a canned reply, the sender records instead of
 * calling Meta, and the receipt and human-handoff dependencies are inert.
 *
 * It deliberately does NOT import the production `AppModule`, `WhatsappModule`,
 * `ChatbotApiModule`, or `ReceiptMediaModule`, so no backend/LLM config is
 * eagerly validated and no extra routes (`/`, receipt media, metrics) or
 * network/DB clients are loaded. Durable stores are replaced by the existing
 * in-memory adapters. Later sandbox work (M2) can `overrideProvider` the
 * sender/config without changing this surface.
 */

/** Deterministic sandbox credentials for offline tests — NOT real secrets. */
export const SANDBOX_VERIFY_TOKEN = 'sandbox-verify-token';
export const SANDBOX_APP_SECRET = 'sandbox-app-secret';

/** Canned reply the fake agent/LLM returns for every inbound message. */
export const SANDBOX_REPLY = 'Hola, soy el bot de HoundFe (sandbox).';

/**
 * Config keys the M2d inbound filter reads. They are supplied only by the
 * explicit `--outbound` bootstrap (see `meta-sandbox-bootstrap.ts`); the M1
 * config double omits them, which keeps the filter inert in every other mode.
 */
export const SANDBOX_OUTBOUND_ENABLED_KEY = 'meta.sandboxOutboundEnabled';
export const SANDBOX_APPROVED_RECIPIENT_KEY = 'meta.sandboxApprovedRecipient';

/** Config double: only the two Meta keys the webhook surface reads. */
export const SANDBOX_CONFIG = {
  getOrThrow: (key: string): string => {
    if (key === 'meta.verifyToken') return SANDBOX_VERIFY_TOKEN;
    if (key === 'meta.appSecret') return SANDBOX_APP_SECRET;
    throw new Error(`MetaSandboxModule: unconfigured key "${key}"`);
  },
  get: (): undefined => undefined,
};

/** In-memory sender double; records every outbound instead of calling Meta. */
export class SandboxSender implements WhatsappSenderPort {
  readonly sent: OutboundText[] = [];
  private sequence = 0;

  sendText(message: OutboundText): Promise<SendResult> {
    this.sent.push(message);
    this.sequence += 1;
    return Promise.resolve({
      providerMessageId: `wamid.sandbox.${this.sequence}`,
    });
  }
}

/** Fake agent/LLM edge: always returns the canned reply. */
export const SANDBOX_AGENT_RUNNER = {
  handle: (input: { senderId: string; text: string }) =>
    Promise.resolve({ reply: SANDBOX_REPLY, input }),
};

/** Inert receipt amount router: always fences (no store/backend access). */
export const SANDBOX_AMOUNT_ROUTER = {
  route: () => Promise.resolve({ kind: 'fenced' as const }),
};

/** Inert receipt ingress: never admits media. */
export const SANDBOX_RECEIPT_INGRESS = {
  admit: () => Promise.resolve({ kind: 'disabled' as const }),
};

/** Inert human-handoff: no ops phone, no pending/ops routing. */
export const SANDBOX_HUMAN_HANDOFF = {
  isOpsSender: () => false,
  resolveReply: () =>
    Promise.resolve({ kind: 'no_pending' as const, reply: '' }),
};

/**
 * M2d pre-dispatch guard for explicit outbound mode.
 *
 * In `--outbound` mode the allowlist sender rejects any recipient outside the
 * single approved test number, so a signed webhook whose batch is entirely
 * unapproved senders would otherwise run the no-provider fallback and then
 * throw inside the sender fence — an HTTP 500 that makes Meta re-deliver
 * forever. This interceptor runs AFTER `SignatureGuard` (guards always precede
 * interceptors) and BEFORE the dispatcher.
 *
 * It classifies the RAW signed payload, never the production normalizer's
 * output: an element the normalizer would silently drop (unsupported type,
 * malformed media, missing `from`) can therefore never hide an unapproved
 * sender, and authorization never trusts the `contacts[0].wa_id` fallback. Any
 * unsupported/malformed element, or a batch mixing approved and non-approved
 * senders, fails closed with an explicit error before any dispatch. Only a
 * fully well-formed all-unapproved-text batch is acknowledged with
 * `{ received: true }` — a webhook acknowledgement, never a customer delivery
 * receipt. Outside explicit outbound mode the config keys are absent and the
 * filter is inert, leaving M1/M2a/M2b behavior unchanged.
 */
@Injectable()
export class SandboxInboundSenderFilterInterceptor implements NestInterceptor {
  constructor(private readonly configService: ConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.isOutboundWebhookPost(context)) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<{ body?: unknown }>();
    const scan = scanRawSenders(request.body, this.approvedRecipient());

    // No inbound messages at all (e.g. a status callback): stay inert.
    if (scan.count === 0 && !scan.invalid) {
      return next.handle();
    }

    // An unsupported/malformed element, or a mixed approved/non-approved
    // batch, must never be acknowledged or dispatched.
    if (scan.invalid || (scan.approved > 0 && scan.approved < scan.count)) {
      throw new InternalServerErrorException(
        'Sandbox inbound filter: unsupported, malformed, or mixed senders',
      );
    }

    // Every sender is well-formed and unapproved: ack without any send.
    if (scan.approved === 0) {
      return of({ received: true });
    }

    // Every sender is well-formed and approved: dispatch normally.
    return next.handle();
  }

  private isOutboundWebhookPost(context: ExecutionContext): boolean {
    return (
      context.getType() === 'http' &&
      this.configService.get<boolean>(SANDBOX_OUTBOUND_ENABLED_KEY) === true &&
      typeof this.configService.get<string>(SANDBOX_APPROVED_RECIPIENT_KEY) ===
        'string' &&
      context.getClass() === WebhookController &&
      context.getHandler() === WebhookController.prototype.handleEvent
    );
  }

  private approvedRecipient(): string {
    return this.configService.get<string>(SANDBOX_APPROVED_RECIPIENT_KEY) ?? '';
  }
}

/** Structural verdict for a single raw inbound element. */
type RawSenderVerdict = 'approved' | 'unapproved' | 'invalid';

interface RawSenderScan {
  readonly count: number;
  readonly approved: number;
  readonly invalid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact raw key sets allowed for an authorizable text message. */
const ALLOWED_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'from',
  'timestamp',
  'type',
  'text',
]);
const ALLOWED_TEXT_KEYS: ReadonlySet<string> = new Set(['body']);

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

/**
 * A raw element authorizes a send only when it is exactly a well-formed text
 * message with an explicit, non-empty `from` and no extra payload keys. Any
 * unsupported type, missing id/timestamp/body/`from`, or extra message-level
 * (image/document/audio/…) or text-level field is invalid, so an ambiguous
 * text+media payload can never slip past the production text branch.
 */
function classifyRawSender(
  raw: unknown,
  approvedRecipient: string,
): RawSenderVerdict {
  if (!isRecord(raw)) return 'invalid';
  if (!hasOnlyKeys(raw, ALLOWED_MESSAGE_KEYS)) return 'invalid';
  if (typeof raw.from !== 'string' || raw.from.length === 0) return 'invalid';
  if (raw.type !== 'text') return 'invalid';
  if (typeof raw.id !== 'string' || raw.id.length === 0) return 'invalid';
  if (typeof raw.timestamp !== 'string' || raw.timestamp.length === 0) {
    return 'invalid';
  }
  if (!isRecord(raw.text) || typeof raw.text.body !== 'string') {
    return 'invalid';
  }
  if (!hasOnlyKeys(raw.text, ALLOWED_TEXT_KEYS)) return 'invalid';
  return normalizeSandboxRecipient(raw.from) === approvedRecipient
    ? 'approved'
    : 'unapproved';
}

/**
 * Walks the raw signed payload and counts every message without trusting the
 * production normalizer or the `contacts[0].wa_id` fallback. Any non-array
 * container or non-record element marks the whole batch invalid.
 */
function scanRawSenders(
  body: unknown,
  approvedRecipient: string,
): RawSenderScan {
  if (!isRecord(body)) return { count: 0, approved: 0, invalid: true };
  const entry = body.entry;
  if (entry === undefined) return { count: 0, approved: 0, invalid: false };
  if (!Array.isArray(entry)) return { count: 0, approved: 0, invalid: true };

  const messages: unknown[] = [];
  let invalid = false;

  for (const entryItem of entry) {
    if (!isRecord(entryItem)) {
      invalid = true;
      continue;
    }
    const changes = entryItem.changes;
    if (changes === undefined) continue;
    if (!Array.isArray(changes)) {
      invalid = true;
      continue;
    }
    for (const change of changes) {
      if (!isRecord(change)) {
        invalid = true;
        continue;
      }
      const value = change.value;
      if (value === undefined) continue;
      if (!isRecord(value)) {
        invalid = true;
        continue;
      }
      const batch = value.messages;
      if (batch === undefined) continue;
      if (!Array.isArray(batch)) {
        invalid = true;
        continue;
      }
      for (const item of batch) {
        messages.push(item as unknown);
      }
    }
  }

  let approved = 0;
  for (const message of messages) {
    const verdict = classifyRawSender(message, approvedRecipient);
    if (verdict === 'approved') approved += 1;
    else if (verdict === 'invalid') invalid = true;
  }

  return { count: messages.length, approved, invalid };
}

@Module({
  controllers: [WebhookController],
  providers: [
    SignatureGuard,
    WebhookDispatcherService,
    { provide: ConfigService, useValue: SANDBOX_CONFIG },
    { provide: WHATSAPP_SENDER, useClass: SandboxSender },
    { provide: WEBHOOK_DEDUP, useClass: InMemoryWebhookDedupStore },
    { provide: RECENT_OUTBOUND, useClass: InMemoryRecentOutboundStore },
    { provide: CONVERSATION_STORE, useClass: InMemoryConversationStore },
    { provide: AgentRunner, useValue: SANDBOX_AGENT_RUNNER },
    { provide: ReceiptAmountRouterService, useValue: SANDBOX_AMOUNT_ROUTER },
    { provide: ReceiptIngressService, useValue: SANDBOX_RECEIPT_INGRESS },
    { provide: HUMAN_HANDOFF_SERVICE_TOKEN, useValue: SANDBOX_HUMAN_HANDOFF },
    SandboxInboundSenderFilterInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useExisting: SandboxInboundSenderFilterInterceptor,
    },
  ],
})
export class MetaSandboxModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  ],
})
export class MetaSandboxModule {}

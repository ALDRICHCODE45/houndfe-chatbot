# Design: WhatsApp Channel Foundation

## Technical Approach

Greenfield NestJS 11 service organized as screaming feature modules. Four feature modules
(`whatsapp`, `chatbot-api`, `conversation`, `config`) wired in `app.module.ts`. The webhook
controller verifies the GET challenge (`whatsapp-webhook`) and accepts signed POST events behind
an HMAC guard, normalizes the envelope, and dispatches an echo reply via the `WhatsappSenderPort`
(`whatsapp-sender`). The `ChatbotApiClient` (`chatbot-api-client`) is built but not invoked in the
echo flow. `ConversationStore` (`conversation-store`) tracks per-sender state in memory. `ConfigModule`
(`app-config`) validates env at boot. Strict TDD: every spec scenario gets a Jest test before code.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| Raw body access | `NestFactory.create(AppModule, { rawBody: true })` + `@Req()` → `req.rawBody: Buffer` | `express.raw()` middleware; manual `rawBody` capture | Native in Nest 11; gives `Buffer` to the guard untouched, avoids re-stringify drift |
| Signature check placement | `SignatureGuard` (`canActivate`) runs before controller/parsing logic | Verify inside controller | Guard rejects at 401 before any business logic; testable in isolation |
| Sender abstraction | Port interface + `MetaWhatsappSender` adapter | Direct axios in controller | Spec requires HTTP isolated behind a port so tests mock it |
| HTTP client | `@nestjs/axios` `HttpService` wrapped in typed `ChatbotApiClient` | raw `fetch`; per-call axios | Interceptors centralize auth + branch header; injectable + mockable |
| Retry policy | Manual backoff in client (idempotent GET only) | global axios-retry on all verbs | POST/PUT/PATCH must NOT blind-retry (idempotency owned by backend) |
| Conversation store | Port + `InMemoryConversationStore` (`Map`) | Postgres now | Proposal defers Postgres; port lets us swap the adapter later |
| Env validation | `@nestjs/config` + Joi schema, `validationOptions.abortEarly:false` | zod | Joi is first-class in `@nestjs/config`; fail-fast at boot |
| DI tokens | `Symbol`/string tokens for `WhatsappSenderPort`, `ConversationStore` | inject classes directly | `di-use-interfaces-tokens`; interfaces vanish at runtime, need tokens |

## Data Flow

    Meta ──POST(raw)──▶ SignatureGuard ──ok──▶ WebhookController.handleEvent
                            │ 401                      │ parse envelope
                            ▼                          ▼
                         reject              WebhookDispatcher.dispatch
                                                       │ upsert state
                                          ConversationStore ◀──┘
                                                       │ echo text
                                          WhatsappSenderPort ──HTTP──▶ Meta Graph

    GET verify ──▶ WebhookController.verify ── token ok? ──▶ 200 hub.challenge | 403

**Signature gotcha (explicit):** HMAC-SHA256 MUST be computed over the EXACT bytes Meta sent
(`req.rawBody` Buffer). NEVER `JSON.parse` then `JSON.stringify` to recompute — key ordering and
whitespace change the bytes and the MAC will never match. Guard: `crypto.createHmac('sha256',
appSecret).update(req.rawBody).digest('hex')`, compared to the `sha256=` header via
`crypto.timingSafeEqual` (equal-length Buffers; mismatched length → reject first). Missing header → 401.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/main.ts` | Modify | `rawBody: true`, global `ValidationPipe` (whitelist, transform) |
| `src/app.module.ts` | Modify | Import Config + 4 feature modules |
| `src/config/configuration.ts`, `env.validation.ts`, `config.module.ts` | Create | Typed factory + Joi schema |
| `src/whatsapp/presentation/webhook.controller.ts` | Create | GET verify + POST events |
| `src/whatsapp/presentation/signature.guard.ts` | Create | HMAC-SHA256 + timingSafeEqual |
| `src/whatsapp/application/webhook-dispatcher.service.ts` | Create | Normalize envelope → echo |
| `src/whatsapp/domain/whatsapp-sender.port.ts` | Create | Port interface + token |
| `src/whatsapp/infrastructure/meta-whatsapp.sender.ts` | Create | Meta Graph adapter |
| `src/whatsapp/presentation/dto/*.ts`, `whatsapp.module.ts` | Create | DTOs + module wiring |
| `src/chatbot-api/{domain,infrastructure}/*`, `chatbot-api.module.ts` | Create | Typed client, auth interceptor, retry, error map |
| `src/conversation/{domain,infrastructure}/*`, `conversation.module.ts` | Create | Port + in-memory impl |
| `package.json` | Modify | Add `@nestjs/config`, `@nestjs/axios`, `axios`, `joi` |

## Interfaces / Contracts

```ts
// whatsapp/domain/whatsapp-sender.port.ts
export const WHATSAPP_SENDER = Symbol('WHATSAPP_SENDER');
export interface OutboundText { to: string; text: string; }
export interface SendResult { providerMessageId: string; }
export interface WhatsappSenderPort {
  sendText(message: OutboundText): Promise<SendResult>; // non-text → UnsupportedOutboundError
}

// whatsapp/domain/inbound-message.ts (normalized envelope)
export interface InboundMessage { senderId: string; text: string; messageId: string; timestamp: string; }

// conversation/domain/conversation-store.ts
export const CONVERSATION_STORE = Symbol('CONVERSATION_STORE');
export interface ConversationState { senderId: string; lastMessageAt: string; data: Record<string, unknown>; }
export interface ConversationStore {
  get(senderId: string): Promise<ConversationState | null>;
  create(senderId: string, state: Omit<ConversationState, 'senderId'>): Promise<ConversationState>;
  update(senderId: string, patch: Partial<Omit<ConversationState, 'senderId'>>): Promise<ConversationState>;
}

// chatbot-api/domain/chatbot-api.client.ts
export interface ChatbotApiClient {
  searchCatalog(q: string, limit?: number): Promise<CatalogItemResponse[]>;          // §4.4.1
  getStock(productId: string): Promise<StockCheckResponse>;                           // §4.4.2
  evaluateCart(items: CartItemInput[]): Promise<CartEvaluationResult>;                // §4.4.3
  getCustomerByPhone(cc: string, phone: string): Promise<CustomerLookupResponse>;    // §4.4.4
  upsertCustomer(dto: CustomerUpsertInput): Promise<CustomerUpsertResponse>;          // §4.4.5
  createSale(dto: CreateSaleInput, idempotencyKey: string): Promise<BotSaleResponse>; // §4.4.6
  attachReceipt(saleId: string, dto: AttachReceiptInput): Promise<AttachReceiptResponse>; // §4.4.7
  updateDelivery(saleId: string, dto: UpdateDeliveryInput): Promise<void>;            // §4.4.8
  getOrderHistory(phone: string, cc: string): Promise<OrderHistoryResponse[]>;        // §4.4.9
}
```

**Client behavior:** axios instance `baseURL` from config, request interceptor injects
`Authorization: Bearer svc_<key>` + `X-Branch-Id`; a different branch context → reject before send.
Idempotent GET retries (max 3, exponential backoff) on 5xx/network only. 429 → read `Retry-After`,
throw typed `RateLimitError(retryAfterSeconds)` (no blind retry). Status map: 401→`AuthError`,
403→`ForbiddenError`, 404→`NotFoundError`, 429→`RateLimitError`, 5xx→`UpstreamError`.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | SignatureGuard valid/invalid/missing MAC | Sign fixture with known appSecret; `timingSafeEqual` vectors |
| Unit | Sender: text send + non-text rejection | Mock `HttpService`; assert one Graph request, return `providerMessageId` |
| Unit | Client: headers, GET retry, 429 Retry-After, error map | Mock `HttpService`/axios; simulate 5xx then 200, 429 with header |
| Unit | InMemoryConversationStore create/read/update/unknown | Direct calls on `Map` impl |
| Unit | Env validation: missing/invalid → throw | Call Joi schema with bad env |
| Integration | GET verify 200/403 | `TestingModule` + supertest with token query |
| E2E | Signed inbound text → sender called with echo | supertest POST signed fixture; sender mocked; assert `sendText({to, text})` — no live number |

## Migration / Rollout

No data migration. In-memory store is ephemeral. Deployment (VPS 2, HTTPS/TLS via Let's Encrypt,
public webhook URL) is documented as a follow-up, not built here. Rollback = revert feature branch
(greenfield modules, clean delete).

## Open Questions

- [ ] Joi vs zod for env validation — design assumes **Joi** (native `@nestjs/config`). Confirm or override.
- [ ] DI token style — design assumes `Symbol` tokens. Confirm vs string tokens.
- [ ] `ConversationState.data` shape is intentionally open (`Record<string, unknown>`) for the echo
      slice; real schema lands with the LLM slice. Acceptable for now?
- [ ] Echo reply uses Graph send API which needs a real token at runtime; tests mock it. Confirm no
      live-call expectation in this slice (proposal says simulated only).

# Tasks: WhatsApp Channel Foundation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1600-2000 |
| 400-line budget risk | High |
| Chained PRs recommended | No (solo developer, feature branch) |
| Suggested split | 5 work-unit commits |
| Delivery strategy | Solo feature branch with reviewable commits |
| Chain strategy | N/A (no PRs) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: N/A
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Commit Boundary | Notes |
|------|------|-----------------|-------|
| 1 | Config foundation + env validation | After Phase 1 complete | Boot guards, typed config factory, tests |
| 2 | Conversation store port + in-memory impl | After Phase 2 complete | Pure domain, no HTTP, full test coverage |
| 3 | WhatsApp sender port + Meta adapter + signature guard | After Phase 3-4 complete | Webhook security + outbound abstraction |
| 4 | Webhook controller + dispatcher (echo logic) | After Phase 5-6 complete | Inbound flow + echo wiring |
| 5 | ChatbotApiClient + app wiring + E2E echo | After Phase 7-8 complete | Backend client + full integration |

---

## Phase 1: Config Foundation

- [x] 1.1 Install dependencies: `pnpm add @nestjs/config @nestjs/axios axios joi`
- [x] 1.2 TEST: Create `src/config/env.validation.spec.ts` — assert Joi schema rejects missing `META_VERIFY_TOKEN`
- [x] 1.3 TEST: Assert schema rejects invalid `CHATBOT_API_BASE_URL` (non-URL)
- [x] 1.4 TEST: Assert schema rejects `SERVICE_KEY` not starting with `svc_`
- [x] 1.5 CODE: Create `src/config/env.validation.ts` with Joi schema for all required env vars
- [x] 1.6 CODE: Create `src/config/configuration.ts` typed config factory
- [x] 1.7 CODE: Create `src/config/config.module.ts` importing `@nestjs/config` with validation
- [x] 1.8 TEST: Integration test — ConfigService returns typed values when env is valid
- [x] 1.9 TEST: Integration test — app refuses to start with missing env (expect boot error)

## Phase 2: Conversation Store

- [x] 2.1 CODE: Create `src/conversation/domain/conversation-store.ts` port interface + `CONVERSATION_STORE` Symbol token
- [x] 2.2 CODE: Define `ConversationState` interface with `senderId`, `lastMessageAt`, `data: Record<string, unknown>`
- [x] 2.3 TEST: Create `src/conversation/infrastructure/in-memory-conversation.store.spec.ts` — new sender creates state
- [x] 2.4 TEST: Assert read unknown sender returns null
- [x] 2.5 TEST: Assert update existing sender patches state and preserves senderId
- [x] 2.6 CODE: Create `src/conversation/infrastructure/in-memory-conversation.store.ts` using `Map<string, ConversationState>`
- [x] 2.7 CODE: Create `src/conversation/conversation.module.ts` providing `CONVERSATION_STORE` → InMemoryConversationStore

## Phase 3: WhatsApp Sender Port

- [x] 3.1 CODE: Create `src/whatsapp/domain/whatsapp-sender.port.ts` with `WHATSAPP_SENDER` Symbol, `OutboundText`, `SendResult`, `WhatsappSenderPort` interface
- [x] 3.2 CODE: Create `src/whatsapp/domain/inbound-message.ts` normalized envelope interface
- [x] 3.3 TEST: Create `src/whatsapp/infrastructure/meta-whatsapp.sender.spec.ts` — mock `HttpService`, assert text send produces Graph request
- [x] 3.4 TEST: Assert non-text payload throws `UnsupportedOutboundError`
- [x] 3.5 CODE: Create `src/whatsapp/infrastructure/meta-whatsapp.sender.ts` adapter implementing `WhatsappSenderPort`
- [x] 3.6 CODE: Inject `HttpService`, implement `sendText()` calling Meta Graph API `/messages` endpoint

## Phase 4: Signature Guard

- [x] 4.1 TEST: Create `src/whatsapp/presentation/signature.guard.spec.ts` — sign fixture with known appSecret, assert guard passes
- [x] 4.2 TEST: Assert guard rejects missing `X-Hub-Signature-256` header with 401
- [x] 4.3 TEST: Assert guard rejects invalid MAC with 401
- [x] 4.4 TEST: Assert guard uses `crypto.timingSafeEqual` for MAC comparison
- [x] 4.5 CODE: Create `src/whatsapp/presentation/signature.guard.ts` implementing `CanActivate`
- [x] 4.6 CODE: Extract `req.rawBody`, compute HMAC-SHA256 with appSecret, compare via `timingSafeEqual`

## Phase 5: Webhook Controller

- [ ] 5.1 CODE: Create `src/whatsapp/presentation/dto/webhook-verify.dto.ts` for GET query params
- [ ] 5.2 CODE: Create `src/whatsapp/presentation/dto/webhook-event.dto.ts` for POST inbound payload
- [ ] 5.3 TEST: Create `src/whatsapp/presentation/webhook.controller.spec.ts` (unit) — GET verify with valid token returns challenge
- [ ] 5.4 TEST: Assert GET verify with invalid token returns 403
- [ ] 5.5 CODE: Create `src/whatsapp/presentation/webhook.controller.ts` with `@Get('webhook')` verify method
- [ ] 5.6 CODE: Implement `@Post('webhook')` with `@UseGuards(SignatureGuard)` annotation
- [ ] 5.7 TEST: Integration test with supertest — GET `/webhook?hub.verify_token=valid&hub.challenge=test` returns `test`
- [ ] 5.8 TEST: Integration test — GET with wrong token returns 403

## Phase 6: Webhook Dispatcher (Echo Logic)

- [ ] 6.1 TEST: Create `src/whatsapp/application/webhook-dispatcher.service.spec.ts` — mock ConversationStore and WhatsappSenderPort
- [ ] 6.2 TEST: Assert inbound text normalizes envelope and calls sender with echo reply
- [ ] 6.3 TEST: Assert dispatcher upserts conversation state with `lastMessageAt`
- [ ] 6.4 CODE: Create `src/whatsapp/application/webhook-dispatcher.service.ts`
- [ ] 6.5 CODE: Inject `CONVERSATION_STORE` and `WHATSAPP_SENDER` tokens
- [ ] 6.6 CODE: Implement `dispatch(event)` — normalize envelope → upsert state → send echo via port
- [ ] 6.7 CODE: Create `src/whatsapp/whatsapp.module.ts` wiring controller, guard, dispatcher, sender

## Phase 7: ChatbotApiClient

- [ ] 7.1 CODE: Create `src/chatbot-api/domain/chatbot-api.client.ts` interface with 9 typed methods (§4.4.1–4.4.9)
- [ ] 7.2 CODE: Create `src/chatbot-api/domain/dtos/*.ts` for request/response types per AGENTS.md contract
- [ ] 7.3 CODE: Create `src/chatbot-api/domain/errors.ts` typed errors: `AuthError`, `ForbiddenError`, `NotFoundError`, `RateLimitError`, `UpstreamError`
- [ ] 7.4 TEST: Create `src/chatbot-api/infrastructure/chatbot-api-http.client.spec.ts` — mock axios, assert Bearer + X-Branch-Id headers
- [ ] 7.5 TEST: Assert branch mismatch throws before sending request
- [ ] 7.6 TEST: Assert GET retries on 5xx with exponential backoff (max 3)
- [ ] 7.7 TEST: Assert POST does NOT retry on 5xx
- [ ] 7.8 TEST: Assert 429 response throws `RateLimitError` with `retryAfterSeconds` from header
- [ ] 7.9 TEST: Assert 401 → `AuthError`, 403 → `ForbiddenError`, 404 → `NotFoundError`
- [ ] 7.10 CODE: Create `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` wrapping `HttpService`
- [ ] 7.11 CODE: Implement request interceptor injecting `Authorization: Bearer svc_<key>` + `X-Branch-Id`
- [ ] 7.12 CODE: Implement retry logic for idempotent GETs only
- [ ] 7.13 CODE: Implement response interceptor mapping status codes to typed errors
- [ ] 7.14 CODE: Create `src/chatbot-api/chatbot-api.module.ts` providing `ChatbotApiClient`

## Phase 8: App Wiring & E2E Echo

- [ ] 8.1 CODE: Modify `src/main.ts` — add `rawBody: true` to `NestFactory.create()` options
- [ ] 8.2 CODE: Add global `ValidationPipe` with `whitelist: true, transform: true`
- [ ] 8.3 CODE: Modify `src/app.module.ts` — import `ConfigModule`, `WhatsappModule`, `ConversationModule`, `ChatbotApiModule`
- [ ] 8.4 TEST: Create `test/echo.e2e-spec.ts` — sign fixture inbound text with known appSecret
- [ ] 8.5 TEST: Assert POST `/webhook` with signed payload calls sender port with echo message
- [ ] 8.6 TEST: Mock `WHATSAPP_SENDER` in TestingModule, assert `sendText({ to: senderId, text: 'Echo: <original>' })`
- [ ] 8.7 TEST: Assert conversation state is upserted during echo flow
- [ ] 8.8 VERIFY: Run `pnpm test` — all tests green, coverage >= 80%

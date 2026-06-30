# Proposal: WhatsApp Channel Foundation

## Intent

HoundFe's chatbot program requires a WhatsApp channel service (`houndfe-chatbot`) that receives customer messages and communicates with the backend `chatbot-api`. No channel infrastructure exists today — the repo is a bare NestJS scaffold. This slice delivers the foundational webhook, sender, API client, and session plumbing so every future slice (LLM agent, cart, shipping) builds on a tested, working channel.

This slice is designed to be fully buildable and testable WITHOUT external blockers (Meta number, VPS). All verification uses simulated Meta webhook payloads.

## Scope

### In Scope
- Meta WhatsApp webhook receiver (GET verify-challenge + POST events)
- `X-Hub-Signature-256` HMAC-SHA256 guard using Nest `rawBody: true` + `crypto.timingSafeEqual`
- Meta Cloud API send/receive abstraction behind a port (typed sender service)
- Typed HTTP client for backend `chatbot-api` (Bearer `svc_` auth, `X-Branch-Id`, retry on idempotent GETs, honor `Retry-After` on 429, no blind POST retry)
- End-to-end echo bot (inbound text -> echo reply), validated with Jest + simulated payloads
- In-memory `ConversationStore` behind a port/interface (PostgreSQL deferred)
- `@nestjs/config` with fail-fast env validation at boot
- Single-branch configuration (one credential, one branch, one phone number)

### Out of Scope
- Live E2E test against Meta test number (blocked: number/recipients not finished)
- VPS 2 deployment with HTTPS/TLS (blocked: VPS not provisioned)
- PostgreSQL conversation persistence (next slice)
- LLM agent, cart/order flow, Skydropx shipping, human handoff, EVO payments
- Image recognition, receipt/media re-hosting
- Multi-branch / multi-number configuration

## Capabilities

### New Capabilities
- `whatsapp-webhook`: Webhook verification + inbound event reception with HMAC signature guard
- `whatsapp-sender`: Meta Cloud API message sender behind a port (text messages for echo slice)
- `chatbot-api-client`: Typed HTTP client consuming backend endpoints (§4.4.1–4.4.9) with auth, retry, error mapping
- `conversation-store`: Session/conversation persistence port with in-memory implementation
- `app-config`: Environment validation, typed config factory, fail-fast boot

### Modified Capabilities
None — greenfield repo, no existing specs.

## Approach

Single `WhatsappModule` with webhook controller, signature guard, and Meta Cloud API sender service. Separate `ChatbotApiModule` wrapping `@nestjs/axios` with typed client. `ConversationModule` exposing a `ConversationStore` port (in-memory impl). Global `ConfigModule` with Joi/zod env validation. Nest's built-in `rawBody: true` for signature verification. Strict TDD: tests written before implementation using simulated Meta payloads.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/main.ts` | Modified | Add `rawBody: true`, global ValidationPipe |
| `src/app.module.ts` | Modified | Import ConfigModule, feature modules |
| `src/whatsapp/` | New | Webhook controller, signature guard, Meta API sender, DTOs |
| `src/chatbot-api/` | New | Typed HTTP client, auth interceptor, retry, error mapping |
| `src/conversation/` | New | ConversationStore port + in-memory impl |
| `src/config/` | New | Typed config factory, env validation schema |
| `package.json` | Modified | Add `@nestjs/config`, `@nestjs/axios`, `axios` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Meta number not registered — cannot validate E2E with real WhatsApp | High | Slice uses simulated payloads; real E2E is a follow-up |
| VPS 2 not provisioned — cannot deploy | High | Not a deliverable; deployment shape documented as follow-up |
| Raw-body misconfiguration -> all webhooks rejected | Med | Guard unit tests with known appSecret + payload vectors |
| Meta dev token expires every 24h | Med | Config supports easy rotation; System User token planned pre-cutover |
| ServiceCredential not provisioned in backend | Low | Echo slice makes no backend API calls; client tested with mocks |

## Rollback Plan

Revert the feature branch. The repo is greenfield — no existing behavior is altered. Each deliverable is a new module; removing it is a clean module-level delete + import removal from `app.module.ts`.

## Dependencies

- `@nestjs/config` (env validation)
- `@nestjs/axios` + `axios` (backend API client)
- Meta WhatsApp Cloud API contract (webhook format, send API) — used via simulated payloads only
- Backend `chatbot-api` contract (AGENTS.md §4) — client built against documented contract, tested with mocks

## Success Criteria

- [ ] `pnpm test` passes with all new tests green
- [ ] Webhook GET verify-challenge returns `hub.challenge` on valid token, 403 on invalid
- [ ] Webhook POST rejects payloads with invalid/missing `X-Hub-Signature-256` (401)
- [ ] Echo bot flow: simulated inbound text -> sender service called with echo response
- [ ] ChatbotApiClient correctly sets Bearer auth, X-Branch-Id, retries GETs with backoff, respects 429 Retry-After
- [ ] App refuses to boot with missing required env vars
- [ ] ConversationStore port: session create/read/update works in-memory
- [ ] Coverage >= 80% on new code

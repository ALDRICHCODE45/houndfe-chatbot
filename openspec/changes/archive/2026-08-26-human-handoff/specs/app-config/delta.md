# Delta for app-config

## Out of Scope (non-goals)

This delta does NOT introduce:

- **A new config module or a new config factory.** The existing `src/config/configuration.ts`
  + `src/config/env.validation.ts` pipeline gains two new Joi fields; the surface is
  unchanged for the existing env vars.
- **A scheduler or queue worker.** The handoff slice does NOT need a cron / `setTimeout`
  / background job (owner decision: wait indefinitely). No new `ConfigModule` provider
  adds time-driven behavior.
- **A new secret store.** `OPS_CHANNEL_PHONE` is a plain string env var (a phone number,
  not a secret); it does NOT enter the existing `secrets` block.
- **A change to `CHATBOT_API_CASHIER_USER_ID` or any other existing env var.** The
  existing Joi schema is preserved; new fields are ADDED.
- **A change to the `humanHandoff` config block's shape beyond the two new fields.**
  `humanHandoff.enabled` and `humanHandoff.opsChannelPhone` are the only new keys.
- **Boot-time hydration of `human_handoff_requests`.** The handoff table is created by
  the migration; the runtime reads it on demand. No backfill is required.

## MODIFIED Requirements

### Requirement: Fail fast on invalid environment

The system MUST load typed application config at boot and MUST refuse to start if required environment variables are missing or invalid.
Required values are: Meta verify token, Meta app secret, Meta access token, chatbot-api base URL, `svc_` key, branch id, and (when `HUMAN_HANDOFF_ENABLED=true`) `OPS_CHANNEL_PHONE`.

When `HUMAN_HANDOFF_ENABLED=false` (the explicit kill-switch), `OPS_CHANNEL_PHONE` is
OPTIONAL: the runtime boots, `HumanHandoffService.create(...)` short-circuits with
`kind: 'disabled'`, and the dispatcher's ops pre-routing hook is wired but inert
(no rows in `human_handoff_requests`).

The Joi validation pipeline MUST apply `normalizeSandboxRecipient()` to
`OPS_CHANNEL_PHONE` at boot so dev/test mode strips the Mexican trunk `1` for the
Meta test number.

(Previously: no `OPS_CHANNEL_PHONE` or `HUMAN_HANDOFF_ENABLED` env vars; required
values ended at `branchId`.)

#### Scenario: Missing env blocks boot

- GIVEN one required environment variable is absent
- WHEN the application starts
- THEN boot fails with a configuration error

#### Scenario: Invalid env blocks boot

- GIVEN the Meta access token, base URL, or service key format is invalid
- WHEN the application starts
- THEN boot fails before any webhook or API traffic is accepted

#### Scenario: HUMAN_HANDOFF_ENABLED=true without OPS_CHANNEL_PHONE blocks boot

- GIVEN `HUMAN_HANDOFF_ENABLED=true`
- AND `OPS_CHANNEL_PHONE` is unset, empty, or not a string of digits (with optional
  `+` prefix)
- WHEN the application starts
- THEN boot MUST abort with a Joi validation error mentioning `OPS_CHANNEL_PHONE`
- AND the service MUST NOT bind to any port.

#### Scenario: HUMAN_HANDOFF_ENABLED=false without OPS_CHANNEL_PHONE boots cleanly

- GIVEN `HUMAN_HANDOFF_ENABLED=false`
- AND `OPS_CHANNEL_PHONE` is unset or empty
- WHEN the application starts
- THEN boot MUST succeed (no validation error for `OPS_CHANNEL_PHONE`)
- AND `humanHandoff.enabled === false` MUST be observable on the typed config block
- AND `humanHandoff.opsChannelPhone === undefined` MUST be observable on the typed
  config block.

#### Scenario: HUMAN_HANDOFF_ENABLED defaults to true when absent

- GIVEN neither `HUMAN_HANDOFF_ENABLED` nor `OPS_CHANNEL_PHONE` is present in the
  environment
- WHEN the application starts
- THEN boot MUST abort with a Joi validation error (`HUMAN_HANDOFF_ENABLED` defaults
  to `true`, so `OPS_CHANNEL_PHONE` is required by the chain above).

## ADDED Requirements

### Requirement: OPS_CHANNEL_PHONE env var holds the human agent's wa_id

The Joi validation pipeline MUST accept `OPS_CHANNEL_PHONE` as a string of digits with
an optional leading `+`. The variable MUST be required (fail boot) when
`HUMAN_HANDOFF_ENABLED=true`. The variable is OPTIONAL when `HUMAN_HANDOFF_ENABLED=false`.

The runtime MUST apply `normalizeSandboxRecipient()` to the resolved value at boot, so
the dev/test sandbox trunk `1` is stripped for the Meta test number. The bot MUST use
the normalized value as the recipient for ops digests (`sendText({ to: <ops>, ... })`)
and as the comparison target for `isOpsSender(senderId)` (which compares BOTH sides
after normalization).

The typed configuration MUST surface `humanHandoff.opsChannelPhone` (string, NOT
undefined when enabled). When disabled, the field MAY be `undefined`.

#### Scenario: valid OPS_CHANNEL_PHONE with leading +

- GIVEN `OPS_CHANNEL_PHONE = "+5219999888777"`
- WHEN the application starts with `HUMAN_HANDOFF_ENABLED=true`
- THEN boot MUST succeed
- AND `humanHandoff.opsChannelPhone` MUST equal the normalized form
  (`normalizeSandboxRecipient("+5219999888777")` per the existing helper).

#### Scenario: dev-mode OPS_CHANNEL_PHONE with trunk-1 strips the trunk

- GIVEN `OPS_CHANNEL_PHONE = "15219999888777"` (the trunk-`1` form for the Meta test
  number)
- WHEN the application starts with `HUMAN_HANDOFF_ENABLED=true`
- THEN boot MUST succeed
- AND `humanHandoff.opsChannelPhone` MUST equal `normalizeSandboxRecipient(...)`
  (the trunk-`1` stripped form per the existing helper).

#### Scenario: empty OPS_CHANNEL_PHONE blocks boot when enabled

- GIVEN `OPS_CHANNEL_PHONE = ""` and `HUMAN_HANDOFF_ENABLED=true`
- WHEN the application starts
- THEN boot MUST abort with a Joi validation error mentioning `OPS_CHANNEL_PHONE`.

#### Scenario: non-string OPS_CHANNEL_PHONE blocks boot

- GIVEN `OPS_CHANNEL_PHONE = 5219999888777` (number, not string) and
  `HUMAN_HANDOFF_ENABLED=true`
- WHEN the application starts
- THEN boot MUST abort with a Joi validation error.

### Requirement: HUMAN_HANDOFF_ENABLED env var is the kill-switch

The Joi validation pipeline MUST accept `HUMAN_HANDOFF_ENABLED` as a boolean (Joi
`.boolean()`). The variable MUST default to `true` when absent (the handoff slice is
on by default).

The typed configuration MUST surface `humanHandoff.enabled` (boolean). When `false`,
the runtime MUST short-circuit `HumanHandoffService.create(...)` with
`{ ok: false, error: { kind: 'disabled', retryable: false } }` BEFORE any row write or
any outbound message. The dispatcher's ops pre-routing hook remains wired but is
inert (`resolveReply` finds no rows because no `create` ever ran).

#### Scenario: HUMAN_HANDOFF_ENABLED=true enables the slice

- GIVEN `HUMAN_HANDOFF_ENABLED=true` and a valid `OPS_CHANNEL_PHONE`
- WHEN the application handles a customer `requestHumanAssistance` invocation
- THEN `HumanHandoffService.create(...)` MUST proceed past the kill-switch
- AND `human_handoff_requests` MUST receive the new row.

#### Scenario: HUMAN_HANDOFF_ENABLED=false disables the slice at runtime

- GIVEN `HUMAN_HANDOFF_ENABLED=false`
- WHEN the application handles a customer `requestHumanAssistance` invocation
- THEN `HumanHandoffService.create(...)` MUST return
  `{ ok: false, error: { kind: 'disabled', retryable: false } }`
- AND `human_handoff_requests` MUST NOT receive a new row
- AND `WhatsappSenderPort.sendText` MUST NOT be called for the digest or the notice.

#### Scenario: HUMAN_HANDOFF_ENABLED false→true flip re-enables without code change

- GIVEN `HUMAN_HANDOFF_ENABLED=false` on a previous boot
- WHEN the operator flips `HUMAN_HANDOFF_ENABLED=true` and restarts
- THEN the next customer `requestHumanAssistance` invocation MUST proceed past the
  kill-switch (no code change required).

### Requirement: humanHandoff config block exposes enabled and opsChannelPhone

The typed configuration (`src/config/configuration.ts`) MUST expose a `humanHandoff`
config block with the shape:

```text
humanHandoff: {
  enabled: boolean;             // from HUMAN_HANDOFF_ENABLED (default true)
  opsChannelPhone: string | undefined;  // from OPS_CHANNEL_PHONE (required when enabled,
                                        // undefined when disabled); normalized via
                                        // normalizeSandboxRecipient() at boot
}
```

The block MUST be observable via the typed `ConfigService` (NestJS `@nestjs/config`).
`HumanHandoffModule` MUST read `humanHandoff.enabled` and `humanHandoff.opsChannelPhone`
from the typed config (NOT from `process.env` directly) and inject them into
`HumanHandoffService`.

#### Scenario: humanHandoff block shape on a fully-configured boot

- GIVEN `HUMAN_HANDOFF_ENABLED=true` and `OPS_CHANNEL_PHONE = "5219999888777"`
- WHEN the application resolves `configService.get('humanHandoff')`
- THEN the returned object MUST equal
  `{ enabled: true, opsChannelPhone: '5219999888777' }` (normalized).

#### Scenario: humanHandoff block shape on a disabled boot

- GIVEN `HUMAN_HANDOFF_ENABLED=false` and `OPS_CHANNEL_PHONE` unset
- WHEN the application resolves `configService.get('humanHandoff')`
- THEN the returned object MUST equal
  `{ enabled: false, opsChannelPhone: undefined }`.

#### Scenario: humanHandoff block shape on a default boot (env vars absent)

- GIVEN neither `HUMAN_HANDOFF_ENABLED` nor `OPS_CHANNEL_PHONE` is present
- WHEN the application starts
- THEN boot MUST abort (the default-`true` chain requires `OPS_CHANNEL_PHONE`)
  — this is the same path as
  `HUMAN_HANDOFF_ENABLED=true` without `OPS_CHANNEL_PHONE`.

#### Scenario: HumanHandoffService reads the config block (not process.env)

- GIVEN a unit test that spies on `configService.get('humanHandoff')`
- WHEN `HumanHandoffService.create(...)` runs
- THEN the service MUST consume the typed config block (no `process.env.OPS_CHANNEL_PHONE`
  or `process.env.HUMAN_HANDOFF_ENABLED` reads).
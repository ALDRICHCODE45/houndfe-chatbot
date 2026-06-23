# Delta for app-config

## ADDED Requirements

### Requirement: Fail fast on invalid environment

The system MUST load typed application config at boot and MUST refuse to start if required environment variables are missing or invalid.
Required values are: Meta verify token, Meta app secret, Meta access token, chatbot-api base URL, `svc_` key, and branch id.

#### Scenario: Missing env blocks boot

- GIVEN one required environment variable is absent
- WHEN the application starts
- THEN boot fails with a configuration error

#### Scenario: Invalid env blocks boot

- GIVEN the Meta access token, base URL, or service key format is invalid
- WHEN the application starts
- THEN boot fails before any webhook or API traffic is accepted

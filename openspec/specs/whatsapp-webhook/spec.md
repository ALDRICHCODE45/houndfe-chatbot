# whatsapp-webhook Spec

## Purpose

Expose the Meta WhatsApp Cloud API webhook endpoint to HoundFe's chatbot. The endpoint
MUST handle the GET verification challenge exchange and accept signed POST event payloads.
Inbound events MUST be authenticated via `X-Hub-Signature-256` HMAC-SHA256 over the raw
request body and rejected (HTTP 401) when the signature is missing or invalid. Valid events
are normalized into a domain envelope that downstream layers can consume.

## Requirements

### Requirement: Verify webhook challenge

The system MUST validate GET webhook verification using the configured verify token and return the Meta challenge only on success.

#### Scenario: Valid verify token

- GIVEN a GET request with `hub.verify_token` matching configuration
- WHEN the webhook verify endpoint is called
- THEN the system returns `hub.challenge` with HTTP 200

#### Scenario: Invalid verify token

- GIVEN a GET request with a missing or different `hub.verify_token`
- WHEN the webhook verify endpoint is called
- THEN the system returns HTTP 403

### Requirement: Accept signed inbound events

The system MUST verify `X-Hub-Signature-256` with HMAC-SHA256 over the raw request body and MUST reject missing or invalid signatures with HTTP 401.
It MUST parse valid inbound message envelopes into a normalized event for downstream dispatch.

#### Scenario: Invalid signature is rejected

- GIVEN a POST webhook payload without `X-Hub-Signature-256` or with a bad MAC
- WHEN the event is received
- THEN the system returns HTTP 401

#### Scenario: Signed inbound text reaches echo dispatch

- GIVEN a simulated signed inbound text webhook
- WHEN the POST event is processed
- THEN the normalized message envelope includes sender id and text body
- AND the application can dispatch an echoed text reply

# Delta for whatsapp-sender

## ADDED Requirements

### Requirement: Send text messages through a port

The system MUST expose a text-only sender port that sends outbound WhatsApp text messages through the Meta Cloud API.
The live HTTP call MUST be isolated behind the port so tests can mock it.

#### Scenario: Echo text is sent

- GIVEN the application asks the sender port to reply to a WhatsApp sender id
- WHEN the port is called with a text message
- THEN the system produces one outbound Meta Cloud API send request
- AND the provider response message id is returned to the caller

#### Scenario: Unsupported outbound payload is rejected

- GIVEN a caller tries to send a non-text outbound message through this slice
- WHEN the sender port is invoked
- THEN the call fails as unsupported

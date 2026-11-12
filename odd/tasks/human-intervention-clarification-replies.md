# Human intervention — clarification replies (backend unit 10)

Deliver staff replies to clarification requests (feed `request.answered` kind `CLARIFICATION`) and mirror the sent message with `staffReplyId` so the inbox shows it as written by staff.
Contract: houndfe-backend `docs/chatbot-handoff/chatbot-requests-bot-contract.md` §"Clarification replies (unit 10)" (~:520, commit eddf63d8). Branch: `feat/clarification-replies`.

## Specs

- **S1 — Owner directives (L1 of the unit 9 doc, still binding):** performance first across both servers; local/dev is disposable.
- **S2 — Delivery (backend handoff, 2026-11-12):** "You receive exactly one feed item request.answered with payload kind "CLARIFICATION" per request (fields in the doc: requestId, replyId, the staff text, etc.). Compose the customer message with tú/usted as you do for answered decisions." "ACK: all five outcomes allowed for request.answered. If the 24 h window is closed → DEFERRED_WINDOW_CLOSED; the item is served again by pending-deliveries (and recovery) for later delivery."
- **S3 — Mirror attribution (backend handoff):** "when you mirror the message you actually sent, add staffReplyId = the replyId from the feed item on that OUT TEXT message in messages:batch. The backend then stores it as author STAFF with the staff user, and takes the TEXT FROM ITS OWN RECORD … Unknown/foreign replyId → 422 REPLY_NOT_FOUND (whole batch). If the clarification had no conversationRef, the reply can be mirrored once in the chat you name."
- **S4 — Deploy order (backend handoff):** "your handler for kind CLARIFICATION + staffReplyId must ship BEFORE staff reply on dev, or the customer is never answered."
- **S5 — E2E:** create an UNKNOWN_QUESTION, backend manager replies, the bot sends + ACKs + mirrors with staffReplyId, backend checks the staff read.

## Tasks

| ID  | Specs  | Route                                                                                                                               | Commit |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T1  | S1–S3  | worker: parse `replyId`, carry it to the OUT mirror row as `staffReplyId`, send it in messages:batch, isolate `422 REPLY_NOT_FOUND` | —      |
| T2  | S4, S5 | E2E with the backend on dev                                                                                                         | —      |

## Log

- **L1 (owner, 2026-11-12):** "Como tu lo recomiendes hermano." — in reply to the recommendation to do unit 10 first (handler must ship before staff reply on dev).

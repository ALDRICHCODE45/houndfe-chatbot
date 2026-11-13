# Human intervention — follow-ups after units 11 and 14

Small open items recorded while closing the live conversation (unit 11) and scheduled conversations (unit 14) slices. Branch: `chore/human-intervention-followups`.

## Specs

- **S1 — Owner (verbatim):** "si hermano, adelante con tus siguientes recomendaciones." / "[continue]". Unit 9 directives still bind (performance first; local disposable).
- **S2 — Media inbound triggers replays:** a customer sticker, video or location reopens the WhatsApp window like text does, so it must trigger the same replays: deferred staff messages while HUMAN (unit 11 B1 path) and pending deliveries while BOT. Today these message types return before the gate (`webhook-dispatcher.service.ts` mirror-only path). No bot reply is added.
- **S3 — Tool text for customerNotified false:** the `requestHumanAssistance` tool description / sale-flow instructions only describe `customerNotified: true`; describe `false` (the notice was not sent: the conversation is attended by a person or the mode could not be read) so the model does not claim the customer was told.
- **S4 — ENDING marker (unit 11 L15 f):** when the reconcile applies a "missed ended" before the `conversation.ended` item arrives, held rows can be released before the farewell; also a customer message between the durable BOT and the farewell can get a bot reply first. Add a short per-conversation ENDING marker honoured by the replay paths (incl. the 15 s maintenance sweep) and the dispatcher until the farewell is decided or a bound expires.

## Tasks

| ID  | Specs  | Route                                     | Commit |
| --- | ------ | ----------------------------------------- | ------ |
| T1  | S2, S3 | worker: media inbound replays + tool text | —      |
| T2  | S4     | worker: ENDING marker                     | —      |

## Log

- **L1 (owner, 2026-11-13):** "[continue]" after the unit 14 close, following the recommendation to take the recorded follow-ups.

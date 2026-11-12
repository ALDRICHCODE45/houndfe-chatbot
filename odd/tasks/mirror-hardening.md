# Mirror hardening (follow-ups from units 9-10)

Close the open follow-ups recorded in odd/tasks/human-intervention-conversation-mirror.md (L3, L11). Branch: `chore/mirror-hardening`.

## Specs

- **S1 — Owner (verbatim):** "si hermano, adelante con tus siguientes recomendaciones." Performance first across both servers; local/dev disposable (unit 9 S1/S2 still bind).
- **S2 — Outbox run race:** a real two-connection PostgreSQL test proves `claimRun` / `completeMany` never let two holders own or complete the same rows, and closes the advisory race (follower predicates not re-checked after the lock wait in `CLAIM_RUN_SQL`).
- **S3 — No phone in logs:** WhatsApp message ids (`wamid.*`, base64 that can embed the wa_id) and raw Meta/backend error text must not leak the customer phone into logs (contract §common rules; unit 9 S6).

## Tasks

| ID  | Specs  | Route                                             | Commit  |
| --- | ------ | ------------------------------------------------- | ------- |
| T1  | S1, S2 | worker: PG race test + CLAIM_RUN_SQL re-check     | c7a9ca9 |
| T2  | S1, S3 | worker: audit and mask wamid / error text in logs | ba0d3e2 |

## Log

- **L1 (owner, 2026-11-12):** "si hermano, adelante con tus siguientes recomendaciones."
- **L2 (2026-11-12):** T1 c7a9ca9 — the run race was real (5 of 11 real two-connection tests failed on the old SQL); fixed by re-validating locked followers and seq-ordered locking; independent verify PASS (Risk 4). T2 ba0d3e2 — wamids embed the wa_id (decoded from the fixture shape), logs now carry wamid#<sha256 prefix>; error text sanitized. Native review review-e41c7aa9 approved + acknowledged; its advisories fixed in 3d7004b (head re-fence as defense in depth — the head race did not reproduce; raw abandon reason; describeError keeps sanitized String(value); fingerprints preserved; separated phones masked). Full suite 8525 passed; postgres store 55/55 twice.

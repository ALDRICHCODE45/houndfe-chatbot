# E2E scripts

These scripts call a running **dev** backend. They write dev data, so never point them at production.

- `contract-smoke.ts`: live contract smoke test of `ChatbotApiHttpClient`. See `docs/e2e-contract-smoke.md`.
- `human-requests-feed-e2e.ts`: spec S7 run of the human request feed (create → staff resolve/cancel → feed item → outcome ACK).

## human-requests-feed-e2e

The script uses the real `ChatbotApiHttpClient`, `HumanRequestFeedConsumer` (driven through `runOnce`, with a no-op lock instead of the Postgres advisory lock) and `HumanRequestDeliveryService`, over the in-memory feed store. The other ports are fakes:

- WhatsApp sender: records each text and returns `wamid.e2e-<uuid>`. It never sends a real message.
- Handoff mode: always BOT.
- 24 h window: always open.
- Customer style: usted.

It never touches the chatbot Postgres DB. On the backend, it creates requests and records the outcome ACKs.

Defaults: base URL `http://localhost:3003` and branch `ced6cc10-a037-4f41-92af-ee69bbb51c8b`. You can override them with `CHATBOT_API_BASE_URL` and `CHATBOT_API_BRANCH_ID`. The script reads the bearer token from `/tmp/houndfe-dev-bot-token.txt` itself and never prints it. Do not pass the token on the command line or put it in an env var.

```sh
# Create one UNKNOWN_QUESTION request, then wait up to 15 min for its feed item
pnpm e2e:human-requests

# Create only, then consume in a separate run (staff resolves or cancels in between)
pnpm e2e:human-requests --phase create --phone 5550001111
pnpm e2e:human-requests --phase consume --request <requestId> --minutes 20

# Also create a wrapped RESTOCK request (it should come back as LEGACY_PATH_DELIVERS / STALE)
pnpm e2e:human-requests --with-restock <productId>

# Resume from a known cursor instead of the current feed tail
pnpm e2e:human-requests --phase consume --after <cursor>
```

Arguments:

| Flag                           | Default          | Meaning                                                                                                      |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `--phase create\|consume\|all` | `all`            | Which phases to run                                                                                          |
| `--phone`                      | `5550001111`     | 10-digit test number. The customer is `52` + phone, and `conversationRef` is `wa:521<phone>`                 |
| `--minutes`                    | `15`             | Long-poll budget for the consume phase                                                                       |
| `--after`                      | the current tail | Start cursor. Without it, the script first reads the feed with `waitSeconds=0` until a page comes back empty |
| `--with-restock <productId>`   | off              | Also create a RESTOCK request, using the human-decisions intake body as `detail`                             |
| `--request <id>`               | none             | Repeatable. Request ids to wait for in `--phase consume`                                                     |

Output lines:

- `[create.*]`: the request id and folio.
- `[item]`: one line per feed item, with the cursor, type, requestId, decision, local state, ACK outcome and state, the ACK's HTTP status and code, and the client result.
- `[summary]`: item counts per ACK outcome, the text of every fake send, and every non-200 ACK with its code.

The run stops when every created (or `--request`) request has had an item handled. It also stops at the time limit, on Ctrl-C, after 5 consecutive page failures, or on `CURSOR_EXPIRED`. It stops on `CURSOR_EXPIRED` instead of restarting from the oldest item because a restart would ACK unrelated dev deliveries. The exit code is 1 when an ACK was not 200 or a watched request got no item.

Every item from the starting cursor on is handled and ACKed, including items for other dev requests. That is how the real consumer behaves.

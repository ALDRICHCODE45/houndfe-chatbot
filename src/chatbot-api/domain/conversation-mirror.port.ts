import type {
  MirrorMessageInput,
  MirrorMessagesResult,
  MirrorStatusInput,
  MirrorStatusesResult,
  UploadMediaInput,
  UploadMediaResult,
} from './dtos/conversation-mirror.dto';

export const CONVERSATION_MIRROR_CLIENT = Symbol('CONVERSATION_MIRROR_CLIENT');

/**
 * Conversation mirror and media (backend unit 9), a separate port so existing
 * `ChatbotApiClient` fakes stay valid. Implemented by the HTTP adapter.
 *
 * Every documented answer, including HTTP errors, 5xx, timeouts and network
 * failures, resolves as a typed result discriminated by `kind`; the methods
 * never retry (the outbox owns retries) and never put the `conversationRef`
 * or a phone in an error message or log (S6). Local contract violations
 * resolve as `VALIDATION_ERROR { local: true }` / `BATCH_TOO_LARGE
 * { local: true }` before any request is made.
 */
export interface ConversationMirrorClient {
  /** `POST /chatbot-api/conversations/:conversationRef/messages:batch`
   *  (scope `conversation:write`). 1–50 messages in outbox `seq` order,
   *  all-or-nothing, idempotent by `waMessageId`: `ok` (accepted and
   *  duplicates alike) means ACK the rows. */
  mirrorMessages(
    conversationRef: string,
    messages: readonly MirrorMessageInput[],
  ): Promise<MirrorMessagesResult>;
  /** `POST /chatbot-api/messages/statuses:batch` (scope
   *  `conversation:write`), 1–100 statuses. */
  recordMessageStatuses(
    statuses: readonly MirrorStatusInput[],
  ): Promise<MirrorStatusesResult>;
  /** `POST /chatbot-api/media` (scope `media:write`): one streamed multipart
   *  `file` ≤ 10 MiB with `X-Idempotency-Key`. */
  uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult>;
}

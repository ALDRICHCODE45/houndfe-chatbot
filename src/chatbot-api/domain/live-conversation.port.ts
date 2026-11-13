import type {
  DownloadStaffMediaOptions,
  DownloadStaffMediaResult,
  GetConversationStateResult,
  ListHumanConversationsOptions,
  ListHumanConversationsResult,
  SessionAckInput,
  SessionAckResult,
} from './dtos/live-conversation.dto';

export const LIVE_CONVERSATION_CLIENT = Symbol('LIVE_CONVERSATION_CLIENT');

/**
 * Live conversation (backend unit 11), a separate port so existing client
 * fakes stay valid. Implemented by the HTTP adapter.
 *
 * Every documented answer, including HTTP errors, 5xx, timeouts and network
 * failures, resolves as a typed result discriminated by `kind`; the methods
 * never throw, never retry (the caller decides: a 409 is a reconcile signal)
 * and never put the `conversationRef` or a phone in a result or a log (S7).
 * Local contract violations resolve as `VALIDATION_ERROR { local: true }`
 * before any request is made.
 */
export interface LiveConversationClient {
  /** `POST /chatbot-api/conversations/:conversationRef/session-ack`
   *  (scope `conversation:write`, `control` bucket). Short timeout (10 s):
   *  it sits on the greeting path. */
  sessionAck(
    conversationRef: string,
    input: SessionAckInput,
  ): Promise<SessionAckResult>;
  /** `GET /chatbot-api/conversations/:conversationRef/state` (scope
   *  `requests:read`). A 404 reads as `{mode: 'BOT', handoffEpoch: 0, …}`. */
  getConversationState(
    conversationRef: string,
  ): Promise<GetConversationStateResult>;
  /** `GET /chatbot-api/conversations/state?mode=HUMAN` (scope
   *  `requests:read`): the bulk reconciliation read, one page per call. */
  listHumanConversations(
    options?: ListHumanConversationsOptions,
  ): Promise<ListHumanConversationsResult>;
  /** `GET /chatbot-api/media/:id` (scope `media:read`): streams a staff
   *  photo/PDF into a mode-0600 temp file, capped while streaming. */
  downloadStaffMedia(
    mediaId: string,
    options?: DownloadStaffMediaOptions,
  ): Promise<DownloadStaffMediaResult>;
}
